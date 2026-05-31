import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Porst } from "../target/types/porst";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { assert } from "chai";
import * as fs from "fs";
import * as path from "path";

// Test vectors are produced by the Rust reference signer (the same code the
// on-chain verifier's logic is unit-tested against):
//   cargo test -p porst emit_vectors -- --ignored --nocapture
const vectors = JSON.parse(
  fs.readFileSync(path.join(__dirname, "vectors.json"), "utf8")
);

const hexToBytes = (h: string): number[] => {
  const out: number[] = [];
  for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
  return out;
};
const hexTo32 = (h: string): number[] => hexToBytes(h);

describe("porst", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.porst as Program<Porst>;

  const CHUNK = 960; // bytes per write_buffer tx (keeps us under the 1232-byte tx cap)

  before(async () => {
    // Fund the provider wallet for the (many) account rents these tests create.
    const sig = await provider.connection.requestAirdrop(
      provider.wallet.publicKey,
      100 * anchor.web3.LAMPORTS_PER_SOL
    );
    const bh = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction(
      { signature: sig, ...bh },
      "confirmed"
    );
  });

  /** Create a program-owned raw account of exactly `space` bytes (client-side
   * createAccount can allocate far beyond the 10 KB CPI limit). */
  async function createBuffer(space: number): Promise<Keypair> {
    const buf = Keypair.generate();
    const lamports = await provider.connection.getMinimumBalanceForRentExemption(
      space
    );
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: provider.wallet.publicKey,
        newAccountPubkey: buf.publicKey,
        lamports,
        space,
        programId: program.programId,
      })
    );
    await provider.sendAndConfirm(tx, [buf]);
    return buf;
  }

  /** Fill a buffer account with `bytes` via chunked write_buffer instructions. */
  async function fillBuffer(buffer: PublicKey, bytes: number[]) {
    for (let off = 0; off < bytes.length; off += CHUNK) {
      const chunk = bytes.slice(off, off + CHUNK);
      await program.methods
        .writeBuffer(off, Buffer.from(chunk))
        .accounts({ buffer, authority: provider.wallet.publicKey })
        .rpc();
    }
  }

  /** Create a verifier account pinned to `root` (hex). */
  async function makeVerifier(rootHex: string): Promise<Keypair> {
    const verifier = Keypair.generate();
    await program.methods
      .initialize(hexTo32(rootHex))
      .accounts({
        verifier: verifier.publicKey,
        authority: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([verifier])
      .rpc();
    return verifier;
  }

  /** Run verify(hash) against (verifier, buffer); returns true on success. */
  async function tryVerify(
    verifier: PublicKey,
    buffer: PublicKey,
    hashHex: string
  ): Promise<boolean> {
    try {
      await program.methods
        .verify(hexTo32(hashHex))
        .accounts({ verifier, buffer })
        .preInstructions([
          ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
        ])
        .rpc();
      return true;
    } catch (_e) {
      return false;
    }
  }

  // ---- valid signatures (one per emitted vector) ----
  for (const c of vectors.cases) {
    it(`accepts a valid signature: ${c.name}`, async () => {
      const sig = hexToBytes(c.sig);
      const verifier = await makeVerifier(vectors.root);
      const buffer = await createBuffer(sig.length);
      await fillBuffer(buffer.publicKey, sig);
      assert.isTrue(
        await tryVerify(verifier.publicKey, buffer.publicKey, c.hash),
        "expected valid signature to verify"
      );
    });
  }

  // The remaining negative tests reuse the first vector.
  const base = vectors.cases[0];

  it("rejects when the message hash is wrong", async () => {
    const sig = hexToBytes(base.sig);
    const verifier = await makeVerifier(vectors.root);
    const buffer = await createBuffer(sig.length);
    await fillBuffer(buffer.publicKey, sig);
    assert.isFalse(
      await tryVerify(verifier.publicKey, buffer.publicKey, vectors.wrongHash)
    );
  });

  it("rejects against a verifier with the wrong root", async () => {
    const sig = hexToBytes(base.sig);
    const verifier = await makeVerifier(vectors.wrongRoot);
    const buffer = await createBuffer(sig.length);
    await fillBuffer(buffer.publicKey, sig);
    assert.isFalse(
      await tryVerify(verifier.publicKey, buffer.publicKey, base.hash)
    );
  });

  it("rejects a corrupted witness", async () => {
    const sig = hexToBytes(base.sig);
    sig[100] ^= 0xff; // flip a byte inside the witness stream
    const verifier = await makeVerifier(vectors.root);
    const buffer = await createBuffer(sig.length);
    await fillBuffer(buffer.publicKey, sig);
    assert.isFalse(
      await tryVerify(verifier.publicKey, buffer.publicKey, base.hash)
    );
  });

  it("rejects a truncated signature", async () => {
    const full = hexToBytes(base.sig);
    const sig = full.slice(0, full.length - 32);
    const verifier = await makeVerifier(vectors.root);
    const buffer = await createBuffer(sig.length);
    await fillBuffer(buffer.publicKey, sig);
    assert.isFalse(
      await tryVerify(verifier.publicKey, buffer.publicKey, base.hash)
    );
  });

  it("rejects a signature with extra trailing bytes", async () => {
    const sig = hexToBytes(base.sig).concat(new Array(32).fill(0));
    const verifier = await makeVerifier(vectors.root);
    const buffer = await createBuffer(sig.length);
    await fillBuffer(buffer.publicKey, sig);
    assert.isFalse(
      await tryVerify(verifier.publicKey, buffer.publicKey, base.hash)
    );
  });

  it("rejects a salt-only (no witnesses) signature", async () => {
    const sig = hexToBytes(base.sig).slice(0, 32);
    const verifier = await makeVerifier(vectors.root);
    const buffer = await createBuffer(sig.length);
    await fillBuffer(buffer.publicKey, sig);
    assert.isFalse(
      await tryVerify(verifier.publicKey, buffer.publicKey, base.hash)
    );
  });
});
