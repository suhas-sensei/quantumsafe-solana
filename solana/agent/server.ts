/**
 * Agent backend for the DeFi-user frontend.
 *
 * Boots a local DeFi environment, spawns the hardware-isolated PORST signer, and
 * exposes a small HTTP API:
 *   GET  /api/state      -> portfolio, price, agent state, signer/LLM info
 *   POST /api/interpret  -> natural language -> structured intent + plan + policy
 *   POST /api/execute    -> isolated PQ sign -> stage -> on-chain execute_swap
 *
 * The LLM only proposes; deterministic policy + the isolated signer + the
 * on-chain program enforce everything. Run against a local validator with the
 * programs deployed.
 */
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { AgentSDK } from "./sdk";
import { SignerClient } from "./signer/client";
import { planSwap, ParsedIntent } from "./pipeline";
import { checkSwap, Policy, DEFAULT_POLICY } from "./policy";
import { bootstrap, ensureKeystore, fmt, DemoEnv } from "./bootstrap";
import { interpret, llmProvider } from "./llm";
import { initPerp, PerpRoutes } from "./perp-routes";

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT || 8787);
const RPC = process.env.ANCHOR_PROVIDER_URL || "http://127.0.0.1:8899";
const SOCKET = path.join(os.tmpdir(), "porst-agent-signer.sock");

// Demo policy — generous enough for the demo amounts, still real.
const POLICY: Policy = DEFAULT_POLICY({
  limits: {
    maxAmountInPerTx: 1_000_000_000_000n, // 1000 SOL-base or 1,000,000 USDC-base
    maxAmountInDaily: 10_000_000_000_000n,
    maxSlippageBps: 200,
    maxExpirySeconds: 300,
  },
  allowlists: { tokens: [], protocols: [] },
} as any);

const pkHex = (p: PublicKey) => Buffer.from(p.toBytes()).toString("hex");
const TTL = 120;

let sdk: AgentSDK;
let signer: SignerClient;
let env: DemoEnv;
let perp: PerpRoutes;

function loadWallet(): Keypair {
  const p = process.env.ANCHOR_WALLET || path.join(os.homedir(), ".config/solana/id.json");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

function loadProgram(name: string, provider: anchor.AnchorProvider): anchor.Program {
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "target", "idl", `${name}.json`), "utf8"));
  return new anchor.Program(idl, provider);
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString();
  return s ? JSON.parse(s) : {};
}

function send(res: http.ServerResponse, code: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  });
  res.end(data);
}

// ---- domain helpers ----
function tokenBySym(sym: string) {
  return env.registry[sym];
}

/** Explorer query suffix for the active cluster, so UI tx links resolve correctly. */
function explorerSuffix(rpc: string): string {
  if (/devnet/.test(rpc)) return "?cluster=devnet";
  if (/testnet/.test(rpc)) return "?cluster=testnet";
  if (/127\.0\.0\.1|localhost/.test(rpc)) return `?cluster=custom&customUrl=${encodeURIComponent(rpc)}`;
  return ""; // mainnet-beta is the explorer default
}

async function getState() {
  const st = await sdk.agentState();
  const sol = env.registry.SOL;
  const usdc = env.registry.USDC;
  const solAta = getAssociatedTokenAddressSync(sol.mint, sdk.agentPda(), true);
  const usdcAta = getAssociatedTokenAddressSync(usdc.mint, sdk.agentPda(), true);
  const balSol = await sdk.balance(solAta);
  const balUsdc = await sdk.balance(usdcAta);
  // pool price (USDC per SOL)
  const va = await sdk.balance(env.pool.vaultA); // SOL vault
  const vb = await sdk.balance(env.pool.vaultB); // USDC vault
  const price = Number(vb) / 10 ** usdc.decimals / (Number(va) / 10 ** sol.decimals);

  return {
    walletPubkey: env.xmssRoot,
    agent: sdk.agentPda().toBase58(),
    epoch: st.epoch,
    used: st.used,
    nonce: st.nonce,
    lifetime: 256,
    remaining: (16 - st.epoch) * 16 - st.used,
    llm: llmProvider(),
    explorer: explorerSuffix(RPC),
    price: Number.isFinite(price) ? price : 0,
    balances: {
      SOL: { amount: fmt(balSol, sol.decimals), decimals: sol.decimals },
      USDC: { amount: fmt(balUsdc, usdc.decimals), decimals: usdc.decimals },
    },
    tokens: env.tokens,
  };
}

