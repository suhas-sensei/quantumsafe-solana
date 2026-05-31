import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { AgentSDK } from "../agent/sdk";
import { SignerClient } from "../agent/signer/client";
import { runSwap, TokenRegistry } from "../agent/pipeline";
import { DEFAULT_POLICY } from "../agent/policy";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const wasm = require("../wasm/pkg-node/porst_wasm.js");

const SOL = anchor.web3.LAMPORTS_PER_SOL;
const pkHex = (p: PublicKey) => Buffer.from(p.toBytes()).toString("hex");
const now = () => Math.floor(Date.now() / 1000);

describe("porst_agent (post-quantum authorized DeFi)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const porstAgent = anchor.workspace.porstAgent as Program;
  const cpswap = anchor.workspace.cpswap as Program;

  const sdk = new AgentSDK(porstAgent, cpswap, provider);
  const keystorePath = path.join(__dirname, "..", ".tmp-agent-keystore.json");
  const socketPath = path.join(os.tmpdir(), `porst-signer-${process.pid}.sock`);

  let signer: SignerClient;
  let pool: Awaited<ReturnType<AgentSDK["setupPool"]>>;
  let tokenA: PublicKey;
  let tokenB: PublicKey;
  let registry: TokenRegistry;
  let xmssRoot: string;

  before(async () => {
    const cli = path.join(__dirname, "..", "wasm", "pkg-node", "porst_wasm.js");
    assert.isTrue(fs.existsSync(cli), "build wasm first: wasm-pack build wasm --target nodejs --out-dir pkg-node --release");

    const sig = await provider.connection.requestAirdrop(provider.wallet.publicKey, 100 * SOL);
    const bh = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");

    // Keystore (the seed) is written once; only the signer daemon reads it.
    const ks = wasm.keygen("22".repeat(32));
    fs.writeFileSync(keystorePath, ks);
    xmssRoot = wasm.wallet_pubkey(ks);
    signer = await SignerClient.spawn(keystorePath, socketPath, { autoApprove: false });
    assert.equal(await signer.walletPubkey(), xmssRoot, "signer exposes the wallet pubkey, not the seed");

    // Real token environment + a real cpswap pool with 1000:1000 liquidity.
    tokenA = await sdk.createToken(9);
    tokenB = await sdk.createToken(9);
    pool = await sdk.setupPool(tokenA, tokenB, 1_000n * 10n ** 9n, 1_000n * 10n ** 9n);
    registry = {
      AAA: { symbol: "AAA", mint: tokenA, decimals: 9 },
      BBB: { symbol: "BBB", mint: tokenB, decimals: 9 },
    };

    await sdk.createAgent(xmssRoot);
    await sdk.ensureAgentAta(tokenA);
    await sdk.ensureAgentAta(tokenB);
    await sdk.fundAgent(tokenA, 100n * 10n ** 9n); // fund the agent with 100 AAA
  });

  after(() => {
    signer?.kill();
    if (fs.existsSync(keystorePath)) fs.unlinkSync(keystorePath);
  });

  // ---- helper for adversarial on-chain cases (bypasses pipeline freshness) ----
  async function signManual(
    amountIn: bigint,
    minOut: bigint,
    expiry: number,
    over: Partial<{ nonce: number }> = {}
  ): Promise<string> {
    const st = await sdk.agentState();
    const res = await signer.signSwap({
      epoch: st.epoch,
      nonce: over.nonce ?? st.nonce,
      inputMint: pkHex(tokenA),
      outputMint: pkHex(tokenB),
      amountIn: Number(amountIn),
      minOut: Number(minOut),
      routeHash: sdk.routeHash(pool),
      expiry,
      summary: "manual",
      approve: true,
    });
    assert.isTrue(res.approved && !!res.signature);
    return res.signature!;
  }

  it("isolated signer never exposes the seed", async () => {
    const status: any = await signer.status();
    assert.equal(status.pubkey, xmssRoot);
    assert.notProperty(status, "seed");
  });

  it("executes a PORST-authorized swap end-to-end", async () => {
    const agentB = getAssociatedTokenAddressSync(tokenB, sdk.agentPda(), true);
    const beforeB = await sdk.balance(agentB);

    const r = await runSwap(sdk, signer, DEFAULT_POLICY(), registry, pool, "swap 1 AAA to BBB", {
      now: now(),
      slippageBps: 100,
      approve: true,
    });

    assert.equal(r.status, "executed", r.reason);
    assert.isTrue((r.received ?? 0n) > 0n, "agent received output tokens");
    const afterB = await sdk.balance(agentB);
    assert.equal(afterB - beforeB, r.received);

    const st = await sdk.agentState();
    assert.equal(st.nonce, 1, "nonce advanced -> replay protection");
    assert.equal(st.used, 1);
  });

  it("policy rejects an over-limit swap before any signature is requested", async () => {
    const policy = DEFAULT_POLICY({
      limits: { maxAmountInPerTx: 500_000_000n, maxAmountInDaily: 10n ** 18n, maxSlippageBps: 100, maxExpirySeconds: 300 },
    } as any);
    const r = await runSwap(sdk, signer, policy, registry, pool, "swap 1 AAA to BBB", { now: now(), approve: true });
    assert.equal(r.status, "rejected");
    assert.match(r.reason!, /exceeds per-tx limit/);
  });

  it("policy rejects excessive slippage", async () => {
    const policy = DEFAULT_POLICY({
      limits: { maxAmountInPerTx: 10n ** 18n, maxAmountInDaily: 10n ** 18n, maxSlippageBps: 10, maxExpirySeconds: 300 },
    } as any);
    const r = await runSwap(sdk, signer, policy, registry, pool, "swap 1 AAA to BBB", {
      now: now(),
      slippageBps: 80,
      approve: true,
    });
    assert.equal(r.status, "rejected");
    assert.match(r.reason!, /slippage/);
  });

  it("rejects an expired intent on-chain", async () => {
    const sig = await signManual(10n ** 9n, 1n, now() - 100);
    const buffer = await sdk.stageSignature(sig);
    let failed = false;
    try {
      await sdk.executeSwap({ p: pool, inputMint: tokenA, outputMint: tokenB, amountIn: 10n ** 9n, minOut: 1n, expiry: now() - 100, buffer });
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "expired intent must be rejected");
  });

  it("rejects a tampered signature on-chain", async () => {
    const exp = now() + 120;
    const sig = await signManual(10n ** 9n, 1n, exp);
    const bytes = Buffer.from(sig, "hex");
    bytes[300] ^= 0xff;
    const buffer = await sdk.stageSignature(bytes.toString("hex"));
    let failed = false;
    try {
      await sdk.executeSwap({ p: pool, inputMint: tokenA, outputMint: tokenB, amountIn: 10n ** 9n, minOut: 1n, expiry: exp, buffer });
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "tampered signature must be rejected");
  });

  it("rejects a swap whose min_out cannot be met (slippage)", async () => {
    const exp = now() + 120;
    // Demand far more output than the pool can give for 1 AAA.
    const minOut = 10n ** 12n;
    const sig = await signManual(10n ** 9n, minOut, exp);
    const buffer = await sdk.stageSignature(sig);
    let failed = false;
    try {
      await sdk.executeSwap({ p: pool, inputMint: tokenA, outputMint: tokenB, amountIn: 10n ** 9n, minOut, expiry: exp, buffer });
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "unmeetable min_out must be rejected");
  });

  it("rejects replay of a used signature (nonce advanced)", async () => {
    const exp = now() + 120;
    const st0 = await sdk.agentState();
    const sig = await signManual(10n ** 9n, 1n, exp); // signed at current nonce
    const buf1 = await sdk.stageSignature(sig);
    await sdk.executeSwap({ p: pool, inputMint: tokenA, outputMint: tokenB, amountIn: 10n ** 9n, minOut: 1n, expiry: exp, buffer: buf1 });
    const st1 = await sdk.agentState();
    assert.equal(st1.nonce, st0.nonce + 1);

    // Same signature again — nonce has moved, so the digest no longer matches.
    const buf2 = await sdk.stageSignature(sig);
    let failed = false;
    try {
      await sdk.executeSwap({ p: pool, inputMint: tokenA, outputMint: tokenB, amountIn: 10n ** 9n, minOut: 1n, expiry: exp, buffer: buf2 });
    } catch {
      failed = true;
    }
    assert.isTrue(failed, "replayed signature must be rejected");
  });
});
