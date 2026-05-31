// Proves the WASM signer is byte-for-byte identical to the native porst-signer
// CLI (the implementation the on-chain program is verified against). If these
// match, signatures produced in the browser verify on-chain unchanged.
const wasm = require("./pkg-node/porst_wasm.js");
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const assert = require("assert");

const CLI = path.join(__dirname, "..", "target", "release", "porst-signer");
const SEED = "11".repeat(32);
const RECIPIENT = "aa".repeat(32);
const EPOCH = 0, NONCE = 0, AMOUNT = 1000000;

console.log("params:", { lifetime: wasm.lifetime_capacity(), epochs: wasm.num_epochs(), perEpoch: wasm.signing_capacity() });

// 1) keygen parity
const t0 = Date.now();
const ksJson = wasm.keygen(SEED);
console.log(`wasm keygen: ${Date.now() - t0} ms`);
const wasmRoot = wasm.wallet_pubkey(ksJson);

const cliKs = JSON.parse(
  execFileSync(CLI, ["keygen", "--seed", SEED], { encoding: "utf8" })
);
assert.strictEqual(wasmRoot, cliKs.xmss_root, "xmss_root must match CLI");
console.log("✓ keygen parity — xmss_root:", wasmRoot);

// 2) signature parity (deterministic salts => identical bytes)
const wasmSig = JSON.parse(wasm.sign_transfer(ksJson, EPOCH, NONCE, RECIPIENT, AMOUNT));
const ksPath = path.join(os.tmpdir(), "parity-ks.json");
fs.writeFileSync(ksPath, JSON.stringify(cliKs));
const cliSig = JSON.parse(
  execFileSync(CLI, [
    "sign", "--keystore", ksPath,
    "--epoch", String(EPOCH), "--nonce", String(NONCE),
    "--recipient", RECIPIENT, "--amount", String(AMOUNT),
  ], { encoding: "utf8" })
);
fs.unlinkSync(ksPath);
assert.strictEqual(wasmSig.digest, cliSig.digest, "digest must match CLI");
assert.strictEqual(wasmSig.signature, cliSig.signature, "signature bytes must match CLI");
console.log(`✓ signature parity — ${wasmSig.signature.length / 2} bytes identical`);

// 3) self-verify, and reject tamper / wrong amount
assert.strictEqual(
  wasm.verify_transfer(wasmRoot, EPOCH, NONCE, RECIPIENT, AMOUNT, wasmSig.signature),
  true, "valid signature must verify"
);
const bad = wasmSig.signature.slice(0, 400) + (wasmSig.signature[400] === "f" ? "0" : "f") + wasmSig.signature.slice(401);
assert.strictEqual(
  wasm.verify_transfer(wasmRoot, EPOCH, NONCE, RECIPIENT, AMOUNT, bad),
  false, "tampered signature must be rejected"
);
assert.strictEqual(
  wasm.verify_transfer(wasmRoot, EPOCH, NONCE, RECIPIENT, AMOUNT + 1, wasmSig.signature),
  false, "amount-substituted signature must be rejected"
);
console.log("✓ verify accepts valid, rejects tampered + amount-substituted");

console.log("\nALL WASM PARITY CHECKS PASSED");
