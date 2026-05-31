//! porst_perp — post-quantum authorization for a Solana perpetual-futures engine.
//!
//! Same boundary as `porst_agent`, applied to leveraged derivatives: an AI agent
//! may *propose* a position, but it can never open or close one on its own. A
//! position changes only when accompanied by a **PORST (post-quantum) signature**
//! over the exact intent — produced by an isolated signer the model never
//! touches. This program is the on-chain half of that boundary.
//!
//! Design (a deliberately *basic but real* perp):
//!   * One SOL-PERP market, margined and settled in USDT against a pooled LP
//!     vault that is the counterparty (GMX-style pool-backed model).
//!   * Mark price comes from an on-chain `OracleState` posted by a keeper from a
//!     real price feed (Pyth Hermes). The read sits behind one account so a
//!     native Pyth-receiver CPI is a localized swap later.
//!   * `open_position` / `close_position` each require a fresh PORST signature
//!     over the intent (replay-protected by `(epoch, used, nonce)`), exactly like
//!     `execute_swap`.
//!   * `liquidate` (protocol-enforced when margin is thin) and `trigger`
//!     (stop-loss / take-profit, pre-authorized by the signed SL/TP levels at
//!     open) are permissionless and consume no signature.
//!
//! Prices are fixed-point USDT-per-SOL × 1e6. Amounts are USDT base units (6dp).
//! All settlement math is integer-only and lives in the pure [`math`] module so
//! it can be unit-tested off-chain.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
use porst_core::{close_perp_digest, open_perp_digest, verify_wallet_sig, NUM_EPOCHS, SIGNING_CAPACITY};

declare_id!("C6eDbYMs8q31TnnLbshbxecXc8CGRCdwHCS2ByEMafpU");

/// Reject an oracle price older than this many seconds (mark-price freshness).
pub const MAX_ORACLE_STALENESS: i64 = 120;
/// Long / short encoding (matches the signed digest).
pub const SIDE_LONG: u8 = 0;
pub const SIDE_SHORT: u8 = 1;

// ---------------------------------------------------------------------------
// Pure settlement math — integer-only, no Solana runtime. Unit-tested below.
// ---------------------------------------------------------------------------
pub mod math {
    /// Notional (USDT base units) = collateral × leverage.
    pub fn notional(collateral: u64, leverage: u64) -> Option<u64> {
        u64::try_from((collateral as u128).checked_mul(leverage as u128)?).ok()
    }

    /// Signed PnL in USDT base units: `notional × (exit − entry) / entry`,
    /// negated for a short. `entry` must be non-zero (enforced at open).
    pub fn pnl(side: u8, notional: u64, entry: u64, exit: u64) -> i128 {
        let n = notional as i128;
        let diff = exit as i128 - entry as i128;
        let raw = n.saturating_mul(diff) / (entry as i128);
        if side == super::SIDE_LONG {
            raw
        } else {
            -raw
        }
    }

    /// One-time open fee on notional.
    pub fn open_fee(notional: u64, open_fee_bps: u16) -> u128 {
        (notional as u128) * (open_fee_bps as u128) / 10_000
    }

    /// Time-decayed borrow / funding fee on notional (cost of carry).
    pub fn borrow_fee(notional: u64, bps_per_hour: u16, elapsed_secs: i64) -> u128 {
        let e = if elapsed_secs < 0 { 0 } else { elapsed_secs as u128 };
        (notional as u128) * (bps_per_hour as u128) * e / (10_000 * 3_600)
    }

    /// Maintenance-margin requirement: liquidation triggers at/below this equity.
    pub fn maintenance(notional: u64, bps: u16) -> u128 {
        (notional as u128) * (bps as u128) / 10_000
    }

    /// Equity = collateral + pnl − fees (signed).
    pub fn equity(collateral: u64, pnl: i128, fees: u128) -> i128 {
        (collateral as i128) + pnl - (fees as i128)
    }

    pub struct Settlement {
        pub payout: u64,
        pub pnl: i128,
        pub fees: u128,
        pub equity: i128,
    }

