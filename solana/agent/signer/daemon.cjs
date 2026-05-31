#!/usr/bin/env node
/**
 * Isolated PORST signer daemon — the post-quantum "hardware boundary".
 *
 * This is a SEPARATE PROCESS from the agent/LLM. It is the only place the wallet
 * seed ever lives. It speaks newline-delimited JSON over a Unix domain socket and
 * exposes a schema-strict surface: it will sign a *swap intent* (typed fields)
 * and nothing else. It never returns the seed, never signs arbitrary bytes, and
 * never executes model output. The agent core sends an intent + a human-readable
 * summary; the daemon (optionally gated on approval) returns a signature.
 *
 * Mirrors maki's signer split (LLM | deterministic core | isolated signer over
 * schema-strict IPC), with the WASM PORST signer as the key-bearing backend.
 *
 * Usage: node daemon.cjs --keystore <path> --socket <unix-socket-path> [--auto-approve]
 */
const net = require("net");
const fs = require("fs");
const path = require("path");
const wasm = require(path.join(__dirname, "..", "..", "wasm", "pkg-node", "porst_wasm.js"));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      out[k] = v;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.keystore || !args.socket) {
  console.error("usage: daemon.cjs --keystore <path> --socket <path> [--auto-approve]");
  process.exit(2);
}

// The seed lives ONLY here, in this process's memory.
const keystore = fs.readFileSync(args.keystore, "utf8");
const pubkey = wasm.wallet_pubkey(keystore);
const autoApprove = args["auto-approve"] === "true" || args["auto-approve"] === true;

const SWAP_FIELDS = [
  "epoch", "nonce", "inputMint", "outputMint", "amountIn", "minOut", "routeHash", "expiry", "summary",
];
const OPEN_PERP_FIELDS = [
  "epoch", "nonce", "market", "side", "collateral", "leverage", "maxEntryPrice", "slPrice", "tpPrice", "expiry", "summary",
];
const CLOSE_PERP_FIELDS = ["epoch", "nonce", "position", "expiry", "summary"];

function handle(req) {
  switch (req.method) {
    case "ping":
      return { pong: true, signer: "porst-wasm" };
    case "status":
      return { ready: true, pubkey, lifetime: wasm.lifetime_capacity(), autoApprove };
    case "wallet_pubkey":
      return { pubkey };
    case "sign_swap": {
      const p = req.params || {};
      for (const f of SWAP_FIELDS) {
        if (p[f] === undefined || p[f] === null) throw new Error(`missing field: ${f}`);
      }
      // Approval boundary: the daemon only signs what it was shown a summary for.
      // In a hardware build this is where Touch ID / a device prompt would gate.
      if (!autoApprove && p.approve !== true) {
        return { approved: false, reason: "not approved at signer boundary" };
      }
      const signed = JSON.parse(
        wasm.sign_swap(
          keystore,
          Number(p.epoch),
          Number(p.nonce),
          String(p.inputMint),
          String(p.outputMint),
          Number(p.amountIn),
          Number(p.minOut),
          String(p.routeHash),
          Number(p.expiry)
        )
      );
      return { approved: true, digest: signed.digest, signature: signed.signature };
    }
    case "sign_open_perp": {
      const p = req.params || {};
      for (const f of OPEN_PERP_FIELDS) {
        if (p[f] === undefined || p[f] === null) throw new Error(`missing field: ${f}`);
      }
      if (!autoApprove && p.approve !== true) {
        return { approved: false, reason: "not approved at signer boundary" };
      }
      const signed = JSON.parse(
        wasm.sign_open_perp(
          keystore,
          Number(p.epoch),
          Number(p.nonce),
          String(p.market),
          Number(p.side),
          Number(p.collateral),
          Number(p.leverage),
          Number(p.maxEntryPrice),
          Number(p.slPrice),
          Number(p.tpPrice),
          Number(p.expiry)
        )
      );
      return { approved: true, digest: signed.digest, signature: signed.signature };
    }
    case "sign_close_perp": {
      const p = req.params || {};
      for (const f of CLOSE_PERP_FIELDS) {
        if (p[f] === undefined || p[f] === null) throw new Error(`missing field: ${f}`);
      }
      if (!autoApprove && p.approve !== true) {
        return { approved: false, reason: "not approved at signer boundary" };
      }
      const signed = JSON.parse(
        wasm.sign_close_perp(keystore, Number(p.epoch), Number(p.nonce), String(p.position), Number(p.expiry))
      );
      return { approved: true, digest: signed.digest, signature: signed.signature };
    }
    default:
      throw new Error(`unknown method: ${req.method}`);
  }
}

const server = net.createServer((conn) => {
  let buf = "";
  conn.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let req;
      try {
        req = JSON.parse(line);
      } catch {
        conn.write(JSON.stringify({ id: null, ok: false, error: "bad json" }) + "\n");
        continue;
      }
      try {
        conn.write(JSON.stringify({ id: req.id, ok: true, result: handle(req) }) + "\n");
      } catch (e) {
        conn.write(
          JSON.stringify({ id: req.id, ok: false, error: String((e && e.message) || e) }) + "\n"
        );
      }
    }
  });
});

try {
  if (fs.existsSync(args.socket)) fs.unlinkSync(args.socket);
} catch {}
server.listen(args.socket, () => {
  // Signal readiness on stdout so a parent can wait for it.
  process.stdout.write(`signer-ready ${pubkey}\n`);
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