async function handleInterpret(message: string) {
  const interp = await interpret(message, Object.keys(env.registry));
  if (interp.kind === "chat") return { kind: "chat", reply: interp.reply };

  const parsed: ParsedIntent = {
    action: "swap",
    amount: interp.amount,
    inSym: interp.inSym,
    outSym: interp.outSym,
  };
  const now = Math.floor(Date.now() / 1000);
  const plan = await planSwap(sdk, env.registry, env.pool, parsed, {
    slippageBps: 50,
    ttlSeconds: TTL,
    now,
    protocol: sdk.cpswap.programId,
  });
  const decision = checkSwap(POLICY, plan.action, now);
  const inTok = tokenBySym(parsed.inSym);
  const outTok = tokenBySym(parsed.outSym);

  return {
    kind: "intent",
    summary: plan.summary,
    policy: decision.allowed
      ? { allowed: true, approvalMode: decision.approvalMode }
      : { allowed: false, reason: decision.reason },
    plan: {
      inSym: parsed.inSym,
      outSym: parsed.outSym,
      amountInHuman: parsed.amount,
      expectedOutHuman: Number(fmt(plan.expectedOut, outTok.decimals)),
      minOutHuman: Number(fmt(plan.action.minOut, outTok.decimals)),
      slippageBps: plan.action.slippageBps,
    },
    // echoed back verbatim to /api/execute so the signed digest matches exactly
    intent: {
      inputMint: inTok.mint.toBase58(),
      outputMint: outTok.mint.toBase58(),
      amountIn: plan.action.amountIn.toString(),
      minOut: plan.action.minOut.toString(),
      expiry: plan.action.expiry,
      inSym: parsed.inSym,
      outSym: parsed.outSym,
    },
  };
}

async function handleExecute(intent: any) {
  const stages: { name: string; detail: string }[] = [];
  const inputMint = new PublicKey(intent.inputMint);
  const outputMint = new PublicKey(intent.outputMint);
  const amountIn = BigInt(intent.amountIn);
  const minOut = BigInt(intent.minOut);
  const expiry = Number(intent.expiry);
  const outTok = tokenBySym(intent.outSym);

  // Re-check policy at execution time (defense in depth).
  const now = Math.floor(Date.now() / 1000);
  const decision = checkSwap(
    POLICY,
    {
      type: "swap",
      inputMint: intent.inputMint,
      outputMint: intent.outputMint,
      protocol: sdk.cpswap.programId.toBase58(),
      amountIn,
      minOut,
      slippageBps: 50,
      expiry,
    },
    now
  );
  if (!decision.allowed) throw new Error(`policy: ${decision.reason}`);

  const st = await sdk.agentState();
  stages.push({ name: "Read on-chain state", detail: `epoch ${st.epoch}, nonce ${st.nonce}` });

  const routeHash = sdk.routeHash(env.pool);
  stages.push({ name: "Bind route", detail: `route_hash ${routeHash.slice(0, 12)}…` });

  const signed = await signer.signSwap({
    epoch: st.epoch,
    nonce: st.nonce,
    inputMint: pkHex(inputMint),
    outputMint: pkHex(outputMint),
    amountIn: Number(amountIn),
    minOut: Number(minOut),
    routeHash,
    expiry,
    summary: `swap ${intent.inSym}->${intent.outSym}`,
    approve: true,
  });
  if (!signed.approved || !signed.signature) throw new Error(signed.reason || "signer declined");
  stages.push({
    name: "Isolated post-quantum signer",
    detail: `signed ${signed.signature.length / 2}-byte PORST signature (seed never left the signer)`,
  });

  const buffer = await sdk.stageSignature(signed.signature);
  stages.push({ name: "Stage signature on-chain", detail: `buffered into a program-owned account` });

  const agentOut = getAssociatedTokenAddressSync(outputMint, sdk.agentPda(), true);
  const before = await sdk.balance(agentOut);
  const txSig = await sdk.executeSwap({
    p: env.pool,
    inputMint,
    outputMint,
    amountIn,
    minOut,
    expiry,
    buffer,
  });
  const received = (await sdk.balance(agentOut)) - before;
  stages.push({ name: "Execute swap on-chain", detail: `tx ${txSig.slice(0, 16)}…` });
  stages.push({
    name: "Settled",
    detail: `received ${fmt(received, outTok.decimals)} ${intent.outSym}`,
  });

  return { stages, txSig, receivedHuman: fmt(received, outTok.decimals), state: await getState() };
}