    /// Full settlement at `exit` price. Payout is clamped to `[0, vault_balance]`.
    #[allow(clippy::too_many_arguments)]
    pub fn settle(
        side: u8,
        collateral: u64,
        notional: u64,
        entry: u64,
        exit: u64,
        open_fee_bps: u16,
        borrow_bps_hr: u16,
        elapsed_secs: i64,
        vault_balance: u64,
    ) -> Settlement {
        let p = pnl(side, notional, entry, exit);
        let fees = open_fee(notional, open_fee_bps) + borrow_fee(notional, borrow_bps_hr, elapsed_secs);
        let eq = equity(collateral, p, fees);
        let payout = if eq <= 0 {
            0
        } else {
            core::cmp::min(eq as u128, vault_balance as u128) as u64
        };
        Settlement { payout, pnl: p, fees, equity: eq }
    }

    /// True when the position is at or below its maintenance margin.
    pub fn is_liquidatable(equity: i128, maintenance: u128) -> bool {
        equity <= maintenance as i128
    }
}

#[program]
pub mod porst_perp {
    use super::*;

    /// Create the price oracle account; `authority` (the keeper) may post prices.
    pub fn init_oracle(ctx: Context<InitOracle>) -> Result<()> {
        let o = &mut ctx.accounts.oracle;
        o.authority = ctx.accounts.authority.key();
        o.price = 0;
        o.publish_time = 0;
        o.bump = ctx.bumps.oracle;
        Ok(())
    }

    /// Post a fresh mark price (USDT-per-SOL × 1e6) with its source publish time.
    pub fn update_oracle(ctx: Context<UpdateOracle>, price: u64, publish_time: i64) -> Result<()> {
        require!(price > 0, PerpError::BadPrice);
        let o = &mut ctx.accounts.oracle;
        o.price = price;
        o.publish_time = publish_time;
        Ok(())
    }

    /// Create the SOL-PERP market and its USDT vault (LP + locked collateral).
    pub fn init_market(
        ctx: Context<InitMarket>,
        maintenance_bps: u16,
        max_leverage: u16,
        open_fee_bps: u16,
        borrow_fee_bps_per_hour: u16,
    ) -> Result<()> {
        require!(max_leverage >= 1, PerpError::BadParam);
        require!(maintenance_bps > 0 && maintenance_bps < 10_000, PerpError::BadParam);
        let m = &mut ctx.accounts.market;
        m.authority = ctx.accounts.authority.key();
        m.oracle = ctx.accounts.oracle.key();
        m.collateral_mint = ctx.accounts.collateral_mint.key();
        m.vault = ctx.accounts.vault.key();
        m.maintenance_bps = maintenance_bps;
        m.max_leverage = max_leverage;
        m.open_fee_bps = open_fee_bps;
        m.borrow_fee_bps_per_hour = borrow_fee_bps_per_hour;
        m.total_long_notional = 0;
        m.total_short_notional = 0;
        m.open_positions = 0;
        m.bump = ctx.bumps.market;
        m.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    /// Create a perp trader wallet pinned to its own XMSS-root public key. The
    /// perp uses a *separate* PQ wallet from the swap agent so the few-time
    /// signing budget (16/epoch) cannot be exceeded by sharing one key.
    pub fn create_trader(ctx: Context<CreateTrader>, xmss_root: [u8; 32]) -> Result<()> {
        let t = &mut ctx.accounts.trader;
        t.authority = ctx.accounts.authority.key();
        t.xmss_root = xmss_root;
        t.epoch = 0;
        t.used = 0;
        t.nonce = 0;
        t.position_count = 0;
        t.bump = ctx.bumps.trader;
        Ok(())
    }

    /// Stage a chunk of a PORST signature into the program-owned buffer.
    pub fn write_buffer(ctx: Context<WriteBuffer>, offset: u32, chunk: Vec<u8>) -> Result<()> {
        let info = ctx.accounts.buffer.to_account_info();
        require_keys_eq!(*info.owner, crate::ID, PerpError::BufferNotOwned);
        let mut data = info.try_borrow_mut_data()?;
        let start = offset as usize;
        let end = start.checked_add(chunk.len()).ok_or(PerpError::BufferOverflow)?;
        require!(end <= data.len(), PerpError::BufferOverflow);
        data[start..end].copy_from_slice(&chunk);
        Ok(())
    }

    /// Open a PORST-authorized leveraged position.
    #[allow(clippy::too_many_arguments)]
    pub fn open_position(
        ctx: Context<OpenPosition>,
        side: u8,
        collateral: u64,
        leverage: u64,
        max_entry_price: u64,
        sl_price: u64,
        tp_price: u64,
        expiry: i64,
    ) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(now <= expiry, PerpError::IntentExpired);
        require!(side == SIDE_LONG || side == SIDE_SHORT, PerpError::BadParam);
        require!(collateral > 0, PerpError::BadParam);

        let market = &ctx.accounts.market;
        require!(
            leverage >= 1 && leverage <= market.max_leverage as u64,
            PerpError::LeverageTooHigh
        );

        let (xmss_root, epoch, nonce, trader_bump, seq) = {
            let t = &ctx.accounts.trader;
            (t.xmss_root, t.epoch, t.nonce, t.bump, t.position_count)
        };
        require!(epoch < NUM_EPOCHS, PerpError::WalletExhausted);

        // Fresh mark price.
        let oracle = &ctx.accounts.oracle;
        require!(oracle.price > 0, PerpError::BadPrice);
        require!(now - oracle.publish_time <= MAX_ORACLE_STALENESS, PerpError::StaleOracle);
        let entry = oracle.price;

        // Entry slippage guard: long must fill at/below the limit, short at/above.
        if side == SIDE_LONG {
            require!(entry <= max_entry_price, PerpError::EntrySlippage);
        } else {
            require!(entry >= max_entry_price, PerpError::EntrySlippage);
        }

        // Recompute and verify the signed open digest from chain state + args.
        let digest = open_perp_digest(
            &xmss_root,
            epoch,
            nonce,
            &market.key().to_bytes(),
            side,
            collateral,
            leverage,
            max_entry_price,
            sl_price,
            tp_price,
            expiry,
        );
        {
            let info = ctx.accounts.buffer.to_account_info();
            require_keys_eq!(*info.owner, crate::ID, PerpError::BufferNotOwned);
            let sig = info.try_borrow_data()?;
            require!(
                verify_wallet_sig(&xmss_root, &digest, &sig, epoch),
                PerpError::InvalidSignature
            );
        }

        let notional = math::notional(collateral, leverage).ok_or(PerpError::Overflow)?;

        // Lock collateral: trader vault PDA -> market vault, signed by the trader PDA.
        let auth_key = ctx.accounts.authority.key();
        let trader_seeds: &[&[u8]] = &[b"trader", auth_key.as_ref(), &[trader_bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.trader_usdt.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.trader.to_account_info(),
                },
                &[trader_seeds],
            ),
            collateral,
        )?;

