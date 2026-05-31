/**
 * End-to-end test of the PORST perpetual-futures engine on a local validator.
 *
 *   open (real Pyth price, PORST-signed) -> profit close -> liquidation -> SL/TP
 *
 * Opens at the live SOL/USD price from Pyth Hermes (real data). For the PnL /
 * liquidation / trigger assertions it then moves the on-chain mark price
 * deterministically (the keeper does this from real ticks in production; here we
 * drive it so the math is checkable). Signs with a dedicated perp PQ keystore via
 * the WASM signer — the same crypto the on-chain program verifies against.
 *
 * Run against a local validator with porst_perp deployed:
 *   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   yarn ts-node agent/perp-e2e.ts
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import { PerpSDK, SIDE_LONG, PRICE_SCALE } from "./perp";
import { fetchSolPrice } from "./oracle";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const wasm = require("../wasm/pkg-node/porst_wasm.js");

const ROOT = path.join(__dirname, "..");
const RPC = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
const PERP_KEYSTORE = path.join(__dirname, ".demo", "perp-keystore.json");

const usdt = (n: number) => BigInt(Math.round(n * 1e6));
const fromUsdt = (b: bigint) => Number(b) / 1e6;
const px = (human: number) => BigInt(Math.round(human * PRICE_SCALE));
const now = () => Math.floor(Date.now() / 1000);

function loadWallet(): Keypair {
  const p = process.env.ANCHOR_WALLET || path.join(os.homedir(), ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}
function loadProgram(name: string, provider: anchor.AnchorProvider): anchor.Program {
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "target", "idl", `${name}.json`), "utf8"));
  return new anchor.Program(idl, provider);
}
function ensurePerpKeystore(): string {
  fs.mkdirSync(path.dirname(PERP_KEYSTORE), { recursive: true });
  if (!fs.existsSync(PERP_KEYSTORE)) {
    fs.writeFileSync(PERP_KEYSTORE, wasm.keygen(wasm.random_seed_hex()));
  }
  return fs.readFileSync(PERP_KEYSTORE, "utf8");
}

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label} ${detail}`);
  } else {
    fail++;
    console.log(`  ✗ ${label} ${detail}`);
  }
}

async function signOpen(ks: string, sdk: PerpSDK, a: any): Promise<string> {
  const t = await sdk.traderState();
  const marketHex = Buffer.from(sdk.marketPda().toBytes()).toString("hex");
  const out = JSON.parse(
    wasm.sign_open_perp(
      ks, t.epoch, t.nonce, marketHex, a.side, Number(a.collateral), a.leverage,
      Number(a.maxEntryPrice), Number(a.slPrice), Number(a.tpPrice), a.expiry
    )
  );
  return out.signature;
}
async function signClose(ks: string, sdk: PerpSDK, seq: number, expiry: number): Promise<string> {
  const t = await sdk.traderState();
  const posHex = Buffer.from(sdk.positionPda(seq).toBytes()).toString("hex");
  const out = JSON.parse(wasm.sign_close_perp(ks, t.epoch, t.nonce, posHex, expiry));
  return out.signature;
}

async function openAndStage(ks: string, sdk: PerpSDK, a: any): Promise<number> {
  const t = await sdk.traderState();
  const seq = t.positionCount;
  const sig = await signOpen(ks, sdk, a);
  const buffer = await sdk.stageSignature(sig);
  await sdk.openPosition({ ...a, seq, buffer });
  return seq;
}

async function main() {
  console.log("» perp e2e against", RPC);
  const conn = new Connection(RPC, "confirmed");
  const wallet = new anchor.Wallet(loadWallet());
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });

  // Fund the fee payer on localnet.
  if (/127\.0\.0\.1|localhost/.test(RPC)) {
    const bal = await conn.getBalance(wallet.publicKey);
    if (bal < 50 * anchor.web3.LAMPORTS_PER_SOL) {
      const sig = await conn.requestAirdrop(wallet.publicKey, 100 * anchor.web3.LAMPORTS_PER_SOL);
      const bh = await conn.getLatestBlockhash();
      await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    }
  }

  const perp = loadProgram("porst_perp", provider);
  const sdk = new PerpSDK(perp, provider);
  const ks = ensurePerpKeystore();
  const xmssRoot = wasm.wallet_pubkey(ks);

  // ---- bootstrap ----
  console.log("\n[1] bootstrap: USDT mint, oracle, market, trader, liquidity");
  await sdk.createUsdt(6);
  await sdk.initOracle();
  const live = await fetchSolPrice();
  await sdk.updateOracle(live.price, now()); // post real price, fresh timestamp
  console.log(`    live SOL/USD = $${live.human.toFixed(4)} (real, from Pyth Hermes)`);
  await sdk.initMarket({ maintenanceBps: 500, maxLeverage: 20, openFeeBps: 10, borrowFeeBpsPerHour: 1 });
  await sdk.createTrader(xmssRoot);
  await sdk.ensureTraderUsdt();
  await sdk.fundTrader(usdt(10_000)); // trader capital
  await sdk.fundVault(usdt(500_000)); // LP float (counterparty)
  check("trader funded", (await sdk.traderBalance()) === usdt(10_000), `${fromUsdt(await sdk.traderBalance())} USDT`);
  check("vault seeded", (await sdk.vaultBalance()) === usdt(500_000));

  const entry = live.price;

  // ---- (A) PORST-signed long, then close in profit at +10% ----
  console.log("\n[2] open 5x LONG (PORST-authorized), close at +10%");
  const balBefore = await sdk.traderBalance();
  const seqA = await openAndStage(ks, sdk, {
    side: SIDE_LONG,
    collateral: usdt(250),
    leverage: 5,
    maxEntryPrice: (entry * 105n) / 100n,
    slPrice: 0n,
    tpPrice: 0n,
    expiry: now() + 120,
  });
  let posA = (await sdk.openPositions()).find((p) => p.seq === seqA)!;
  check("position opened", !!posA, `notional ${fromUsdt(posA.notional)} USDT @ $${fromUsdt(posA.entryPrice).toFixed(4)}`);
  check("collateral locked", (await sdk.traderBalance()) === balBefore - usdt(250));

  // Move mark +10% and close.
  const up = (entry * 110n) / 100n;
  await sdk.updateOracle(up, now());
  const expC = now() + 120;
  const sigC = await signClose(ks, sdk, seqA, expC);
  const bufC = await sdk.stageSignature(sigC);
  const balPreClose = await sdk.traderBalance();
  await sdk.closePosition({ seq: seqA, expiry: expC, buffer: bufC });
  const gained = (await sdk.traderBalance()) - balPreClose;
  // expected payout = collateral(250) + pnl(125) - openFee(0.1% of 1250 = 1.25) ≈ 373.75
  check("closed in profit", gained > usdt(370) && gained < usdt(375), `payout ${fromUsdt(gained)} USDT`);
  check("position gone", !(await sdk.openPositions()).some((p) => p.seq === seqA));

  // ---- (B) liquidation: 10x long, mark drops ~9.5% ----
  console.log("\n[3] open 10x LONG, drop mark ~9.5% -> liquidation");
  await sdk.updateOracle(entry, now()); // reset mark to entry
  const seqB = await openAndStage(ks, sdk, {
    side: SIDE_LONG,
    collateral: usdt(200),
    leverage: 10,
    maxEntryPrice: (entry * 105n) / 100n,
    slPrice: 0n,
    tpPrice: 0n,
    expiry: now() + 120,
  });
  const down = (entry * 905n) / 1000n; // -9.5%
  await sdk.updateOracle(down, now());
  const balPreLiq = await sdk.traderBalance();
  await sdk.maintain("liquidate", seqB);
  const liqRemainder = (await sdk.traderBalance()) - balPreLiq;
  check("liquidated", !(await sdk.openPositions()).some((p) => p.seq === seqB), `remainder ${fromUsdt(liqRemainder)} USDT`);
  check("remainder small but >= 0", liqRemainder >= 0n && liqRemainder < usdt(40));

  // ---- (C) take-profit trigger: long with TP, mark rises past it ----
  console.log("\n[4] open 3x LONG with take-profit, mark rises past TP -> trigger");
  await sdk.updateOracle(entry, now());
  const tp = (entry * 108n) / 100n;
  const seqC = await openAndStage(ks, sdk, {
    side: SIDE_LONG,
    collateral: usdt(300),
    leverage: 3,
    maxEntryPrice: (entry * 105n) / 100n,
    slPrice: 0n,
    tpPrice: tp,
    expiry: now() + 120,
  });
  await sdk.updateOracle((entry * 109n) / 100n, now()); // above TP
  const balPreTp = await sdk.traderBalance();
  await sdk.maintain("trigger", seqC);
  const tpGain = (await sdk.traderBalance()) - balPreTp;
  // pnl at +9% on 900 notional = +81; payout ≈ 300 + 81 - fees ≈ 380
  check("take-profit fired", !(await sdk.openPositions()).some((p) => p.seq === seqC), `payout ${fromUsdt(tpGain)} USDT`);
  check("tp paid profit", tpGain > usdt(378) && tpGain < usdt(381));

  // restore a fresh real price for any downstream demo use
  const fresh = await fetchSolPrice();
  await sdk.updateOracle(fresh.price, now());

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