// ---- static file serving (built frontend) ----
function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const dist = path.join(ROOT, "web", "dist");
  if (!fs.existsSync(dist)) return false;
  let rel = decodeURIComponent((req.url || "/").split("?")[0]);
  if (rel === "/") rel = "/index.html";
  const file = path.join(dist, rel);
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // SPA fallback
    const index = path.join(dist, "index.html");
    if (fs.existsSync(index)) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(fs.readFileSync(index));
      return true;
    }
    return false;
  }
  const ext = path.extname(file);
  const ct =
    { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".json": "application/json" }[ext] ||
    "application/octet-stream";
  res.writeHead(200, { "content-type": ct });
  res.end(fs.readFileSync(file));
  return true;
}

async function main() {
  console.log("» connecting to", RPC);
  const conn = new Connection(RPC, "confirmed");
  const wallet = new anchor.Wallet(loadWallet());
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });

  // fund the fee payer on localnet only; public clusters rate-limit airdrops (429)
  // and the fee payer is funded out-of-band there.
  if (/127\.0\.0\.1|localhost/.test(RPC)) {
    try {
      const sig = await conn.requestAirdrop(wallet.publicKey, 100 * anchor.web3.LAMPORTS_PER_SOL);
      const bh = await conn.getLatestBlockhash();
      await conn.confirmTransaction({ signature: sig, ...bh }, "confirmed");
    } catch {}
  } else {
    const bal = (await conn.getBalance(wallet.publicKey)) / anchor.web3.LAMPORTS_PER_SOL;
    console.log(`» fee payer ${wallet.publicKey.toBase58()} balance: ${bal} SOL`);
  }

  const porstAgent = loadProgram("porst_agent", provider);
  const cpswap = loadProgram("cpswap", provider);
  sdk = new AgentSDK(porstAgent, cpswap, provider);

  ensureKeystore();
  console.log("» spawning isolated signer");
  signer = await SignerClient.spawn(path.join(ROOT, "agent", ".demo", "keystore.json"), SOCKET, {
    autoApprove: true,
  });

  console.log("» bootstrapping demo environment (tokens, pool, agent)…");
  env = await bootstrap(sdk);
  console.log("» ready. wallet pubkey (xmss_root):", env.xmssRoot);
  console.log("» LLM provider:", llmProvider());

  // Perp engine: separate isolated signer, on-chain market, real-price keeper.
  perp = await initPerp({
    program: loadProgram("porst_perp", provider),
    provider,
    explorer: explorerSuffix(RPC),
  });

  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") return send(res, 204, {});
    try {
      const url = (req.url || "").split("?")[0];
      if (req.method === "GET" && url === "/api/state") return send(res, 200, await getState());
      if (req.method === "POST" && url === "/api/interpret") {
        const { message } = await readBody(req);
        return send(res, 200, await handleInterpret(String(message || "")));
      }
      if (req.method === "POST" && url === "/api/execute") {
        const { intent } = await readBody(req);
        return send(res, 200, await handleExecute(intent));
      }
      // ---- perp engine ----
      if (req.method === "GET" && url === "/api/perp/state") return send(res, 200, await perp.perpState());
      if (req.method === "POST" && url === "/api/perp/chat") return send(res, 200, await perp.perpChat(await readBody(req)));
      if (req.method === "POST" && url === "/api/perp/open") return send(res, 200, await perp.perpOpen(await readBody(req)));
      if (req.method === "POST" && url === "/api/perp/close") return send(res, 200, await perp.perpClose(await readBody(req)));
      if (req.method === "GET" && serveStatic(req, res)) return;
      send(res, 404, { error: "not found" });
    } catch (e: any) {
      send(res, 500, { error: String(e?.message || e) });
    }
  });
  server.listen(PORT, () => console.log(`» agent API on http://127.0.0.1:${PORT}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
