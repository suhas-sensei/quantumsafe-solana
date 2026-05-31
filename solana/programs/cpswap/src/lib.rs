//! cpswap — a real constant-product AMM (`x * y = k`) with a 0.30% fee.
//!
//! This is a genuine on-chain DEX (same mechanism as Uniswap v2 / Raydium
//! constant-product pools): real SPL token vaults, real swap math, real
//! slippage. It exists so the PORST-authorized swap in `porst_agent` can be
//! executed and tested end-to-end on a local validator. On testnet/mainnet the
//! same CPI shape targets Jupiter instead; nothing here is stubbed.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("GmzycsCEgFnb64on11vZFrkfxLDP5RqyK75GHnovN3VQ");

/// Swap fee in basis points (0.30%).
const FEE_BPS: u128 = 30;

#[program]
pub mod cpswap {
    use super::*;

    /// Create a pool for the (mint_a, mint_b) pair with two program-owned vaults.
    pub fn init_pool(ctx: Context<InitPool>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        pool.mint_a = ctx.accounts.mint_a.key();
        pool.mint_b = ctx.accounts.mint_b.key();
        pool.bump = ctx.bumps.pool;
        Ok(())
    }

    /// Deposit liquidity into both vaults (no LP token accounting — this is a
    /// price source for swaps, not a yield product).
    pub fn add_liquidity(ctx: Context<AddLiquidity>, amount_a: u64, amount_b: u64) -> Result<()> {
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.depositor_a.to_account_info(),
                    to: ctx.accounts.vault_a.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            amount_a,
        )?;
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.depositor_b.to_account_info(),
                    to: ctx.accounts.vault_b.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            amount_b,
        )?;
        Ok(())
    }

    /// Swap `amount_in` of the input token for at least `min_out` of the output
    /// token. `a_to_b = true` swaps mint_a -> mint_b, else mint_b -> mint_a.
    ///
    /// `user_authority` is a signer — when invoked via CPI from `porst_agent`,
    /// that signer is the agent vault PDA (via `invoke_signed`), so only a
    /// PORST-authorized call can move the agent's funds through this pool.
    pub fn swap(ctx: Context<Swap>, amount_in: u64, min_out: u64, a_to_b: bool) -> Result<()> {
        let (reserve_in, reserve_out) = if a_to_b {
            (ctx.accounts.vault_a.amount, ctx.accounts.vault_b.amount)
        } else {
            (ctx.accounts.vault_b.amount, ctx.accounts.vault_a.amount)
        };
        require!(reserve_in > 0 && reserve_out > 0, CpError::EmptyPool);
        require!(amount_in > 0, CpError::ZeroAmount);

        // Constant product with fee: out = reserve_out * in_after_fee /
        //                                   (reserve_in + in_after_fee)
        let amount_in_after_fee = (amount_in as u128)
            .checked_mul(10_000 - FEE_BPS)
            .unwrap()
            / 10_000;
        let numerator = (reserve_out as u128).checked_mul(amount_in_after_fee).unwrap();
        let denominator = (reserve_in as u128).checked_add(amount_in_after_fee).unwrap();
        let amount_out = (numerator / denominator) as u64;

        require!(amount_out >= min_out, CpError::SlippageExceeded);
        require!(amount_out > 0 && amount_out < reserve_out, CpError::SlippageExceeded);

        // Pull input from the caller into the input vault.
        let (in_vault, out_vault, user_in, user_out) = if a_to_b {
            (
                ctx.accounts.vault_a.to_account_info(),
                ctx.accounts.vault_b.to_account_info(),
                ctx.accounts.user_in.to_account_info(),
                ctx.accounts.user_out.to_account_info(),
            )
        } else {
            (
                ctx.accounts.vault_b.to_account_info(),
                ctx.accounts.vault_a.to_account_info(),
                ctx.accounts.user_in.to_account_info(),
                ctx.accounts.user_out.to_account_info(),
            )
        };

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: user_in,
                    to: in_vault,
                    authority: ctx.accounts.user_authority.to_account_info(),
                },
            ),
            amount_in,
        )?;

        // Send output from the output vault, signed by the pool PDA.
        let mint_a = ctx.accounts.pool.mint_a;
        let mint_b = ctx.accounts.pool.mint_b;
        let bump = ctx.accounts.pool.bump;
        let seeds: &[&[u8]] = &[b"pool", mint_a.as_ref(), mint_b.as_ref(), &[bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: out_vault,
                    to: user_out,
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[seeds],
            ),
            amount_out,
        )?;

        emit!(Swapped { amount_in, amount_out, a_to_b });
        Ok(())
    }
}

#[account]
pub struct Pool {
    pub mint_a: Pubkey,
    pub mint_b: Pubkey,
    pub bump: u8,
}

impl Pool {
    pub const SPACE: usize = 8 + 32 + 32 + 1;
}

#[derive(Accounts)]
pub struct InitPool<'info> {
    #[account(
        init,
        payer = payer,
        space = Pool::SPACE,
        seeds = [b"pool", mint_a.key().as_ref(), mint_b.key().as_ref()],
        bump
    )]
    pub pool: Account<'info, Pool>,
    pub mint_a: Account<'info, Mint>,
    pub mint_b: Account<'info, Mint>,
    #[account(
        init,
        payer = payer,
        seeds = [b"vault_a", pool.key().as_ref()],
        bump,
        token::mint = mint_a,
        token::authority = pool,
    )]
    pub vault_a: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = payer,
        seeds = [b"vault_b", pool.key().as_ref()],
        bump,
        token::mint = mint_b,
        token::authority = pool,
    )]
    pub vault_b: Account<'info, TokenAccount>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AddLiquidity<'info> {
    #[account(
        seeds = [b"pool", pool.mint_a.as_ref(), pool.mint_b.as_ref()],
        bump = pool.bump
    )]
    pub pool: Account<'info, Pool>,
    #[account(mut, seeds = [b"vault_a", pool.key().as_ref()], bump)]
    pub vault_a: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault_b", pool.key().as_ref()], bump)]
    pub vault_b: Account<'info, TokenAccount>,
    #[account(mut)]
    pub depositor_a: Account<'info, TokenAccount>,
    #[account(mut)]
    pub depositor_b: Account<'info, TokenAccount>,
    pub depositor: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(
        seeds = [b"pool", pool.mint_a.as_ref(), pool.mint_b.as_ref()],
        bump = pool.bump
    )]
    pub pool: Account<'info, Pool>,
    #[account(mut, seeds = [b"vault_a", pool.key().as_ref()], bump)]
    pub vault_a: Account<'info, TokenAccount>,
    #[account(mut, seeds = [b"vault_b", pool.key().as_ref()], bump)]
    pub vault_b: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_in: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_out: Account<'info, TokenAccount>,
    pub user_authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[event]
pub struct Swapped {
    pub amount_in: u64,
    pub amount_out: u64,
    pub a_to_b: bool,
}

#[error_code]
pub enum CpError {
    #[msg("pool has no liquidity")]
    EmptyPool,
    #[msg("amount must be non-zero")]
    ZeroAmount,
    #[msg("output below min_out (slippage)")]
    SlippageExceeded,
}
