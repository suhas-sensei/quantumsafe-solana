/**
 * Boots a realistic local DeFi environment for the demo: two SPL tokens
 * (test "SOL" and "USDC"), a real cpswap pool priced ~150 USDC/SOL, the agent
 * wallet, its token accounts, and a starting balance. Idempotent where it can
 * be; the wallet keystore is persisted so the agent's XMSS root is stable across
 * restarts.
 */
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";
import { AgentSDK, PoolInfo } from "./sdk";
import { TokenRegistry } from "./pipeline";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const wasm = require("../wasm/pkg-node/porst_wasm.js");

export const DEMO_DIR = path.join(__dirname, ".demo");
export const KEYSTORE_PATH = path.join(DEMO_DIR, "keystore.json");

export interface DemoEnv {
  pool: PoolInfo;
  registry: TokenRegistry;
  tokens: { symbol: string; mint: string; decimals: number }[];
  keystorePath: string;
  xmssRoot: string;
}

/** Create the persisted keystore once; reuse it afterwards. */
export function ensureKeystore(): { ks: string; xmssRoot: string } {
  fs.mkdirSync(DEMO_DIR, { recursive: true });
  let ks: string;
  if (fs.existsSync(KEYSTORE_PATH)) {
    ks = fs.readFileSync(KEYSTORE_PATH, "utf8");
  } else {
    const seed = wasm.random_seed_hex();
    ks = wasm.keygen(seed);
    fs.writeFileSync(KEYSTORE_PATH, ks);
  }
  return { ks, xmssRoot: wasm.wallet_pubkey(ks) };
}

const pow10 = (n: number): bigint => {
  let r = 1n;
  for (let i = 0; i < n; i++) r *= 10n;
  return r;
};

export async function bootstrap(sdk: AgentSDK): Promise<DemoEnv> {
  const { xmssRoot } = ensureKeystore();

  // Tokens: test "SOL" (9 dp) and test "USDC" (6 dp).
  const decSOL = 9;
  const decUSDC = 6;
  const sol = await sdk.createToken(decSOL);
  const usdc = await sdk.createToken(decUSDC);

  // Pool priced ~150 USDC / SOL.
  const liqSOL = 1_000n * pow10(decSOL);
  const liqUSDC = 150_000n * pow10(decUSDC);
  const pool = await sdk.setupPool(sol, usdc, liqSOL, liqUSDC);

  // Agent (create once; reuse if it already exists on this validator).
  const agentPda = sdk.agentPda();
  const exists = await sdk.conn.getAccountInfo(agentPda);
  if (!exists) {
    await sdk.createAgent(xmssRoot);
  }

  await sdk.ensureAgentAta(sol);
  await sdk.ensureAgentAta(usdc);
  await sdk.fundAgent(sol, 10n * pow10(decSOL)); // 10 test-SOL
  await sdk.fundAgent(usdc, 1_000n * pow10(decUSDC)); // 1000 test-USDC

  const registry: TokenRegistry = {
    SOL: { symbol: "SOL", mint: sol, decimals: decSOL },
    USDC: { symbol: "USDC", mint: usdc, decimals: decUSDC },
  };
  const tokens = [
    { symbol: "SOL", mint: sol.toBase58(), decimals: decSOL },
    { symbol: "USDC", mint: usdc.toBase58(), decimals: decUSDC },
  ];

  return { pool, registry, tokens, keystorePath: KEYSTORE_PATH, xmssRoot };
}

/** Helper: format a base-unit bigint to a human string for a given decimals. */
export function fmt(amount: bigint, decimals: number): string {
  const d = pow10(decimals);
  const whole = amount / d;
  const frac = amount % d;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
}

export { PublicKey };
