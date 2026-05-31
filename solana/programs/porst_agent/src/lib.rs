//! porst_agent — post-quantum authorization for autonomous Solana agents.
//!
//! The motivating idea (timely even before quantum computers arrive): an AI
//! agent may *propose* actions, but it can never move funds on its own. A swap
//! executes only when accompanied by a **PORST (post-quantum) signature** over
//! the exact intent — produced by an isolated signer that the model never
//! touches. This program is the on-chain half of that boundary.
//!
//! `execute_swap`:
//!   1. recomputes the swap digest from on-chain state + instruction args
//!      (the agent cannot substitute any field after signing),
//!   2. checks the intent has not expired and the wallet epoch is live,
//!   3. verifies the staged PORST/XMSS signature against the wallet pubkey,
//!   4. binds the route (`route_hash` of the DEX program + pool),
//!   5. CPIs into the real `cpswap` AMM, signed by the agent PDA,
//!   6. enforces `received >= min_out` on-chain (slippage), and
//!   7. advances `(epoch, used, nonce)` — replay protection + few-time capacity.
//!
//! Locally the route is the `cpswap` AMM; on testnet/mainnet the same shape
//! targets Jupiter. The ~13 KB PORST signature is staged into a program-owned
//! buffer (Solana's 1232-byte tx limit) via `write_buffer`.

use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use cpswap::program::Cpswap;
use cpswap::{self, Pool};
use porst_core::{route_hash, swap_digest, verify_wallet_sig, NUM_EPOCHS, SIGNING_CAPACITY};

declare_id!("9d8XF5qybxi9JNED5LpJJ5fYv4JfSZCXUBsLnX8FG3ui");

#[program]
pub mod porst_agent {
    use super::*;

    /// Create an agent wallet pinned to an XMSS-root public key.
    pub fn create_agent(ctx: Context<CreateAgent>, xmss_root: [u8; 32]) -> Result<()> {
        let a = &mut ctx.accounts.agent;
        a.authority = ctx.accounts.authority.key();
        a.xmss_root = xmss_root;
        a.epoch = 0;
        a.used = 0;
        a.nonce = 0;
        a.bump = ctx.bumps.agent;
        Ok(())
    }

    /// Stage a chunk of a PORST signature into the program-owned buffer.
    pub fn write_buffer(ctx: Context<WriteBuffer>, offset: u32, chunk: Vec<u8>) -> Result<()> {
        let info = ctx.accounts.buffer.to_account_info();
        require_keys_eq!(*info.owner, crate::ID, AgentError::BufferNotOwned);
        let mut data = info.try_borrow_mut_data()?;
        let start = offset as usize;
        let end = start
            .checked_add(chunk.len())
            .ok_or(AgentError::BufferOverflow)?;
        require!(end <= data.len(), AgentError::BufferOverflow);
        data[start..end].copy_from_slice(&chunk);
        Ok(())
    }

