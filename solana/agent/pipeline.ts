/**
 * The agent write-pipeline, mirroring maki:
 *
 *   interpret -> resolve -> quote -> policy check -> deterministic summary
 *             -> approve -> sign (isolated signer) -> submit
 *
 * The LLM (or a deterministic parser) only produces a structured intent. Every
 * security-relevant decision — resolved mints, route, min_out, limits, the exact
 * digest that gets signed — is made by deterministic code here, and signing
 * happens behind the isolated PORST signer. The model never moves funds.
 */
import { PublicKey } from "@solana/web3.js";
import { AgentSDK, PoolInfo } from "./sdk";
import { SignerClient } from "./signer/client";
import { Policy, SwapAction, checkSwap, SpendTracker } from "./policy";

export interface Token {
  symbol: string;
  mint: PublicKey;
  decimals: number;
}
export type TokenRegistry = Record<string, Token>;

export interface ParsedIntent {
  action: "swap";
  amount: number; // human units
  inSym: string;
  outSym: string;
}

/** Deterministic intent parser (an LLM may produce this object instead). */
export function parseIntent(text: string): ParsedIntent {
  // e.g. "swap 1.5 AAA to BBB"
  const m = text.trim().match(/^swap\s+([0-9]*\.?[0-9]+)\s+([A-Za-z0-9]+)\s+(?:to|for|->)\s+([A-Za-z0-9]+)$/i);
  if (!m) throw new Error(`could not parse intent: "${text}"`);
  return { action: "swap", amount: parseFloat(m[1]), inSym: m[2].toUpperCase(), outSym: m[3].toUpperCase() };
}

const pkHex = (p: PublicKey) => Buffer.from(p.toBytes()).toString("hex");
const toBase = (amount: number, decimals: number): bigint =>
  BigInt(Math.round(amount * 10 ** decimals));

export interface SwapPlan {
  summary: string;
  action: SwapAction;
  inputMint: PublicKey;
  outputMint: PublicKey;
  expectedOut: bigint;
  decimalsOut: number;
}

export interface RunResult {
  status: "executed" | "rejected";
  reason?: string;
  summary: string;
  txSig?: string;
  received?: bigint;
}

/** interpret -> resolve -> quote -> policy -> summary. No signing yet. */
export async function planSwap(
  sdk: AgentSDK,
  registry: TokenRegistry,
  p: PoolInfo,
  parsed: ParsedIntent,
  opts: { slippageBps: number; ttlSeconds: number; now: number; protocol: PublicKey }
): Promise<SwapPlan> {
  const inTok = registry[parsed.inSym];
  const outTok = registry[parsed.outSym];
  if (!inTok || !outTok) throw new Error("unknown token symbol");

  const amountIn = toBase(parsed.amount, inTok.decimals);
  const { expectedOut } = await sdk.quote(p, inTok.mint, amountIn);
  const minOut = (expectedOut * BigInt(10_000 - opts.slippageBps)) / 10_000n;
  const expiry = opts.now + opts.ttlSeconds;

  const action: SwapAction = {
    type: "swap",
    inputMint: inTok.mint.toBase58(),
    outputMint: outTok.mint.toBase58(),
    protocol: opts.protocol.toBase58(),
    amountIn,
    minOut,
    slippageBps: opts.slippageBps,
    expiry,
  };

  const summary =
    `SWAP ${parsed.amount} ${inTok.symbol} -> ${outTok.symbol}\n` +
    `  expected out: ${expectedOut} base (min ${minOut}, slippage ${opts.slippageBps}bps)\n` +
    `  route: cpswap ${opts.protocol.toBase58().slice(0, 8)}…  expiry: +${opts.ttlSeconds}s`;

  return { summary, action, inputMint: inTok.mint, outputMint: outTok.mint, expectedOut, decimalsOut: outTok.decimals };
}

/** Full pipeline: plan -> policy -> approve -> isolated sign -> submit. */
export async function runSwap(
  sdk: AgentSDK,
  signer: SignerClient,
  policy: Policy,
  registry: TokenRegistry,
  p: PoolInfo,
  text: string,
  opts: {
    slippageBps?: number;
    ttlSeconds?: number;
    now: number;
    approve?: boolean;
    spend?: SpendTracker;
  }
): Promise<RunResult> {
  const slippageBps = opts.slippageBps ?? 50;
  const ttlSeconds = opts.ttlSeconds ?? 60;

  const parsed = parseIntent(text);
  const plan = await planSwap(sdk, registry, p, parsed, {
    slippageBps,
    ttlSeconds,
    now: opts.now,
    protocol: sdk.cpswap.programId,
  });

  // POLICY — deterministic, before any signature is requested.
  const decision = checkSwap(policy, plan.action, opts.now, opts.spend);
  if (!decision.allowed) {
    return { status: "rejected", reason: decision.reason, summary: plan.summary };
  }

  // STATE — the chain is the source of truth for (epoch, nonce).
  const state = await sdk.agentState();
  const routeHash = sdk.routeHash(p);

  // SIGN — isolated signer; the agent core never holds the seed.
  const signed = await signer.signSwap({
    epoch: state.epoch,
    nonce: state.nonce,
    inputMint: pkHex(plan.inputMint),
    outputMint: pkHex(plan.outputMint),
    amountIn: Number(plan.action.amountIn),
    minOut: Number(plan.action.minOut),
    routeHash,
    expiry: plan.action.expiry,
    summary: plan.summary,
    approve: opts.approve ?? decision.approvalMode === "auto",
  });
  if (!signed.approved || !signed.signature) {
    return { status: "rejected", reason: signed.reason ?? "not approved", summary: plan.summary };
  }

  // SUBMIT — stage the ~13 KB signature, then execute the real swap.
  const buffer = await sdk.stageSignature(signed.signature);
  const agentOut = (await import("@solana/spl-token")).getAssociatedTokenAddressSync(
    plan.outputMint,
    sdk.agentPda(),
    true
  );
  const before = await sdk.balance(agentOut);
  const txSig = await sdk.executeSwap({
    p,
    inputMint: plan.inputMint,
    outputMint: plan.outputMint,
    amountIn: plan.action.amountIn,
    minOut: plan.action.minOut,
    expiry: plan.action.expiry,
    buffer,
  });
  const received = (await sdk.balance(agentOut)) - before;
  opts.spend?.add(plan.action.inputMint, plan.action.amountIn);

  return { status: "executed", summary: plan.summary, txSig, received };
}