        // Record the position.
        let pos = &mut ctx.accounts.position;
        pos.trader = ctx.accounts.trader.key();
        pos.market = market.key();
        pos.side = side;
        pos.collateral = collateral;
        pos.notional = notional;
        pos.entry_price = entry;
        pos.leverage = leverage as u16;
        pos.sl_price = sl_price;
        pos.tp_price = tp_price;
        pos.open_time = now;
        pos.seq = seq;
        pos.bump = ctx.bumps.position;

        // Update market open interest.
        let m = &mut ctx.accounts.market;
        if side == SIDE_LONG {
            m.total_long_notional = m.total_long_notional.checked_add(notional).ok_or(PerpError::Overflow)?;
        } else {
            m.total_short_notional = m.total_short_notional.checked_add(notional).ok_or(PerpError::Overflow)?;
        }
        m.open_positions = m.open_positions.checked_add(1).ok_or(PerpError::Overflow)?;

        // Advance signing state: replay protection + few-time capacity.
        let t = &mut ctx.accounts.trader;
        t.position_count = t.position_count.checked_add(1).ok_or(PerpError::Overflow)?;
        t.nonce = t.nonce.checked_add(1).ok_or(PerpError::Overflow)?;
        t.used = t.used.checked_add(1).ok_or(PerpError::Overflow)?;
        if t.used >= SIGNING_CAPACITY {
            t.epoch += 1;
            t.used = 0;
        }

