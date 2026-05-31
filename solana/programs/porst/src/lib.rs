//! PORST — a post-quantum few-time signature verifier for Solana.
//!
//! This is a faithful port of `PORST.sol` (an ERC-1271 verifier) to a Solana
//! program. The verification math lives in [`verify`] and is byte-for-byte
//! identical in behavior to the EVM contract (same Keccak-256, same subset
//! derivation, same frontier multiproof).
//!
//! ## Why a signature buffer account?
//!
//! On Ethereum the whole signature (~13 KB for the default parameters) arrives
//! as calldata. Solana caps a single transaction at 1232 bytes, so the signature
//! cannot be passed inline. Instead the client:
//!   1. creates a program-owned buffer account sized to the exact signature
//!      length (a top-level `SystemProgram::createAccount`, which can allocate
//!      far beyond the 10 KB CPI limit),
//!   2. fills it with [`write_buffer`] chunks across several transactions, then
//!   3. calls [`verify`], which runs the multiproof over the buffered bytes.
//!
//! The verifier's public key (the Merkle root) is pinned in a [`Verifier`]
//! account at [`initialize`] time — the analogue of the immutable `pubkey` in
//! the Solidity constructor.

use anchor_lang::prelude::*;

mod verify;
pub use verify::{verify_porst, SUBSET_SIZE, TREE_HEIGHT};

/// Reference signer + tree builder. Host-only: excluded from the on-chain build.
#[cfg(not(target_os = "solana"))]
pub mod reference;

declare_id!("A1LmjDGtTAU57hXgEcMrLKW3u4kU1aM4kSRbJ2RbawYJ");

#[program]
pub mod porst {
    use super::*;

    /// Pin a Merkle-root public key into a fresh [`Verifier`] account.
    pub fn initialize(ctx: Context<Initialize>, pubkey: [u8; 32]) -> Result<()> {
        let v = &mut ctx.accounts.verifier;
        v.authority = ctx.accounts.authority.key();
        v.pubkey = pubkey;
        Ok(())
    }

    /// Write `chunk` into the program-owned signature buffer at `offset`.
    ///
    /// The buffer is a raw account created client-side with
    /// `SystemProgram::createAccount` and assigned to this program; its entire
    /// data region is the signature. Several `write_buffer` calls assemble a
    /// signature too large to fit in one transaction.
    pub fn write_buffer(ctx: Context<WriteBuffer>, offset: u32, chunk: Vec<u8>) -> Result<()> {
        let info = ctx.accounts.buffer.to_account_info();
        require_keys_eq!(*info.owner, crate::ID, PorstError::BufferNotOwned);

        let mut data = info.try_borrow_mut_data()?;
        let start = offset as usize;
        let end = start
            .checked_add(chunk.len())
            .ok_or(PorstError::BufferOverflow)?;
        require!(end <= data.len(), PorstError::BufferOverflow);
        data[start..end].copy_from_slice(&chunk);
        Ok(())
    }

    /// Verify the buffered PORST signature over `hash` against the pinned root.
    ///
    /// Succeeds (returns `Ok`) iff the signature is valid; otherwise returns
    /// [`PorstError::InvalidSignature`]. The entire buffer account is treated as
    /// the signature, so its length must equal the signature length exactly —
    /// the same exact-length requirement the Solidity contract enforces.
    pub fn verify(ctx: Context<Verify>, hash: [u8; 32]) -> Result<()> {
        let pubkey = ctx.accounts.verifier.pubkey;
        let info = ctx.accounts.buffer.to_account_info();
        require_keys_eq!(*info.owner, crate::ID, PorstError::BufferNotOwned);

        let data = info.try_borrow_data()?;
        let ok = verify_porst(&pubkey, &hash, &data);
        require!(ok, PorstError::InvalidSignature);

        emit!(Verified {
            verifier: ctx.accounts.verifier.key(),
            hash,
        });
        Ok(())
    }
}

/// Pinned public key for a PORST verifier — the Merkle root over the leaf hashes.
#[account]
pub struct Verifier {
    /// Account that created this verifier.
    pub authority: Pubkey,
    /// The Merkle-root public key (32 bytes), immutable after `initialize`.
    pub pubkey: [u8; 32],
}

impl Verifier {
    /// 8-byte discriminator + authority + pubkey.
    pub const SPACE: usize = 8 + 32 + 32;
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = Verifier::SPACE)]
    pub verifier: Account<'info, Verifier>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WriteBuffer<'info> {
    /// Raw, program-owned signature buffer. Unchecked because it carries no
    /// Anchor discriminator — it is plain signature bytes. Ownership is verified
    /// in the handler.
    /// CHECK: ownership (`owner == crate::ID`) is asserted in the instruction.
    #[account(mut)]
    pub buffer: UncheckedAccount<'info>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Verify<'info> {
    pub verifier: Account<'info, Verifier>,
    /// CHECK: ownership (`owner == crate::ID`) is asserted in the instruction.
    pub buffer: UncheckedAccount<'info>,
}

#[event]
pub struct Verified {
    pub verifier: Pubkey,
    pub hash: [u8; 32],
}

#[error_code]
pub enum PorstError {
    #[msg("signature buffer is not owned by the PORST program")]
    BufferNotOwned,
    #[msg("write would overflow the signature buffer")]
    BufferOverflow,
    #[msg("invalid PORST signature")]
    InvalidSignature,
}
