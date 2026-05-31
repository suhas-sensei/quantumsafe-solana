/**
 * Real price feed for the perp engine.
 *
 * Fetches the live SOL/USD price from Pyth's Hermes network (the actual Pyth
 * oracle price — not a mock), normalizes it to the engine's fixed-point unit
 * (USDT-per-SOL × 1e6), and posts it on-chain to `OracleState` via the keeper
 * authority. The on-chain read sits behind one account, so swapping this push
 * keeper for a native Pyth-receiver CPI later is a localized change.
 */
import { PerpSDK, PRICE_SCALE } from "./perp";

/** Pyth SOL/USD price feed id (served by Hermes for every cluster). */
export const SOL_USD_FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const HERMES = "https://hermes.pyth.network/v2/updates/price/latest";

export interface PriceTick {
  /** USDT-per-SOL × 1e6 (the on-chain fixed-point unit). */
  price: bigint;
  /** Pyth publish time (unix seconds). */
  publishTime: number;
  /** Human-readable USD price. */
  human: number;
  /** Pyth EMA price (human USD) — a short-term reference for momentum. */
  ema: number;
  /** Short-term momentum: (price − ema) / ema × 100. */
  momentumPct: number;
}

function scaleToE6(rawStr: string, expo: number): bigint {
  const raw = BigInt(rawStr);
  const shift = 6 + expo;
  return shift >= 0 ? raw * 10n ** BigInt(shift) : raw / 10n ** BigInt(-shift);
}

/** Fetch the live SOL/USD price from Pyth Hermes. */
export async function fetchSolPrice(feed = SOL_USD_FEED): Promise<PriceTick> {
  const url = `${HERMES}?ids[]=${feed}&encoding=hex&parsed=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`hermes ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  const parsed = data?.parsed?.[0];
  const p = parsed?.price;
  if (!p) throw new Error("hermes: no parsed price");
  const price = scaleToE6(p.price, Number(p.expo)); // ×1e6
  if (price <= 0n) throw new Error("hermes: non-positive price");
  const human = Number(price) / PRICE_SCALE;
  // EMA (optional) for a real momentum signal.
  let ema = human;
  if (parsed.ema_price) {
    const e = scaleToE6(parsed.ema_price.price, Number(parsed.ema_price.expo));
    if (e > 0n) ema = Number(e) / PRICE_SCALE;
  }
  const momentumPct = ema > 0 ? ((human - ema) / ema) * 100 : 0;
  return { price, publishTime: Number(p.publish_time), human, ema, momentumPct };
}

/** Push the latest real price on-chain. Returns the tick that was posted. */
export async function pushPrice(perp: PerpSDK, feed = SOL_USD_FEED): Promise<PriceTick> {
  const tick = await fetchSolPrice(feed);
  await perp.updateOracle(tick.price, tick.publishTime);
  return tick;
}

/**
 * The keeper loop: keep the on-chain oracle fresh and run liquidations + SL/TP
 * triggers. Runs in-process (background) inside the agent server. Returns a stop
 * function. `onEvent` surfaces actions for logging/UI.
 */
export function startKeeper(
  perp: PerpSDK,
  opts: {
    intervalMs?: number;
    feed?: string;
    onEvent?: (e: { kind: string; detail: string }) => void;
  } = {}
): () => void {
  const intervalMs = opts.intervalMs ?? 8_000;
  const feed = opts.feed ?? SOL_USD_FEED;
  const log = opts.onEvent ?? (() => {});
  let stopped = false;

  async function tick() {
    if (stopped) return;
    try {
      const t = await pushPrice(perp, feed);
      await sweepPositions(perp, t, log);
    } catch (e: any) {
      log({ kind: "keeper-error", detail: String(e?.message || e) });
    }
  }

  const handle = setInterval(tick, intervalMs);
  void tick(); // prime immediately
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

/** Compute live equity and fire liquidate / SL-TP trigger where warranted. */
export async function sweepPositions(
  perp: PerpSDK,
  tick: PriceTick,
  log: (e: { kind: string; detail: string }) => void
): Promise<void> {
  const market = await perp.marketState();
  const maintenanceBps = Number(market.maintenanceBps);
  const openFeeBps = Number(market.openFeeBps);
  const borrowBpsHr = Number(market.borrowFeeBpsPerHour);
  const now = Math.floor(Date.now() / 1000);
  const positions = await perp.openPositions();

  for (const pos of positions) {
    const price = tick.price;
    // --- SL / TP first (pre-authorized, exact trigger) ---
    const isLong = pos.side === 0;
    const slHit = pos.slPrice > 0n && (isLong ? price <= pos.slPrice : price >= pos.slPrice);
    const tpHit = pos.tpPrice > 0n && (isLong ? price >= pos.tpPrice : price <= pos.tpPrice);
    if (slHit || tpHit) {
      try {
        const sig = await perp.maintain("trigger", pos.seq);
        log({ kind: slHit ? "stop-loss" : "take-profit", detail: `position #${pos.seq} @ ${tick.human.toFixed(2)} · ${sig.slice(0, 16)}…` });
        continue;
      } catch (e: any) {
        log({ kind: "trigger-failed", detail: `#${pos.seq}: ${String(e?.message || e).slice(0, 80)}` });
      }
    }
    // --- liquidation ---
    const diff = Number(price - pos.entryPrice);
    const rawPnl = (Number(pos.notional) * diff) / Number(pos.entryPrice);
    const pnl = isLong ? rawPnl : -rawPnl;
    const elapsed = Math.max(0, now - pos.openTime);
    const fees =
      (Number(pos.notional) * openFeeBps) / 10_000 +
      (Number(pos.notional) * borrowBpsHr * elapsed) / (10_000 * 3_600);
    const equity = Number(pos.collateral) + pnl - fees;
    const maint = (Number(pos.notional) * maintenanceBps) / 10_000;
    if (equity <= maint) {
      try {
        const sig = await perp.maintain("liquidate", pos.seq);
        log({ kind: "liquidation", detail: `position #${pos.seq} @ ${tick.human.toFixed(2)} · ${sig.slice(0, 16)}…` });
      } catch (e: any) {
        log({ kind: "liquidate-failed", detail: `#${pos.seq}: ${String(e?.message || e).slice(0, 80)}` });
      }
    }
  }
}