        emit!(PositionOpened {
            position: pos.key(),
            trader: pos.trader,
            side,
            collateral,
            notional,
            entry_price: entry,
            leverage: leverage as u16,
            sl_price,
            tp_price,
        });
        Ok(())
    }

    /// Close a PORST-authorized position at the live mark price.
    pub fn close_position(ctx: Context<ClosePosition>, expiry: i64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(now <= expiry, PerpError::IntentExpired);

        let (xmss_root, epoch, nonce) = {
            let t = &ctx.accounts.trader;
            (t.xmss_root, t.epoch, t.nonce)
        };
        require!(epoch < NUM_EPOCHS, PerpError::WalletExhausted);

        // Verify the signed close digest (binds the exact position + expiry).
        let digest = close_perp_digest(&xmss_root, epoch, nonce, &ctx.accounts.position.key().to_bytes(), expiry);
        {
            let info = ctx.accounts.buffer.to_account_info();
            require_keys_eq!(*info.owner, crate::ID, PerpError::BufferNotOwned);
            let sig = info.try_borrow_data()?;
            require!(
                verify_wallet_sig(&xmss_root, &digest, &sig, epoch),
                PerpError::InvalidSignature
            );
        }

        settle_and_close(
            &mut ctx.accounts.market,
            &ctx.accounts.oracle,
            &ctx.accounts.position,
            &ctx.accounts.vault,
            &ctx.accounts.trader_usdt,
            &ctx.accounts.token_program,
            now,
            CloseKind::User,
        )?;

        // Advance signing state (a close consumes a signature).
        let t = &mut ctx.accounts.trader;
        t.nonce = t.nonce.checked_add(1).ok_or(PerpError::Overflow)?;
        t.used = t.used.checked_add(1).ok_or(PerpError::Overflow)?;
        if t.used >= SIGNING_CAPACITY {
            t.epoch += 1;
            t.used = 0;
        }
        Ok(())
    }

    /// Permissionless liquidation when equity falls to/below maintenance margin.
    /// Protocol-enforced — no signature required.
    pub fn liquidate(ctx: Context<Maintain>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let oracle = &ctx.accounts.oracle;
        require!(oracle.price > 0, PerpError::BadPrice);
        require!(now - oracle.publish_time <= MAX_ORACLE_STALENESS, PerpError::StaleOracle);

        let pos = &ctx.accounts.position;
        let m = &ctx.accounts.market;
        let elapsed = now - pos.open_time;
        let p = math::pnl(pos.side, pos.notional, pos.entry_price, oracle.price);
        let fees = math::open_fee(pos.notional, m.open_fee_bps)
            + math::borrow_fee(pos.notional, m.borrow_fee_bps_per_hour, elapsed);
        let eq = math::equity(pos.collateral, p, fees);
        let maint = math::maintenance(pos.notional, m.maintenance_bps);
        require!(math::is_liquidatable(eq, maint), PerpError::NotLiquidatable);

        settle_and_close(
            &mut ctx.accounts.market,
            &ctx.accounts.oracle,
            &ctx.accounts.position,
            &ctx.accounts.vault,
            &ctx.accounts.trader_usdt,
            &ctx.accounts.token_program,
            now,
            CloseKind::Liquidation,
        )
    }

    /// Permissionless stop-loss / take-profit trigger. Pre-authorized by the
    /// SL/TP levels the trader signed at open — no new signature required.
    pub fn trigger(ctx: Context<Maintain>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let oracle = &ctx.accounts.oracle;
        require!(oracle.price > 0, PerpError::BadPrice);
        require!(now - oracle.publish_time <= MAX_ORACLE_STALENESS, PerpError::StaleOracle);

        let pos = &ctx.accounts.position;
        let price = oracle.price;
        let hit = if pos.side == SIDE_LONG {
            (pos.sl_price > 0 && price <= pos.sl_price) || (pos.tp_price > 0 && price >= pos.tp_price)
        } else {
            (pos.sl_price > 0 && price >= pos.sl_price) || (pos.tp_price > 0 && price <= pos.tp_price)
        };
        require!(hit, PerpError::TriggerNotMet);

        settle_and_close(
            &mut ctx.accounts.market,
            &ctx.accounts.oracle,
            &ctx.accounts.position,
            &ctx.accounts.vault,
            &ctx.accounts.trader_usdt,
            &ctx.accounts.token_program,
            now,
            CloseKind::Trigger,
        )
    }
}

enum CloseKind {
    User,
    Liquidation,
    Trigger,
}

