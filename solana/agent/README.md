# PORST Agent — post-quantum authorization for autonomous Solana agents

A Solana adaptation of [maki](../../maki)'s security architecture: **the model
interprets intent; it never moves funds.** An AI agent can propose a swap, but it
executes only when accompanied by a **post-quantum (PORST/XMSS) signature**
produced by an isolated signer the model cannot reach — and verified on-chain by
the `porst_agent` program before a real DEX swap is performed.

> Timely even before quantum computers arrive: this is **quantum-resistant
> authorization for autonomous agents** — the agent's authority is structurally
> separated from the signing key, and the strongest control (the signature) is
> post-quantum.

## The pipeline (mirrors maki)

```
interpret -> resolve -> quote -> policy check -> deterministic summary
          -> approve -> sign (isolated signer) -> submit
```

Every security decision is made by deterministic code, not the model:

| stage | file | what's enforced |
| ----- | ---- | --------------- |
| interpret | `pipeline.ts` (`parseIntent`) | structured intent only (an LLM may produce this object) |
| resolve / quote | `sdk.ts`, `pipeline.ts` | mints, decimals, route, `min_out` from real pool reserves |
| policy | `policy.ts` | per-tx & daily limits, slippage cap, token/protocol allowlists, expiry, action classes |
| summary | `pipeline.ts` | deterministic human-readable description |
| **sign** | `signer/daemon.cjs` + `client.ts` | **isolated signer process; seed never leaves it; signs typed swap intents only** |
| submit | `sdk.ts` | stage 13 KB signature → `execute_swap` |

## The hard boundary

The signer is a **separate OS process** (`signer/daemon.cjs`) holding the
keystore, reachable only over a Unix socket with a schema-strict JSON surface
(`ping`/`status`/`wallet_pubkey`/`sign_swap`). It uses the WASM PORST signer as
its key-bearing backend. It will sign a *swap intent* (typed fields) and nothing
else — no arbitrary bytes, no seed export, no model output execution. This is the
analog of maki's Secure Enclave / Ledger signer split, with a **post-quantum**
key as the secret.

The agent core talks to it only through `SignerClient` (`signer/client.ts`). The
LLM/agent runtime never has the seed.

## On-chain enforcement (`porst_agent::execute_swap`)

What the chain checks before any funds move (re-derived from its own state, so
the agent can't substitute fields after signing):

1. **Not expired** (`Clock` vs. the signed `expiry`).
2. **Live epoch** (few-time capacity not exhausted).
3. **Valid PORST/XMSS signature** over `swap_digest(xmss_root, epoch, nonce,
   input_mint, output_mint, amount_in, min_out, route_hash, expiry)`.
4. **Route binding**: `route_hash` is recomputed from the DEX program + pool it's
   about to CPI into — a signature authorizes *exactly one route*.
5. **Real swap** via CPI into the `cpswap` AMM, signed by the agent PDA.
6. **Slippage**: `received >= min_out`, checked on-chain by balance delta
   (independent of the DEX's own check).
7. **State advance**: `nonce++` (replay-proof), `used++`, epoch rollover.

Measured cost: **~140k–145k compute units**.

## Local vs. later

- **Local (now):** the route is the real `cpswap` constant-product AMM, deployed
  to the local validator. Real SPL tokens, real swap math, real slippage.
- **Testnet/mainnet (later):** the same `execute_swap` CPI shape targets
  **Jupiter** (`sharedAccountsRoute` via `remaining_accounts`); the agent's
  off-chain quote step calls the Jupiter Quote API and folds `route_hash`,
  `min_out`, and `expiry` into the signed intent.

## Run

```bash
# build the WASM signer backend the daemon uses
wasm-pack build wasm --target nodejs --out-dir pkg-node --release

# full agent integration suite (boots a validator, deploys, runs the flow)
anchor test            # see tests/porst_agent.ts
```

Files: `policy.ts` (policy engine) · `sdk.ts` (on-chain client + token/pool
setup) · `signer/daemon.cjs` + `signer/client.ts` (isolated signer) · `pipeline.ts`
(the orchestrated flow).

## Run the full demo (frontend + agent + chain)

```bash
# 0. prerequisites (once)
cargo build -p porst-signer --release
wasm-pack build wasm --target nodejs --out-dir pkg-node --release
( cd web && npm install && npm run build )

# 1. local validator + deploy all programs
solana-test-validator --reset --ledger ./test-ledger &     # keep running
solana config set --url http://127.0.0.1:8899 && solana airdrop 100
anchor deploy --provider.cluster http://127.0.0.1:8899

# 2. the agent backend (serves the built UI on :8787)
#    add your LLM key to enable natural-language intent (optional; falls back to a parser)
export ANTHROPIC_API_KEY=sk-ant-...        # or OPENAI_API_KEY=sk-...
export LLM_MODEL=claude-sonnet-4-6         # optional
./node_modules/.bin/ts-node --transpile-only -P tsconfig.json agent/server.ts

# 3. open the app
#    production: http://127.0.0.1:8787   (backend serves web/dist)
#    or dev with hot reload:  ( cd web && npm run dev )  -> http://127.0.0.1:5173
```

Then type `swap 1 SOL to USDC` and approve. With an LLM key set you can phrase it
naturally ("trade one of my SOL for USDC"); without one, the deterministic parser
handles `swap <amt> <A> to <B>`.

## Run against devnet

The same programs and backend run unchanged against devnet — only the RPC URL and
funding differ. The four programs are already deployed at the IDs in `Anchor.toml`
(`[programs.devnet]`); redeploy only if you change them.

```bash
# 1. point the CLI at devnet and fund the deployer/fee-payer
solana config set --url devnet
#    devnet's CLI faucet is rate-limited from cloud IPs — if `solana airdrop 2`
#    fails, fund the address from https://faucet.solana.com or another wallet.
#    All four programs cost ~7 SOL to (re)deploy; bootstrap + trades need < 0.2 SOL.

# 2. (only if redeploying) deploy each program — IDs are fixed by the keypairs
for p in cpswap porst_agent porst porst_wallet; do
  solana program deploy target/deploy/$p.so --program-id target/deploy/$p-keypair.json --url devnet
done

# 3. run the backend against devnet
#    secrets (LLM key) live in agent/.demo/.env (gitignored); the wallet seed
#    keystore is generated there on first boot.
export ANCHOR_PROVIDER_URL=https://api.devnet.solana.com
export ANCHOR_WALLET=$HOME/.config/solana/id.json   # the funded deployer key
set -a; . agent/.demo/.env; set +a                  # OPENAI_API_KEY / ANTHROPIC_API_KEY
./node_modules/.bin/ts-node --transpile-only -P tsconfig.json agent/server.ts
# open http://127.0.0.1:8787
```

On boot the backend creates a fresh test economy (SPL "SOL"/"USDC", a priced cpswap
pool, the agent + funded ATAs) and reuses the on-chain agent account across restarts,
so the signature counter and nonce persist. Every swap is a real devnet transaction —
verify any tx with `solana confirm <sig> --url devnet` or on Solana Explorer
(`?cluster=devnet`).

> **Note on Jupiter:** real Jupiter routing/liquidity exists on **mainnet-beta**, not
> devnet, so the devnet demo executes through the bundled `cpswap` AMM. The PORST
> authorization layer (`swap_digest` over `route_hash`/`min_out`/`expiry`/`nonce`) is
> route-agnostic; pointing the CPI at Jupiter is a mainnet step.