    /// Execute a PORST-authorized swap of `amount_in` for at least `min_out`,
    /// valid until `expiry` (unix seconds). The direction is inferred from the
    /// input/output mints against the pool.
    pub fn execute_swap(
        ctx: Context<ExecuteSwap>,
        amount_in: u64,
        min_out: u64,
        expiry: i64,
    ) -> Result<()> {
        // 1. Not expired.
        let now = Clock::get()?.unix_timestamp;
        require!(now <= expiry, AgentError::IntentExpired);

        let agent_key = ctx.accounts.agent.key();
        let (xmss_root, epoch, nonce, bump) = {
            let a = &ctx.accounts.agent;
            (a.xmss_root, a.epoch, a.nonce, a.bump)
        };
        require!(epoch < NUM_EPOCHS, AgentError::WalletExhausted);

        // 2. Determine swap direction from the mints vs. the pool.
        let input_mint = ctx.accounts.input_mint.key();
        let output_mint = ctx.accounts.output_mint.key();
        let pool = &ctx.accounts.pool;
        let a_to_b = if input_mint == pool.mint_a && output_mint == pool.mint_b {
            true
        } else if input_mint == pool.mint_b && output_mint == pool.mint_a {
            false
        } else {
            return err!(AgentError::RouteMismatch);
        };

        // 3. Recompute the route binding and the swap digest from chain state.
        let rh = route_hash(
            &ctx.accounts.cpswap_program.key().to_bytes(),
            &pool.key().to_bytes(),
        );
        let digest = swap_digest(
            &xmss_root,
            epoch,
            nonce,
            &input_mint.to_bytes(),
            &output_mint.to_bytes(),
            amount_in,
            min_out,
            &rh,
            expiry,
        );

        // 4. Verify the staged post-quantum signature.
        {
            let info = ctx.accounts.buffer.to_account_info();
            require_keys_eq!(*info.owner, crate::ID, AgentError::BufferNotOwned);
            let sig = info.try_borrow_data()?;
            require!(
                verify_wallet_sig(&xmss_root, &digest, &sig, epoch),
                AgentError::InvalidSignature
            );
        }

        // 5. CPI into the real AMM, signed by the agent PDA. Record the output
        //    balance first so we can enforce slippage independently of the DEX.
        ctx.accounts.agent_out.reload()?;
        let out_before = ctx.accounts.agent_out.amount;

        let seeds: &[&[u8]] = &[b"agent", ctx.accounts.authority.key.as_ref(), &[bump]];
        cpswap::cpi::swap(
            CpiContext::new_with_signer(
                ctx.accounts.cpswap_program.to_account_info(),
                cpswap::cpi::accounts::Swap {
                    pool: ctx.accounts.pool.to_account_info(),
                    vault_a: ctx.accounts.vault_a.to_account_info(),
                    vault_b: ctx.accounts.vault_b.to_account_info(),
                    user_in: ctx.accounts.agent_in.to_account_info(),
                    user_out: ctx.accounts.agent_out.to_account_info(),
                    user_authority: ctx.accounts.agent.to_account_info(),
                    token_program: ctx.accounts.token_program.to_account_info(),
                },
                &[seeds],
            ),
            amount_in,
            min_out,
            a_to_b,
        )?;

        // 6. Independent on-chain slippage guard (defense in depth).
        ctx.accounts.agent_out.reload()?;
        let received = ctx.accounts.agent_out.amount.saturating_sub(out_before);
        require!(received >= min_out, AgentError::SlippageExceeded);

        // 7. Advance state: replay protection + few-time capacity.
        let a = &mut ctx.accounts.agent;
        a.nonce = a.nonce.checked_add(1).ok_or(AgentError::Overflow)?;
        a.used = a.used.checked_add(1).ok_or(AgentError::Overflow)?;
        if a.used >= SIGNING_CAPACITY {
            a.epoch += 1;
            a.used = 0;
        }

        emit!(SwapExecuted {
            agent: agent_key,
            input_mint,
            output_mint,
            amount_in,
            received,
            epoch,
            nonce,
        });
        Ok(())
    }
}

#[account]
pub struct Agent {
    pub authority: Pubkey,
    pub xmss_root: [u8; 32],
    pub epoch: u64,
    pub used: u64,
    pub nonce: u64,
    pub bump: u8,
}

impl Agent {
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 8 + 8 + 1;
}

#[derive(Accounts)]
pub struct CreateAgent<'info> {
    #[account(
        init,
        payer = authority,
        space = Agent::SPACE,
        seeds = [b"agent", authority.key().as_ref()],
        bump
    )]
    pub agent: Account<'info, Agent>,
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
pub struct ExecuteSwap<'info> {
    #[account(
        mut,
        seeds = [b"agent", agent.authority.as_ref()],
        bump = agent.bump,
    )]
    pub agent: Account<'info, Agent>,
    /// CHECK: the agent's on-chain authority pubkey, used only as a PDA seed.
    pub authority: UncheckedAccount<'info>,
    /// CHECK: raw program-owned signature buffer; ownership asserted in handler.
    pub buffer: UncheckedAccount<'info>,

    // --- swap intent binding ---
    pub input_mint: Account<'info, Mint>,
    pub output_mint: Account<'info, Mint>,

    // --- the agent's token accounts (owned by the agent PDA) ---
    #[account(mut, token::mint = input_mint, token::authority = agent)]
    pub agent_in: Account<'info, TokenAccount>,
    #[account(mut, token::mint = output_mint, token::authority = agent)]
    pub agent_out: Account<'info, TokenAccount>,

    // --- the cpswap pool being routed through ---
    #[account(mut)]
    pub pool: Account<'info, Pool>,
    #[account(mut)]
    pub vault_a: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault_b: Account<'info, TokenAccount>,

    pub cpswap_program: Program<'info, Cpswap>,
    pub token_program: Program<'info, Token>,
}

#[event]
pub struct SwapExecuted {
    pub agent: Pubkey,
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub amount_in: u64,
    pub received: u64,
    pub epoch: u64,
    pub nonce: u64,
}

#[error_code]
pub enum AgentError {
    #[msg("signature buffer is not owned by the agent program")]
    BufferNotOwned,
    #[msg("write would overflow the signature buffer")]
    BufferOverflow,
    #[msg("invalid post-quantum signature")]
    InvalidSignature,
    #[msg("intent has expired")]
    IntentExpired,
    #[msg("input/output mints do not match the pool")]
    RouteMismatch,
    #[msg("output below min_out (slippage)")]
    SlippageExceeded,
    #[msg("agent wallet has exhausted all signing epochs")]
    WalletExhausted,
    #[msg("arithmetic overflow")]
    Overflow,
}