/// Shared settlement: compute payout at the live price, pay it out of the vault
/// (signed by the market PDA), and update market open interest. The `position`
/// account itself is closed by Anchor's `close =` constraint on the context.
fn settle_and_close<'info>(
    market: &mut Account<'info, Market>,
    oracle: &Account<'info, OracleState>,
    position: &Account<'info, Position>,
    vault: &Account<'info, TokenAccount>,
    trader_usdt: &Account<'info, TokenAccount>,
    token_program: &Program<'info, Token>,
    now: i64,
    kind: CloseKind,
) -> Result<()> {
    let exit = oracle.price;
    let elapsed = now - position.open_time;
    let s = math::settle(
        position.side,
        position.collateral,
        position.notional,
        position.entry_price,
        exit,
        market.open_fee_bps,
        market.borrow_fee_bps_per_hour,
        elapsed,
        vault.amount,
    );

    if s.payout > 0 {
        let mint_key = market.collateral_mint;
        let market_seeds: &[&[u8]] = &[b"market", mint_key.as_ref(), &[market.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                token_program.to_account_info(),
                Transfer {
                    from: vault.to_account_info(),
                    to: trader_usdt.to_account_info(),
                    authority: market.to_account_info(),
                },
                &[market_seeds],
            ),
            s.payout,
        )?;
    }

    // Release open interest (mirror of the increment in open_position).
    if position.side == SIDE_LONG {
        market.total_long_notional = market.total_long_notional.saturating_sub(position.notional);
    } else {
        market.total_short_notional = market.total_short_notional.saturating_sub(position.notional);
    }
    market.open_positions = market.open_positions.saturating_sub(1);

    emit!(PositionClosed {
        position: position.key(),
        trader: position.trader,
        side: position.side,
        exit_price: exit,
        pnl: s.pnl,
        fees: s.fees as u64,
        payout: s.payout,
        kind: match kind {
            CloseKind::User => 0,
            CloseKind::Liquidation => 1,
            CloseKind::Trigger => 2,
        },
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

#[account]
pub struct OracleState {
    pub authority: Pubkey,
    pub price: u64,
    pub publish_time: i64,
    pub bump: u8,
}
impl OracleState {
    pub const SPACE: usize = 8 + 32 + 8 + 8 + 1;
}

#[account]
pub struct Market {
    pub authority: Pubkey,
    pub oracle: Pubkey,
    pub collateral_mint: Pubkey,
    pub vault: Pubkey,
    pub maintenance_bps: u16,
    pub max_leverage: u16,
    pub open_fee_bps: u16,
    pub borrow_fee_bps_per_hour: u16,
    pub total_long_notional: u64,
    pub total_short_notional: u64,
    pub open_positions: u64,
    pub bump: u8,
    pub vault_bump: u8,
}
impl Market {
    pub const SPACE: usize = 8 + 32 + 32 + 32 + 32 + 2 + 2 + 2 + 2 + 8 + 8 + 8 + 1 + 1;
}

#[account]
pub struct Trader {
    pub authority: Pubkey,
    pub xmss_root: [u8; 32],
    pub epoch: u64,
    pub used: u64,
    pub nonce: u64,
    pub position_count: u64,
    pub bump: u8,
}
impl Trader {
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 8 + 8 + 8 + 1;
}

#[account]
pub struct Position {
    pub trader: Pubkey,
    pub market: Pubkey,
    pub side: u8,
    pub collateral: u64,
    pub notional: u64,
    pub entry_price: u64,
    pub leverage: u16,
    pub sl_price: u64,
    pub tp_price: u64,
    pub open_time: i64,
    pub seq: u64,
    pub bump: u8,
}
impl Position {
    pub const SPACE: usize = 8 + 32 + 32 + 1 + 8 + 8 + 8 + 2 + 8 + 8 + 8 + 8 + 1;
}

#[derive(Accounts)]
pub struct InitOracle<'info> {
    #[account(init, payer = authority, space = OracleState::SPACE, seeds = [b"oracle"], bump)]
    pub oracle: Account<'info, OracleState>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateOracle<'info> {
    #[account(mut, seeds = [b"oracle"], bump = oracle.bump, has_one = authority)]
    pub oracle: Account<'info, OracleState>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct InitMarket<'info> {
    #[account(
        init,
        payer = authority,
        space = Market::SPACE,
        seeds = [b"market", collateral_mint.key().as_ref()],
        bump
    )]
    pub market: Account<'info, Market>,
    pub collateral_mint: Account<'info, Mint>,
    pub oracle: Account<'info, OracleState>,
    #[account(
        init,
        payer = authority,
        seeds = [b"vault", market.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = market,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct CreateTrader<'info> {
    #[account(
        init,
        payer = payer,
        space = Trader::SPACE,
        seeds = [b"trader", authority.key().as_ref()],
        bump
    )]
    pub trader: Account<'info, Trader>,
    /// CHECK: the trader's on-chain authority pubkey, used only as a PDA seed.
    pub authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
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
pub struct OpenPosition<'info> {
    #[account(
        mut,
        seeds = [b"trader", authority.key().as_ref()],
        bump = trader.bump,
        has_one = authority,
    )]
    pub trader: Account<'info, Trader>,
    /// CHECK: the trader's authority pubkey, used as a PDA seed + transfer signer.
    pub authority: UncheckedAccount<'info>,
    /// CHECK: raw program-owned signature buffer; ownership asserted in handler.
    pub buffer: UncheckedAccount<'info>,

    #[account(mut, seeds = [b"market", market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(seeds = [b"oracle"], bump = oracle.bump, address = market.oracle)]
    pub oracle: Account<'info, OracleState>,

    #[account(mut, token::mint = market.collateral_mint, token::authority = trader)]
    pub trader_usdt: Account<'info, TokenAccount>,
    #[account(mut, address = market.vault)]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = payer,
        space = Position::SPACE,
        seeds = [b"position", trader.key().as_ref(), &trader.position_count.to_le_bytes()],
        bump
    )]
    pub position: Account<'info, Position>,

    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    #[account(
        mut,
        seeds = [b"trader", authority.key().as_ref()],
        bump = trader.bump,
        has_one = authority,
    )]
    pub trader: Account<'info, Trader>,
    /// CHECK: the trader's authority pubkey, used only as a PDA seed.
    pub authority: UncheckedAccount<'info>,
    /// CHECK: raw program-owned signature buffer; ownership asserted in handler.
    pub buffer: UncheckedAccount<'info>,

    #[account(mut, seeds = [b"market", market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(seeds = [b"oracle"], bump = oracle.bump, address = market.oracle)]
    pub oracle: Account<'info, OracleState>,

    #[account(mut, token::mint = market.collateral_mint, token::authority = trader)]
    pub trader_usdt: Account<'info, TokenAccount>,
    #[account(mut, address = market.vault)]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        close = payer,
        seeds = [b"position", trader.key().as_ref(), &position.seq.to_le_bytes()],
        bump = position.bump,
        constraint = position.trader == trader.key() @ PerpError::WrongPosition,
        constraint = position.market == market.key() @ PerpError::WrongPosition,
    )]
    pub position: Account<'info, Position>,

    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

