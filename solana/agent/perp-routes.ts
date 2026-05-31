/**
 * Perp engine wiring for the agent server: a dedicated isolated PORST signer
 * (separate keystore), the on-chain `porst_perp` SDK, the real-price keeper
 * (liquidations + SL/TP), and the AI-mode handlers. Exposes four endpoints:
 *
 *   GET  /api/perp/state  -> price, market, trader, open positions (live PnL), keeper log
 *   POST /api/perp/chat   -> multi-turn AI: ask a question OR propose a position
 *   POST /api/perp/open   -> isolated PQ sign -> stage -> on-chain open_position
 *   POST /api/perp/close  -> isolated PQ sign -> stage -> on-chain close_position
 *
 * The model only proposes; deterministic policy + the isolated signer + the
 * on-chain program enforce everything.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { PerpSDK, SIDE_LONG, SIDE_SHORT, PRICE_SCALE } from "./perp";
import { SignerClient } from "./signer/client";
import { fetchSolPrice, startKeeper } from "./oracle";
import { bootstrapPerp, ensurePerpKeystore, PERP_KEYSTORE } from "./perp-bootstrap";
import { interpretPerp, ChatTurn, MarketSnapshot } from "./perp-llm";
import { checkOpen, DEFAULT_PERP_LIMITS, PerpOpenAction } from "./perp-policy";
import { llmProvider } from "./llm";

const PERP_SOCKET = path.join(os.tmpdir(), "porst-perp-signer.sock");
const TTL = 120;
const pkHex = (p: PublicKey) => Buffer.from(p.toBytes()).toString("hex");
const px = (human: number) => BigInt(Math.round(human * PRICE_SCALE));
const usd = (b: bigint) => Number(b) / 1e6;
const now = () => Math.floor(Date.now() / 1000);

export interface PerpRoutes {
  perpState: () => Promise<any>;
  perpChat: (body: { history?: ChatTurn[]; message: string }) => Promise<any>;
  perpOpen: (body: { plan: any }) => Promise<any>;
  perpClose: (body: { seq: number }) => Promise<any>;
  stop: () => void;
}

export async function initPerp(opts: {
  program: anchor.Program;
  provider: anchor.AnchorProvider;
  explorer: string;
}): Promise<PerpRoutes> {
  const { program, provider, explorer } = opts;
  const sdk = new PerpSDK(program, provider);

  ensurePerpKeystore();
  console.log("» spawning isolated perp signer");
  const signer = await SignerClient.spawn(PERP_KEYSTORE, PERP_SOCKET, { autoApprove: true });

  console.log("» bootstrapping perp market (USDT, oracle, market, trader, liquidity)…");
  const env = await bootstrapPerp(sdk);
  console.log("» perp market live:", env.market, "· trader pq root:", env.xmssRoot.slice(0, 16) + "…");

  // Keeper: keep the oracle fresh + run liquidations / SL-TP. Ring-buffer the log.
  const keeperLog: { kind: string; detail: string; at: number }[] = [];
  const stopKeeper = startKeeper(sdk, {
    intervalMs: 8_000,
    onEvent: (e) => {
      keeperLog.push({ ...e, at: now() });
      if (keeperLog.length > 25) keeperLog.shift();
      if (e.kind !== "keeper-error") console.log(`  [keeper] ${e.kind}: ${e.detail}`);
    },
  });

  const limits = { ...DEFAULT_PERP_LIMITS, maxLeverage: 20 };

  // ---- live PnL view of one position ----
  function viewPosition(p: any, priceE6: bigint, m: any) {
    const isLong = p.side === SIDE_LONG;
    const entry = Number(p.entryPrice);
    const diff = Number(priceE6) - entry;
    const rawPnl = (Number(p.notional) * diff) / entry;
    const pnl = isLong ? rawPnl : -rawPnl;
    const elapsed = Math.max(0, now() - p.openTime);
    const fees =
      (Number(p.notional) * Number(m.openFeeBps)) / 10_000 +
      (Number(p.notional) * Number(m.borrowFeeBpsPerHour) * elapsed) / (10_000 * 3_600);
    const equity = Number(p.collateral) + pnl - fees;
    const mb = Number(m.maintenanceBps) / 10_000;
    const lev = p.leverage;
    // liquidation price (ignoring fees): long entry*(1+mb-1/lev), short entry*(1-mb+1/lev)
    const entryH = entry / PRICE_SCALE;
    const liq = isLong ? entryH * (1 + mb - 1 / lev) : entryH * (1 - mb + 1 / lev);
    return {
      seq: p.seq,
      side: isLong ? "long" : "short",
      collateralUsd: usd(p.collateral),
      notionalUsd: usd(p.notional),
      entryUsd: entryH,
      leverage: lev,
      slUsd: p.slPrice > 0n ? Number(p.slPrice) / PRICE_SCALE : null,
      tpUsd: p.tpPrice > 0n ? Number(p.tpPrice) / PRICE_SCALE : null,
      liqUsd: liq,
      pnlUsd: pnl / 1e6,
      equityUsd: equity / 1e6,
    };
  }

  async function perpState() {
    const o = await sdk.oracleState();
    const m = await sdk.marketState();
    const t = await sdk.traderState();
    const bal = await sdk.traderBalance();
    const vault = await sdk.vaultBalance();
    const positions = await sdk.openPositions();
    const lifetime = 16 * 16;
    return {
      priceUsd: Number(o.price) / PRICE_SCALE,
      oracleAgeSec: now() - o.publishTime,
      market: {
        address: sdk.marketPda().toBase58(),
        maxLeverage: Number(m.maxLeverage),
        maintenanceBps: Number(m.maintenanceBps),
        openFeeBps: Number(m.openFeeBps),
        borrowFeeBpsPerHour: Number(m.borrowFeeBpsPerHour),
        longOiUsd: usd(BigInt(m.totalLongNotional.toString())),
        shortOiUsd: usd(BigInt(m.totalShortNotional.toString())),
      },
      wallet: {
        pubkey: env.xmssRoot,
        epoch: t.epoch,
        nonce: t.nonce,
        used: t.used,
        lifetime,
        remaining: (16 - t.epoch) * 16 - t.used,
      },
      balanceUsd: usd(bal),
      vaultUsd: usd(vault),
      positions: positions.map((p) => viewPosition(p, o.price, m)),
      keeperLog,
      llm: llmProvider(),
      explorer,
    };
  }

  async function snapshot(): Promise<MarketSnapshot> {
    const m = await sdk.marketState();
    const bal = await sdk.traderBalance();
    let priceUsd: number, emaUsd: number, momentumPct: number;
    try {
      const tick = await fetchSolPrice();
      priceUsd = tick.human;
      emaUsd = tick.ema;
      momentumPct = tick.momentumPct;
    } catch {
      const o = await sdk.oracleState();
      priceUsd = Number(o.price) / PRICE_SCALE;
      emaUsd = priceUsd;
      momentumPct = 0;
    }
    return {
      priceUsd,
      emaUsd,
      momentumPct,
      borrowBpsPerHour: Number(m.borrowFeeBpsPerHour),
      maxLeverage: Number(m.maxLeverage),
      traderBalanceUsd: usd(bal),
    };
  }

  // Convert SL/TP percentages to absolute prices for a side.
  function slTpPrices(side: number, entryHuman: number, slPct: number | null, tpPct: number | null) {
    const isLong = side === SIDE_LONG;
    const sl =
      slPct == null ? 0n : px(isLong ? entryHuman * (1 - slPct / 100) : entryHuman * (1 + slPct / 100));
    const tp =
      tpPct == null ? 0n : px(isLong ? entryHuman * (1 + tpPct / 100) : entryHuman * (1 - tpPct / 100));
    return { sl, tp };
  }

  async function perpChat(body: { history?: ChatTurn[]; message: string }) {
    const message = String(body.message || "");
    const history = (body.history || []).slice(-8);
    const snap = await snapshot();
    const interp = await interpretPerp(history, message, snap);
    if (interp.kind === "ask") return { kind: "chat", reply: interp.reply };

    // Build a concrete, policy-checked proposal.
    const side = interp.side === "short" ? SIDE_SHORT : SIDE_LONG;
    const entryHuman = snap.priceUsd;
    const collateral = px(interp.collateralUsd); // USDT base (6dp) == price scale 1e6
    const leverage = interp.leverage;
    const { sl, tp } = slTpPrices(side, entryHuman, interp.slPct, interp.tpPct);
    const entryE6 = px(entryHuman);
    const maxEntry = side === SIDE_LONG ? (entryE6 * 101n) / 100n : (entryE6 * 99n) / 100n;
    const expiry = now() + TTL;

    const action: PerpOpenAction = {
      side: side as 0 | 1,
      collateral,
      leverage,
      slPrice: sl,
      tpPrice: tp,
      entryPrice: entryE6,
      expiry,
    };
    const bal = await sdk.traderBalance();
    const openCount = (await sdk.openPositions()).length;
    const decision = checkOpen(limits, action, now(), { traderBalance: bal, openCount });

    const mb = (await sdk.marketState()).maintenanceBps / 10_000;
    const liq =
      side === SIDE_LONG
        ? entryHuman * (1 + mb - 1 / leverage)
        : entryHuman * (1 - mb + 1 / leverage);

    return {
      kind: "proposal",
      rationale: interp.rationale,
      proposal: {
        side: side === SIDE_LONG ? "long" : "short",
        collateralUsd: interp.collateralUsd,
        leverage,
        notionalUsd: interp.collateralUsd * leverage,
        entryUsd: entryHuman,
        slUsd: sl > 0n ? Number(sl) / PRICE_SCALE : null,
        tpUsd: tp > 0n ? Number(tp) / PRICE_SCALE : null,
        liqUsd: liq,
      },
      policy: decision.allowed ? { allowed: true } : { allowed: false, reason: decision.reason },
      // echoed verbatim to /api/perp/open (recomputed fresh there against live price)
      plan: {
        side,
        collateralUsd: interp.collateralUsd,
        leverage,
        slPct: interp.slPct,
        tpPct: interp.tpPct,
      },
    };
  }

  async function perpOpen(body: { plan: any }) {
    const plan = body.plan;
    const stages: { name: string; detail: string }[] = [];
    const side = Number(plan.side) === SIDE_SHORT ? SIDE_SHORT : SIDE_LONG;
    const leverage = Math.round(Number(plan.leverage));
    const collateral = px(Number(plan.collateralUsd));

    // Recompute against the LIVE mark so entry / SL / TP are fresh at execution.
    const o = await sdk.oracleState();
    const entryHuman = Number(o.price) / PRICE_SCALE;
    const { sl, tp } = slTpPrices(side, entryHuman, plan.slPct ?? null, plan.tpPct ?? null);
    const maxEntry = side === SIDE_LONG ? (o.price * 101n) / 100n : (o.price * 99n) / 100n;
    const expiry = now() + TTL;

    const action: PerpOpenAction = {
      side: side as 0 | 1,
      collateral,
      leverage,
      slPrice: sl,
      tpPrice: tp,
      entryPrice: o.price,
      expiry,
    };
    const bal = await sdk.traderBalance();
    const openCount = (await sdk.openPositions()).length;
    const decision = checkOpen(limits, action, now(), { traderBalance: bal, openCount });
    if (!decision.allowed) throw new Error(`policy: ${decision.reason}`);
    stages.push({ name: "Policy check", detail: `${leverage}x ${side === SIDE_LONG ? "long" : "short"} · ${usd(collateral)} USDT — passed` });

    const t = await sdk.traderState();
    const seq = t.positionCount;
    stages.push({ name: "Read on-chain state", detail: `epoch ${t.epoch}, nonce ${t.nonce}` });

    const signed = await signer.signOpenPerp({
      epoch: t.epoch,
      nonce: t.nonce,
      market: pkHex(sdk.marketPda()),
      side,
      collateral: Number(collateral),
      leverage,
      maxEntryPrice: Number(maxEntry),
      slPrice: Number(sl),
      tpPrice: Number(tp),
      expiry,
      summary: `OPEN ${side === SIDE_LONG ? "LONG" : "SHORT"} ${usd(collateral)} USDT ${leverage}x @ ~$${entryHuman.toFixed(2)}`,
      approve: true,
    });
    if (!signed.approved || !signed.signature) throw new Error(signed.reason || "signer declined");
    stages.push({
      name: "Isolated post-quantum signer",
      detail: `signed ${signed.signature.length / 2}-byte PORST signature (seed never left the signer)`,
    });

    const buffer = await sdk.stageSignature(signed.signature);
    stages.push({ name: "Stage signature on-chain", detail: "buffered into a program-owned account" });

    const txSig = await sdk.openPosition({
      side,
      collateral,
      leverage,
      maxEntryPrice: maxEntry,
      slPrice: sl,
      tpPrice: tp,
      expiry,
      seq,
      buffer,
    });
    stages.push({ name: "Open position on-chain", detail: `tx ${txSig.slice(0, 16)}…` });

    return { stages, txSig, seq, state: await perpState() };
  }

  async function perpClose(body: { seq: number }) {
    const seq = Number(body.seq);
    const stages: { name: string; detail: string }[] = [];
    const position = sdk.positionPda(seq);
    const expiry = now() + TTL;

    const t = await sdk.traderState();
    stages.push({ name: "Read on-chain state", detail: `epoch ${t.epoch}, nonce ${t.nonce}` });

    const signed = await signer.signClosePerp({
      epoch: t.epoch,
      nonce: t.nonce,
      position: pkHex(position),
      expiry,
      summary: `CLOSE position #${seq}`,
      approve: true,
    });
    if (!signed.approved || !signed.signature) throw new Error(signed.reason || "signer declined");
    stages.push({
      name: "Isolated post-quantum signer",
      detail: `signed ${signed.signature.length / 2}-byte PORST signature`,
    });

    const buffer = await sdk.stageSignature(signed.signature);
    stages.push({ name: "Stage signature on-chain", detail: "buffered into a program-owned account" });

    const balBefore = await sdk.traderBalance();
    const txSig = await sdk.closePosition({ seq, expiry, buffer });
    const received = (await sdk.traderBalance()) - balBefore;
    stages.push({ name: "Close position on-chain", detail: `tx ${txSig.slice(0, 16)}…` });
    stages.push({ name: "Settled", detail: `returned ${usd(received)} USDT` });

    return { stages, txSig, receivedUsd: usd(received), state: await perpState() };
  }

  return { perpState, perpChat, perpOpen, perpClose, stop: stopKeeper };
}
