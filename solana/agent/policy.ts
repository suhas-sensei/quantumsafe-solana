/**
 * Policy engine for the PORST agent — a Solana/swap adaptation of maki's
 * deterministic policy layer. The LLM proposes; this code decides. It runs in
 * the agent core (before the isolated signer is ever contacted), so an
 * over-limit, over-slippage, or non-allowlisted action is rejected without a
 * signature ever being requested.
 */

export type ActionClass = 0 | 1 | 2 | 3 | 4; // 0 read · 1 low · 2 medium · 3 admin · 4 forbidden
export type ApprovalMode = "auto" | "approve" | "deny";

export interface SwapLimits {
  /** Max input amount per swap, in the input token's base units. */
  maxAmountInPerTx: bigint;
  /** Max cumulative input per token per session, base units. */
  maxAmountInDaily: bigint;
  /** Max acceptable slippage, basis points. */
  maxSlippageBps: number;
  /** Reject intents whose expiry is further out than this (seconds). */
  maxExpirySeconds: number;
}

export interface Allowlists {
  /** Allowed token mints (base58). Empty = allow any. */
  tokens: string[];
  /** Allowed DEX program ids (base58). Empty = allow any. */
  protocols: string[];
}

export interface Policy {
  version: 1;
  approval: { low: ApprovalMode; medium: ApprovalMode; admin: ApprovalMode; timeoutSeconds: number };
  limits: SwapLimits;
  allowlists: Allowlists;
}

export interface SwapAction {
  type: "swap";
  inputMint: string;
  outputMint: string;
  protocol: string; // DEX program id
  amountIn: bigint;
  minOut: bigint;
  slippageBps: number;
  expiry: number; // unix seconds
}

export type PolicyDecision =
  | { allowed: true; approvalMode: ApprovalMode; actionClass: ActionClass }
  | { allowed: false; reason: string };

export const DEFAULT_POLICY = (overrides: Partial<Policy> = {}): Policy => ({
  version: 1,
  approval: { low: "auto", medium: "approve", admin: "deny", timeoutSeconds: 60 },
  limits: {
    maxAmountInPerTx: 1_000_000_000n, // 1 token @ 9 decimals
    maxAmountInDaily: 5_000_000_000n,
    maxSlippageBps: 100, // 1%
    maxExpirySeconds: 300,
  },
  allowlists: { tokens: [], protocols: [] },
  ...overrides,
});

/** Simple per-session spend tracker (mirrors maki's daily tracker). */
export class SpendTracker {
  private byToken = new Map<string, bigint>();
  add(mint: string, amount: bigint) {
    this.byToken.set(mint, (this.byToken.get(mint) ?? 0n) + amount);
  }
  total(mint: string): bigint {
    return this.byToken.get(mint) ?? 0n;
  }
}

/** Evaluate a swap against policy. Pure and deterministic. */
export function checkSwap(
  policy: Policy,
  action: SwapAction,
  now: number,
  spend?: SpendTracker
): PolicyDecision {
  const { limits, allowlists } = policy;

  if (allowlists.tokens.length > 0) {
    for (const m of [action.inputMint, action.outputMint]) {
      if (!allowlists.tokens.includes(m)) {
        return { allowed: false, reason: `token ${m} not in allowlist` };
      }
    }
  }
  if (allowlists.protocols.length > 0 && !allowlists.protocols.includes(action.protocol)) {
    return { allowed: false, reason: `protocol ${action.protocol} not in allowlist` };
  }
  if (action.amountIn <= 0n) {
    return { allowed: false, reason: "amount must be positive" };
  }
  if (action.amountIn > limits.maxAmountInPerTx) {
    return {
      allowed: false,
      reason: `amount ${action.amountIn} exceeds per-tx limit ${limits.maxAmountInPerTx}`,
    };
  }
  if (spend && spend.total(action.inputMint) + action.amountIn > limits.maxAmountInDaily) {
    return { allowed: false, reason: `daily limit for ${action.inputMint} exceeded` };
  }
  if (action.slippageBps > limits.maxSlippageBps) {
    return {
      allowed: false,
      reason: `slippage ${action.slippageBps}bps exceeds max ${limits.maxSlippageBps}bps`,
    };
  }
  if (action.expiry <= now) {
    return { allowed: false, reason: "intent already expired" };
  }
  if (action.expiry - now > limits.maxExpirySeconds) {
    return {
      allowed: false,
      reason: `expiry too far out (> ${limits.maxExpirySeconds}s)`,
    };
  }

  // Risk class: a swap is medium-risk; tighten to admin if no allowlists set.
  const actionClass: ActionClass = 2;
  const approvalMode = policy.approval.medium;
  if (approvalMode === "deny") {
    return { allowed: false, reason: "medium-risk actions denied by policy" };
  }
  return { allowed: true, approvalMode, actionClass };
}