/// Permissionless maintenance path (liquidation / SL-TP trigger) — no buffer,
/// no signature, no trader-state mutation. The caller (keeper) pays fees.
#[derive(Accounts)]
pub struct Maintain<'info> {
    #[account(
        seeds = [b"trader", trader.authority.as_ref()],
        bump = trader.bump,
    )]
    pub trader: Account<'info, Trader>,

    #[account(mut, seeds = [b"market", market.collateral_mint.as_ref()], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(seeds = [b"oracle"], bump = oracle.bump, address = market.oracle)]
    pub oracle: Account<'info, OracleState>,

    #[account(mut, token::mint = market.collateral_mint, token::authority = trader)]
    pub trader_usdt: Account<'info, TokenAccount>,
    #[account(mut, address = market.vault)]
    pub vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        close = payer,
        seeds = [b"position", trader.key().as_ref(), &position.seq.to_le_bytes()],
        bump = position.bump,
        constraint = position.trader == trader.key() @ PerpError::WrongPosition,
        constraint = position.market == market.key() @ PerpError::WrongPosition,
    )]
    pub position: Account<'info, Position>,

    #[account(mut)]
    pub payer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

// ---------------------------------------------------------------------------
// Events + errors
// ---------------------------------------------------------------------------

#[event]
pub struct PositionOpened {
    pub position: Pubkey,
    pub trader: Pubkey,
    pub side: u8,
    pub collateral: u64,
    pub notional: u64,
    pub entry_price: u64,
    pub leverage: u16,
    pub sl_price: u64,
    pub tp_price: u64,
}

#[event]
pub struct PositionClosed {
    pub position: Pubkey,
    pub trader: Pubkey,
    pub side: u8,
    pub exit_price: u64,
    pub pnl: i128,
    pub fees: u64,
    pub payout: u64,
    /// 0 = user close, 1 = liquidation, 2 = SL/TP trigger.
    pub kind: u8,
}

