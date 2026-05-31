/**
 * Boots the perp engine's on-chain environment: a USDT mint (persisted so the
 * market + positions survive restarts), the price oracle, the SOL-PERP market,
 * its LP vault, and the perp trader wallet (a SEPARATE post-quantum keystore from
 * the swap agent, so the few-time signing budget can't collide).
 */
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import { PerpSDK } from "./perp";
import { pushPrice } from "./oracle";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const wasm = require("../wasm/pkg-node/porst_wasm.js");

export const DEMO_DIR = path.join(__dirname, ".demo");
export const PERP_KEYSTORE = path.join(DEMO_DIR, "perp-keystore.json");
export const PERP_ENV = path.join(DEMO_DIR, "perp-env.json");

const usdt = (n: number) => BigInt(Math.round(n * 1e6));

export interface PerpEnv {
  usdtMint: string;
  market: string;
  xmssRoot: string;
  decimals: number;
}

/** The perp's dedicated post-quantum keystore (distinct from the swap wallet). */
export function ensurePerpKeystore(): { ks: string; xmssRoot: string } {
  fs.mkdirSync(DEMO_DIR, { recursive: true });
  let ks: string;
  if (fs.existsSync(PERP_KEYSTORE)) {
    ks = fs.readFileSync(PERP_KEYSTORE, "utf8");
  } else {
    ks = wasm.keygen(wasm.random_seed_hex());
    fs.writeFileSync(PERP_KEYSTORE, ks);
  }
  return { ks, xmssRoot: wasm.wallet_pubkey(ks) };
}

export async function bootstrapPerp(sdk: PerpSDK): Promise<PerpEnv> {
  const { xmssRoot } = ensurePerpKeystore();
  const decimals = 6;

  // Reuse a persisted USDT mint (and thus market + positions) across restarts.
  let freshMint = false;
  if (fs.existsSync(PERP_ENV)) {
    const env: PerpEnv = JSON.parse(fs.readFileSync(PERP_ENV, "utf8"));
    sdk.usdtMint = new PublicKey(env.usdtMint);
    // If the mint no longer exists on this cluster (e.g. a wiped localnet), recreate.
    if (!(await sdk.conn.getAccountInfo(sdk.usdtMint))) {
      freshMint = true;
    }
  } else {
    freshMint = true;
  }
  if (freshMint) {
    await sdk.createUsdt(decimals);
  }

  await sdk.initOracle();
  // Post a real price immediately so the market is live from boot.
  try {
    await pushPrice(sdk);
  } catch {
    /* keeper will retry */
  }
  const market = await sdk.initMarket({
    maintenanceBps: 500, // 5% maintenance margin
    maxLeverage: 20,
    openFeeBps: 10, // 0.10% open fee
    borrowFeeBpsPerHour: 1, // 0.01%/hr cost of carry
  });
  await sdk.createTrader(xmssRoot);
  await sdk.ensureTraderUsdt();

  // Fund the trader + seed the LP vault when the environment is fresh.
  if (freshMint) {
    await sdk.fundTrader(usdt(10_000)); // trader capital
    await sdk.fundVault(usdt(500_000)); // LP float (counterparty)
  } else {
    // Top up only if depleted (idempotent across reboots).
    if ((await sdk.traderBalance()) < usdt(100)) await sdk.fundTrader(usdt(10_000));
    if ((await sdk.vaultBalance()) < usdt(50_000)) await sdk.fundVault(usdt(500_000));
  }

  const env: PerpEnv = {
    usdtMint: sdk.usdtMint!.toBase58(),
    market: market.toBase58(),
    xmssRoot,
    decimals,
  };
  fs.writeFileSync(PERP_ENV, JSON.stringify(env, null, 2));
  return env;
}
