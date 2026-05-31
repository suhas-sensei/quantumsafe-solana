# PORST on Solana — post-quantum signatures & a many-time wallet

A Solana implementation of **PORST** (the few-time post-quantum signature from
[eprint 2017/933](https://eprint.iacr.org/2017/933.pdf), a faithful port of
[`PORST.sol`](../src/PORST.sol)) **plus the complete signing product the Solidity
repo left out**: deterministic key generation, an XMSS many-time layer, a
stateful signer, a smart-contract wallet that authorizes SOL transfers with
post-quantum signatures, a client SDK, deployment tooling, and a security
review.

**On top of this sits a talk-to-trade app** ([`agent/`](agent/README.md)): an AI
reads a live Pyth price feed and *proposes* spot swaps and leveraged **SOL-PERP**
positions — and a post-quantum signature from an isolated signer (never the AI)
authorizes each one on-chain. The model proposes; it never signs.

All hashing is Ethereum-compatible Keccak-256, identical to `PORST.sol`. The
verification logic is shared verbatim between the on-chain programs and the
off-chain signer (one crate, [`porst-core`](core/src/lib.rs)) so they cannot
drift.

## What's here

| crate / dir | what it is |
| ----------- | ---------- |
| [`core/`](core/src/lib.rs) (`porst-core`) | Shared crypto: subset derivation, frontier Merkle multiproof, `verify_porst`, `transfer_digest`, XMSS fold, `verify_wallet_sig`. The single source of truth. |
| [`programs/porst/`](programs/porst/src/lib.rs) | The **few-time** verifier — a 1:1 behavioral port of `PORST.sol` exposed as a Solana program. |
| [`programs/porst_wallet/`](programs/porst_wallet/src/lib.rs) | The **many-time smart-contract wallet**: `create_wallet`, `write_buffer`, `execute_transfer`. |
| [`programs/porst_agent/`](programs/porst_agent/src/lib.rs) | **Post-quantum authorization for AI agents**: `execute_swap` runs a real DEX swap only with a valid PORST signature. |
| [`programs/porst_perp/`](programs/porst_perp/src/lib.rs) | **Post-quantum perpetual-futures engine**: `open_position`/`close_position` (leverage, maintenance-margin liquidation, stop-loss/take-profit, Pyth price) gated by a PORST signature. |
| [`programs/cpswap/`](programs/cpswap/src/lib.rs) | A real constant-product AMM (on-chain DEX) — the local swap target for `porst_agent`. |
| [`signer/`](signer/src/lib.rs) (`porst-signer`) | Hardened off-chain keygen + many-time signing library and CLI. |
| [`wasm/`](wasm/README.md) (`porst-wasm`) | Browser/Node WASM signer — byte-for-byte identical to the CLI. |
| [`app/porstWallet.ts`](app/porstWallet.ts) | TypeScript wallet SDK. |
| [`agent/`](agent/README.md) | AI-agent pipeline (maki-style): policy engine, **isolated PORST signer over IPC**, SDK, orchestration. |
| [`tests/`](tests) | Host unit tests + on-chain integration tests for every program. |
| [`scripts/deploy.sh`](scripts/deploy.sh) | Devnet/mainnet deploy script. |
| [`SECURITY.md`](SECURITY.md) | Threat model and internal security review. |

## Parameters

| parameter | value | meaning |
| --------- | ----- | ------- |
| `TREE_HEIGHT` | 16 | `2^16 = 65536` leaves per PORST tree |
| `SUBSET_SIZE` | 38 | leaves revealed per signature |
| `SIGNING_CAPACITY` | 16 | safe signatures per PORST key (~258-bit security, per `PORST.sol`'s table) |
| `XMSS_HEIGHT` | 4 | `2^4 = 16` PORST keys (epochs) per wallet |
| lifetime | **256** | `NUM_EPOCHS × SIGNING_CAPACITY` total signatures |

---

## Run the trading app locally

Needs Rust, Solana CLI (Agave 4.0), Anchor 0.32, Node 22, `yarn`, `wasm-pack`.

```bash
# 1. build the programs + the WASM signer
anchor build
wasm-pack build wasm --target nodejs --out-dir pkg-node --release
wasm-pack build wasm --target web     --out-dir pkg      --release

# 2. local validator (leave running in another shell)
solana-test-validator --reset

# 3. fund + deploy the three programs the app uses
solana airdrop 100 --url localhost
for p in cpswap porst_agent porst_perp; do
  solana program deploy target/deploy/$p.so \
    --program-id target/deploy/$p-keypair.json --url localhost
done

# 4. build the web UI + install deps
yarn install
( cd web && npm install && npm run build )

# 5. (optional) turn on AI mode — without a key it falls back to a regex parser
echo "OPENAI_API_KEY=sk-..." > agent/.demo/.env   # or ANTHROPIC_API_KEY=...

# 6. run the agent server (serves the UI + the API)
set -a; . agent/.demo/.env 2>/dev/null; set +a
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=~/.config/solana/id.json PORT=8787 \
  ./node_modules/.bin/ts-node --transpile-only -P tsconfig.json agent/server.ts
```

Open **http://127.0.0.1:8787** → **Perps** tab. Tell the AI something like
*"I'm bullish on SOL, you decide"*, approve the proposal, and a post-quantum
signature opens the position on-chain. To run against devnet instead, set
`ANCHOR_PROVIDER_URL=https://api.devnet.solana.com` (programs must be deployed
there first). End-to-end engine test: `yarn ts-node agent/perp-e2e.ts`.

---

## Layer 1 — the few-time verifier (`porst`)

The public key is the Merkle root over leaf hashes (`leaf = keccak256(preimage)`).
A signature is `salt ‖ <revealed preimages and Merkle witnesses>`, streamed in
exactly the order the verifier consumes them. The verifier derives a
pseudo-random `SUBSET_SIZE` subset from `keccak256(hash ‖ salt)` and checks a
"frontier"/park-level Merkle multiproof. This is behaviorally identical to
`PORST.sol::isValidSignature`.

**The one real difference from Ethereum:** a signature is ~13 KB, but a Solana
transaction is capped at 1232 bytes. So the signature is staged into a
**program-owned buffer account** (created client-side, which bypasses the 10 KB
CPI limit) via chunked `write_buffer` calls, then read by the verify/execute
instruction. The verification math ports 1:1; only delivery changes.

## Layer 2 — the many-time wallet (`porst_wallet`)

PORST is *few-time*, so the wallet layers **XMSS** over `NUM_EPOCHS` independent
PORST keys:

```
wallet pubkey = XMSS root over [R_0, R_1, …, R_15]
              where R_j = root of epoch j's PORST tree
signature     = salt ‖ porst_stream(R_epoch) ‖ xmss_auth_path(epoch)
```

`execute_transfer` recomputes the digest from on-chain state, runs
`verify_wallet_sig` (PORST multiproof reconstructs `R_epoch`; the auth path folds
it to the wallet root), then moves SOL out of the vault PDA via `invoke_signed`.

**Statefulness (the "infrequent synchronization").** The wallet account is the
source of truth for `(epoch, used, nonce)`:

- `nonce` is bound into every signed digest and bumped on success → signatures
  are single-use (replay-proof).
- `used` enforces per-epoch capacity; at `SIGNING_CAPACITY` the wallet advances
  `epoch`. After all epochs are spent it refuses to sign.

The digest binds `xmss_root ‖ epoch ‖ nonce ‖ recipient ‖ amount`, so a
signature authorizes exactly one transfer of one amount to one recipient, once.

## Layer 3 — post-quantum authorization for AI agents (`porst_agent` + `agent/`)

A [maki](../maki)-style agent where **the model proposes, but cannot move funds**.
A swap executes only with a PORST signature from an **isolated signer process**
(the post-quantum "hardware boundary"), verified on-chain before a real DEX swap:

```
interpret -> resolve -> quote -> policy check -> deterministic summary
          -> approve -> sign (isolated signer) -> submit (execute_swap)
```

`execute_swap` recomputes the swap digest from chain state, checks expiry,
verifies the PORST/XMSS signature, **binds the exact route** (`route_hash` of the
DEX program + pool), CPIs into the real `cpswap` AMM signed by the agent PDA,
enforces `min_out` on-chain, and advances `(epoch, used, nonce)`. Locally the
route is `cpswap`; on testnet/mainnet the same shape targets **Jupiter** (routing
via the Jupiter Quote API, settlement via `sharedAccountsRoute`). See
[`agent/README.md`](agent/README.md).

## Measured cost (local validator)

| instruction | compute units (of 1.4M max) |
| ----------- | --------------------------- |
| `porst::verify` (few-time) | ~98k–113k |
| `porst_wallet::execute_transfer` (PORST + XMSS + transfer CPI) | ~121k–124k |
| `porst_agent::execute_swap` (PORST + XMSS + route-bind + AMM swap CPI + slippage) | ~140k–145k |
| `write_buffer` (per chunk) | ~1k–5k |

---

## Build & test

Requires Rust, the Solana CLI (`cargo-build-sbf`), Anchor, and Node.

```bash
# Crypto-level unit tests (host; fast in release)
cargo test -p porst-core -p porst-signer --release

# Few-time parity tests vs. the reference signer (mirrors PORST.t.sol)
cargo test -p porst --lib

# Build both SBF programs + IDLs
anchor build

# Build the signer CLI the SDK shells out to
cargo build -p porst-signer --release

# Full integration suite: boots a validator, deploys, runs both programs' tests
anchor test
```

## Using the wallet (SDK)

```ts
import { PorstWallet } from "./app/porstWallet";

const cli = "target/release/porst-signer";
const pw  = PorstWallet.keygen(program, provider, cli, "keystore.json");
await pw.createWallet();
await pw.fundVault(10 * LAMPORTS_PER_SOL);

// sign (PORST+XMSS) + stage the ~13 KB signature + execute, all in one call:
await pw.transfer(recipientPubkey, 1 * LAMPORTS_PER_SOL);
```

Or drive the crypto directly:

```bash
porst-signer keygen --seed <hex32> --out keystore.json
porst-signer sign   --keystore keystore.json --epoch 0 --nonce 0 \
                    --recipient <hex32> --amount 1000000
```

## Deploy

```bash
scripts/deploy.sh devnet              # uses ~/.config/solana/id.json
scripts/deploy.sh devnet path/to/deployer.json
```

Program IDs are fixed by `target/deploy/*-keypair.json` (wired into `Anchor.toml`
and `declare_id!`), so addresses are stable across clusters. Mainnet deploys are
gated behind an explicit confirmation. The script is exercised against localnet;
a live devnet deploy additionally needs a funded deployer (airdrops are
rate-limited).

## Scope & honesty

- The `porst` program matches `PORST.sol`'s scope exactly (verifier only) and is
  parity-tested against a reference signer that mirrors `PORST.t.sol`.
- The `porst_wallet` stack is the "complete signing product" the Solidity repo
  deferred: keygen, XMSS many-time signing, stateful authorization, SDK, deploy.
- [`SECURITY.md`](SECURITY.md) is an **internal** review, not a certified
  external audit, and lists known limitations (single-writer seed custody, no
  key rotation, SOL-only intents).
