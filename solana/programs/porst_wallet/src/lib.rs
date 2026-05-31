//! PORST/XMSS post-quantum smart-contract wallet for Solana.
//!
//! The wallet's public key is an **XMSS root** over `NUM_EPOCHS` independent
//! PORST keys (see the off-chain `porst-signer` crate). A transfer is authorized
//! by a many-time signature: a PORST signature under the current epoch's key
//! plus an XMSS authentication path folding that epoch's root up to the wallet
//! public key. All verification uses the shared [`porst_core`] crate, so the
//! on-chain checks and the off-chain signer can never diverge.
//!
//! ## State (the "infrequent synchronization")
//!
//! The wallet account is the source of truth for `(epoch, used, nonce)`:
//! * `nonce` is bound into every signed digest and incremented on success →
//!   signatures are single-use (replay-proof).
//! * `used` counts signatures spent in the current epoch; at `SIGNING_CAPACITY`
//!   the wallet advances to the next epoch (PORST is only *few-time* secure per
//!   key). After all `NUM_EPOCHS` epochs are spent the wallet is exhausted.
//!
//! ## Large signatures
//!
//! A signature is ~13 KB — larger than Solana's 1232-byte transaction limit, so
//! it is staged into a program-owned buffer account via [`write_buffer`] and read
//! by [`execute_transfer`]. (Same pattern as the few-time `porst` program.)

use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
use porst_core::{transfer_digest, verify_wallet_sig, NUM_EPOCHS, SIGNING_CAPACITY};

declare_id!("EicsDafN2D55KsUhBpurEKx9cy4paidoGYBGicfdx61m");

#[program]
pub mod porst_wallet {
    use super::*;

    /// Create a wallet pinned to an XMSS-root public key. Funds are held in a
    /// vault PDA derived from the wallet; anyone may top it up with a plain
    /// transfer.
    pub fn create_wallet(ctx: Context<CreateWallet>, xmss_root: [u8; 32]) -> Result<()> {
        let w = &mut ctx.accounts.wallet;
        w.authority = ctx.accounts.authority.key();
        w.xmss_root = xmss_root;
        w.epoch = 0;
        w.used = 0;
        w.nonce = 0;
        w.bump = ctx.bumps.wallet;
        Ok(())
    }

    /// Write a chunk of a staged signature into the program-owned buffer at
    /// `offset`. The buffer is a raw account created client-side and assigned to
    /// this program; its whole data region is the signature.
    pub fn write_buffer(ctx: Context<WriteBuffer>, offset: u32, chunk: Vec<u8>) -> Result<()> {
        let info = ctx.accounts.buffer.to_account_info();
        require_keys_eq!(*info.owner, crate::ID, WalletError::BufferNotOwned);

        let mut data = info.try_borrow_mut_data()?;
        let start = offset as usize;
        let end = start
            .checked_add(chunk.len())
            .ok_or(WalletError::BufferOverflow)?;
        require!(end <= data.len(), WalletError::BufferOverflow);
        data[start..end].copy_from_slice(&chunk);
        Ok(())
    }

    /// Authorize and execute a SOL transfer of `amount` lamports from the wallet
    /// vault to `recipient`, gated on a valid many-time signature staged in the
    /// buffer. Submission is permissionless — the signature is the authorization.
    pub fn execute_transfer(ctx: Context<ExecuteTransfer>, amount: u64) -> Result<()> {
        let wallet_key = ctx.accounts.wallet.key();
        let (xmss_root, epoch, nonce) = {
            let w = &ctx.accounts.wallet;
            (w.xmss_root, w.epoch, w.nonce)
        };

        // The wallet must still have an unspent epoch.
        require!(epoch < NUM_EPOCHS, WalletError::WalletExhausted);

        // Bind the digest to this wallet, epoch, nonce, recipient, and amount.
        let recipient_key = ctx.accounts.recipient.key().to_bytes();
        let digest = transfer_digest(&xmss_root, epoch, nonce, &recipient_key, amount);

        // Verify against the staged signature buffer.
        {
            let info = ctx.accounts.buffer.to_account_info();
            require_keys_eq!(*info.owner, crate::ID, WalletError::BufferNotOwned);
            let sig = info.try_borrow_data()?;
            require!(
                verify_wallet_sig(&xmss_root, &digest, &sig, epoch),
                WalletError::InvalidSignature
            );
        }

        // Move lamports out of the vault PDA (signed by its seeds).
        let vault_bump = ctx.bumps.vault;
        let seeds: &[&[u8]] = &[b"vault", wallet_key.as_ref(), &[vault_bump]];
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.recipient.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        // Advance state: consume the nonce; consume epoch capacity; roll over.
        let w = &mut ctx.accounts.wallet;
        w.nonce = w.nonce.checked_add(1).ok_or(WalletError::Overflow)?;
        w.used = w.used.checked_add(1).ok_or(WalletError::Overflow)?;
        if w.used >= SIGNING_CAPACITY {
            w.epoch += 1;
            w.used = 0;
        }

        emit!(Executed {
            wallet: wallet_key,
            recipient: ctx.accounts.recipient.key(),
            amount,
            epoch,
            nonce,
        });
        Ok(())
    }
}

/// Wallet state account.
#[account]
pub struct Wallet {
    /// Account allowed to create the wallet (administrative; not required to
    /// authorize transfers — the signature does that).
    pub authority: Pubkey,
    /// XMSS-root public key.
    pub xmss_root: [u8; 32],
    /// Current epoch (PORST key index in use).
    pub epoch: u64,
    /// Signatures spent in the current epoch.
    pub used: u64,
    /// Monotonic counter bound into each signed digest (replay protection).
    pub nonce: u64,
    /// PDA bump for the wallet account.
    pub bump: u8,
}

impl Wallet {
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 8 + 8 + 1;
}

#[derive(Accounts)]
pub struct CreateWallet<'info> {
    #[account(
        init,
        payer = authority,
        space = Wallet::SPACE,
        seeds = [b"wallet", authority.key().as_ref()],
        bump
    )]
    pub wallet: Account<'info, Wallet>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WriteBuffer<'info> {
    /// CHECK: raw program-owned signature buffer; ownership asserted in handler.
    #[account(mut)]
    pub buffer: UncheckedAccount<'info>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ExecuteTransfer<'info> {
    #[account(
        mut,
        seeds = [b"wallet", wallet.authority.as_ref()],
        bump = wallet.bump,
    )]
    pub wallet: Account<'info, Wallet>,
    /// Vault PDA holding the wallet's SOL.
    #[account(
        mut,
        seeds = [b"vault", wallet.key().as_ref()],
        bump,
    )]
    pub vault: SystemAccount<'info>,
    /// Recipient of the transfer.
    #[account(mut)]
    pub recipient: SystemAccount<'info>,
    /// CHECK: raw program-owned signature buffer; ownership asserted in handler.
    pub buffer: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[event]
pub struct Executed {
    pub wallet: Pubkey,
    pub recipient: Pubkey,
    pub amount: u64,
    pub epoch: u64,
    pub nonce: u64,
}

#[error_code]
pub enum WalletError {
    #[msg("signature buffer is not owned by the wallet program")]
    BufferNotOwned,
    #[msg("write would overflow the signature buffer")]
    BufferOverflow,
    #[msg("invalid post-quantum signature")]
    InvalidSignature,
    #[msg("wallet has exhausted all signing epochs")]
    WalletExhausted,
    #[msg("arithmetic overflow")]
    Overflow,
}
