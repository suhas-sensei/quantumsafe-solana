/**
 * Deterministic policy for the perp engine — the AI proposes, this decides.
 * Runs in the agent core before the isolated signer is ever contacted, so an
 * over-leveraged / over-sized / unsafe position is rejected without a signature
 * ever being requested. Mirrors the swap `policy.ts` boundary.
 */

export interface PerpLimits {
  /** Hard cap on leverage (must also be ≤ the on-chain market max). */
  maxLeverage: number;
  /** Max collateral per position, USDT base units (6dp). */
  maxCollateral: bigint;
  /** Min collateral per position, USDT base units. */
  minCollateral: bigint;
  /** Max notional (collateral × leverage), USDT base units. */
  maxNotional: bigint;
  /** Require a stop-loss when leverage is strictly above this. */
  requireSlAboveLeverage: number;
  /** Max number of simultaneously open positions. */
  maxOpenPositions: number;
  /** Reject intents whose expiry is further out than this (seconds). */
  maxExpirySeconds: number;
}

export const DEFAULT_PERP_LIMITS: PerpLimits = {
  maxLeverage: 20,
  maxCollateral: 5_000_000_000n, // 5,000 USDT
  minCollateral: 1_000_000n, // 1 USDT
  maxNotional: 50_000_000_000n, // 50,000 USDT
  requireSlAboveLeverage: 10,
  maxOpenPositions: 5,
  maxExpirySeconds: 300,
};

export interface PerpOpenAction {
  side: 0 | 1;
  collateral: bigint; // USDT base
  leverage: number;
  slPrice: bigint; // 1e6, 0 = unset
  tpPrice: bigint; // 1e6, 0 = unset
  entryPrice: bigint; // current mark, 1e6
  expiry: number; // unix seconds
}

export type PerpDecision = { allowed: true } | { allowed: false; reason: string };

export function checkOpen(
  limits: PerpLimits,
  a: PerpOpenAction,
  now: number,
  ctx: { traderBalance: bigint; openCount: number }
): PerpDecision {
  if (a.side !== 0 && a.side !== 1) return { allowed: false, reason: "side must be long or short" };
  if (a.leverage < 1) return { allowed: false, reason: "leverage must be ≥ 1x" };
  if (a.leverage > limits.maxLeverage)
    return { allowed: false, reason: `leverage ${a.leverage}x exceeds max ${limits.maxLeverage}x` };
  if (a.collateral < limits.minCollateral) return { allowed: false, reason: "collateral below minimum" };
  if (a.collateral > limits.maxCollateral)
    return { allowed: false, reason: `collateral exceeds per-position cap` };
  if (a.collateral > ctx.traderBalance)
    return { allowed: false, reason: "insufficient USDT balance for this collateral" };

  const notional = a.collateral * BigInt(a.leverage);
  if (notional > limits.maxNotional) return { allowed: false, reason: "notional exceeds cap" };

  if (a.leverage > limits.requireSlAboveLeverage && a.slPrice === 0n)
    return { allowed: false, reason: `a stop-loss is required above ${limits.requireSlAboveLeverage}x leverage` };

  // Sanity of SL/TP relative to side + entry.
  if (a.side === 0) {
    if (a.slPrice !== 0n && a.slPrice >= a.entryPrice)
      return { allowed: false, reason: "long stop-loss must be below entry" };
    if (a.tpPrice !== 0n && a.tpPrice <= a.entryPrice)
      return { allowed: false, reason: "long take-profit must be above entry" };
  } else {
    if (a.slPrice !== 0n && a.slPrice <= a.entryPrice)
      return { allowed: false, reason: "short stop-loss must be above entry" };
    if (a.tpPrice !== 0n && a.tpPrice >= a.entryPrice)
      return { allowed: false, reason: "short take-profit must be below entry" };
  }

  if (ctx.openCount >= limits.maxOpenPositions)
    return { allowed: false, reason: `already at the open-position limit (${limits.maxOpenPositions})` };
  if (a.expiry <= now) return { allowed: false, reason: "intent already expired" };
  if (a.expiry - now > limits.maxExpirySeconds)
    return { allowed: false, reason: `expiry too far out (> ${limits.maxExpirySeconds}s)` };

  return { allowed: true };
}