#[error_code]
pub enum PerpError {
    #[msg("signature buffer is not owned by the perp program")]
    BufferNotOwned,
    #[msg("write would overflow the signature buffer")]
    BufferOverflow,
    #[msg("invalid post-quantum signature")]
    InvalidSignature,
    #[msg("intent has expired")]
    IntentExpired,
    #[msg("oracle price is stale")]
    StaleOracle,
    #[msg("oracle price invalid")]
    BadPrice,
    #[msg("entry price worse than the signed limit (slippage)")]
    EntrySlippage,
    #[msg("leverage exceeds the market maximum")]
    LeverageTooHigh,
    #[msg("position is not below maintenance margin")]
    NotLiquidatable,
    #[msg("stop-loss / take-profit condition not met")]
    TriggerNotMet,
    #[msg("position does not belong to this trader/market")]
    WrongPosition,
    #[msg("invalid parameter")]
    BadParam,
    #[msg("trader wallet has exhausted all signing epochs")]
    WalletExhausted,
    #[msg("arithmetic overflow")]
    Overflow,
}

// ---------------------------------------------------------------------------
// Unit tests for the pure settlement math (host-run).
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::math::*;
    use super::{SIDE_LONG, SIDE_SHORT};

    // $150.00 entry, USDT 6dp, prices ×1e6.
    const ENTRY: u64 = 150_000_000;

    #[test]
    fn long_profit() {
        // 250 USDT collateral, 5x -> 1250 notional. Price +10% -> +125 USDT (gross).
        let collat = 250_000_000;
        let n = notional(collat, 5).unwrap();
        assert_eq!(n, 1_250_000_000);
        let exit = 165_000_000; // +10%
        let p = pnl(SIDE_LONG, n, ENTRY, exit);
        assert_eq!(p, 125_000_000);
        // No fees: equity = 375, payout capped by vault.
        let s = settle(SIDE_LONG, collat, n, ENTRY, exit, 0, 0, 0, 1_000_000_000_000);
        assert_eq!(s.payout, 375_000_000);
    }

    #[test]
    fn short_profit_on_drop() {
        let collat = 100_000_000;
        let n = notional(collat, 10).unwrap(); // 1000 notional
        let exit = 135_000_000; // -10%
        let p = pnl(SIDE_SHORT, n, ENTRY, exit);
        assert_eq!(p, 100_000_000); // +10% of 1000 notional
        let s = settle(SIDE_SHORT, collat, n, ENTRY, exit, 0, 0, 0, 1_000_000_000_000);
        assert_eq!(s.payout, 200_000_000);
    }

    #[test]
    fn long_wiped_out_pays_zero() {
        // 5x long; a 20% adverse move wipes 100% of collateral (5x * 20% = 100%).
        let collat = 250_000_000;
        let n = notional(collat, 5).unwrap();
        let exit = 120_000_000; // -20%
        let p = pnl(SIDE_LONG, n, ENTRY, exit);
        assert_eq!(p, -250_000_000);
        let s = settle(SIDE_LONG, collat, n, ENTRY, exit, 0, 0, 0, 1_000_000_000_000);
        assert_eq!(s.payout, 0);
        assert!(s.equity <= 0);
    }

    #[test]
    fn liquidation_triggers_before_insolvency() {
        // 10x long, 5% maintenance. A ~9.5% drop should be liquidatable while
        // equity is still positive (vault protected).
        let collat = 100_000_000;
        let n = notional(collat, 10).unwrap(); // 1000 notional
        let exit = 135_750_000; // -9.5%
        let p = pnl(SIDE_LONG, n, ENTRY, exit);
        let eq = equity(collat, p, 0);
        let maint = maintenance(n, 500); // 5% of 1000 = 50 USDT
        assert!(eq > 0, "equity still positive");
        assert!(is_liquidatable(eq, maint), "below maintenance");
    }

    #[test]
    fn fees_reduce_payout() {
        let collat = 100_000_000;
        let n = notional(collat, 4).unwrap(); // 400 notional
        // flat price, 10bps open fee + 1bps/hr for 10 hours = 10bps + 10bps = 20bps of 400 = 0.8 USDT
        let s = settle(SIDE_LONG, collat, n, ENTRY, ENTRY, 10, 1, 36_000, 1_000_000_000_000);
        assert_eq!(s.fees, 800_000); // 0.8 USDT
        assert_eq!(s.payout, 99_200_000);
    }
}
