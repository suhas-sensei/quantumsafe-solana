import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { assert } from "chai";
import * as path from "path";
import * as fs from "fs";
import { PorstWallet } from "../app/porstWallet";

const CLI = path.join(__dirname, "..", "target", "release", "porst-signer");
const KEYSTORE = path.join(__dirname, "..", ".tmp-keystore.json");
const SOL = anchor.web3.LAMPORTS_PER_SOL;

describe("porst_wallet (post-quantum many-time wallet)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.porstWallet as Program;

  let pw: PorstWallet;

  before(async () => {
    assert.isTrue(fs.existsSync(CLI), `signer CLI not built at ${CLI} (run: cargo build -p porst-signer --release)`);

    const sig = await provider.connection.requestAirdrop(provider.wallet.publicKey, 100 * SOL);
    const bh = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");

    // Deterministic seed for reproducibility.
    const seedHex = "11".repeat(32);
    pw = PorstWallet.keygen(program, provider, CLI, KEYSTORE, seedHex);
    await pw.createWallet();
    await pw.fundVault(10 * SOL);
  });

  after(() => {
    if (fs.existsSync(KEYSTORE)) fs.unlinkSync(KEYSTORE);
  });

  it("creates a wallet pinned to the XMSS root with zeroed state", async () => {
    const s = await pw.getState();
    assert.equal(s.xmssRoot, pw.xmssRoot());
    assert.equal(s.epoch, 0n);
    assert.equal(s.used, 0n);
    assert.equal(s.nonce, 0n);
  });

  it("authorizes a SOL transfer with a valid PQ signature", async () => {
    const recipient = Keypair.generate().publicKey;
    const amount = 1 * SOL;
    const before = await provider.connection.getBalance(recipient);
    await pw.transfer(recipient, amount);
    const after = await provider.connection.getBalance(recipient);
    assert.equal(after - before, amount, "recipient should receive the transfer");

    const s = await pw.getState();
    assert.equal(s.nonce, 1n, "nonce advances");
    assert.equal(s.used, 1n, "epoch usage advances");
    assert.equal(s.epoch, 0n);
  });

  it("rejects replay of a previously used signature", async () => {
    const recipient = Keypair.generate().publicKey;
    const amount = 1 * SOL;
    // Sign at the CURRENT state, then advance the chain by executing it once.
    const state = await pw.getState();
    const { signature } = pw.signTransfer(state, recipient, amount);
    const buffer = await pw.stageSignature(signature);
    await pw.executeTransfer(recipient, amount, buffer);

    // The nonce has advanced; the same (now-stale) signature must not replay.
    const buffer2 = await pw.stageSignature(signature);
    let replayed = false;
    try {
      await pw.executeTransfer(recipient, amount, buffer2);
      replayed = true;
    } catch (_e) {
      /* expected */
    }
    assert.isFalse(replayed, "stale-nonce signature must be rejected");
  });

  it("rejects a tampered signature", async () => {
    const recipient = Keypair.generate().publicKey;
    const amount = 1 * SOL;
    const state = await pw.getState();
    const { signature } = pw.signTransfer(state, recipient, amount);
    // flip a byte in the witness stream
    const bytes = Buffer.from(signature, "hex");
    bytes[200] ^= 0xff;
    const buffer = await pw.stageSignature(bytes.toString("hex"));
    let ok = false;
    try {
      await pw.executeTransfer(recipient, amount, buffer);
      ok = true;
    } catch (_e) {
      /* expected */
    }
    assert.isFalse(ok, "tampered signature must be rejected");
  });

  it("rejects a signature that authorizes a different amount", async () => {
    const recipient = Keypair.generate().publicKey;
    const state = await pw.getState();
    const { signature } = pw.signTransfer(state, recipient, 1 * SOL);
    const buffer = await pw.stageSignature(signature);
    let ok = false;
    try {
      await pw.executeTransfer(recipient, 2 * SOL, buffer); // amount mismatch
      ok = true;
    } catch (_e) {
      /* expected */
    }
    assert.isFalse(ok, "amount-substituted signature must be rejected");
  });

  it("advances to the next epoch after SIGNING_CAPACITY signatures", async () => {
    // Drive the current epoch to exhaustion. SIGNING_CAPACITY = 16.
    const recipient = Keypair.generate().publicKey;
    const start = await pw.getState();
    const remaining = 16 - Number(start.used);
    for (let i = 0; i < remaining; i++) {
      await pw.transfer(recipient, 0.01 * SOL);
    }
    const s = await pw.getState();
    assert.equal(s.epoch, start.epoch + 1n, "epoch should roll over");
    assert.equal(s.used, 0n, "usage resets in the new epoch");

    // A signature under the new epoch still works (proves epoch switch is sound).
    const before = await provider.connection.getBalance(recipient);
    await pw.transfer(recipient, 0.01 * SOL);
    const after = await provider.connection.getBalance(recipient);
    assert.equal(after - before, 0.01 * SOL);
    const s2 = await pw.getState();
    assert.equal(s2.epoch, start.epoch + 1n);
    assert.equal(s2.used, 1n);
  });
});
