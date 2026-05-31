# QuantumSafe — a post-quantum AI trading agent on Solana

Talk to an AI, it proposes a trade, and a **post-quantum signature** (not the AI)
authorizes it on-chain. The model proposes; it never signs, never holds a key.

Built on **PORST/XMSS** hash-based signatures (quantum-resistant). Funds live in
a program-controlled vault that only opens for a valid PORST signature, so even
if the Ed25519 fee-payer key were broken by a quantum computer, the funds stay
safe.

## What it does

- **AI mode** — you say *"I'm bullish on SOL, you decide"*; the agent reads the
  live Pyth price feed and proposes a position (side, size, leverage, stop-loss,
  take-profit), or asks for whatever's missing.
- **SOL-PERP perpetuals** — leverage, maintenance-margin liquidation, SL/TP
  triggers, real PnL, USDT-settled against an LP vault. (`porst_perp`)
- **Spot swaps** — PORST-authorized swaps through a real on-chain AMM.
  (`porst_agent` + `cpswap`)
- **The boundary**: AI proposes → deterministic policy clamps → an isolated
  signer produces a ~13 KB PORST signature → the on-chain program verifies it
  and only then moves funds.

Lives on **devnet** (program `C6eDbYMs8q31TnnLbshbxecXc8CGRCdwHCS2ByEMafpU`).
The SOL price is real (Pyth); the USDT collateral is a devnet test token.

## Run it locally

Needs: Rust, Solana CLI (Agave 4.0), Anchor 0.32, Node 22, `yarn`, `wasm-pack`.

```bash
cd solana

# 1. build the programs + WASM signer
anchor build
wasm-pack build wasm --target nodejs --out-dir pkg-node --release
wasm-pack build wasm --target web     --out-dir pkg      --release

# 2. start a local validator (leave running in another shell)
solana-test-validator --reset

# 3. fund + deploy the three programs the app uses
solana airdrop 100 --url localhost
for p in cpswap porst_agent porst_perp; do
  solana program deploy target/deploy/$p.so \
    --program-id target/deploy/$p-keypair.json --url localhost
done

# 4. install deps + build the web UI
yarn install
( cd web && npm install && npm run build )

# 5. (optional) AI mode — without a key it falls back to a regex parser
echo "OPENAI_API_KEY=sk-..." > agent/.demo/.env      # or ANTHROPIC_API_KEY=...

# 6. run the agent server (serves the UI + the API)
set -a; . agent/.demo/.env 2>/dev/null; set +a
ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
ANCHOR_WALLET=~/.config/solana/id.json PORT=8787 \
  ./node_modules/.bin/ts-node --transpile-only -P tsconfig.json agent/server.ts
```

Open **http://127.0.0.1:8787** → **Perps** tab → tell the AI a trade idea →
approve → a post-quantum signature opens the position on-chain.

**End-to-end engine test** (open → profit close → liquidation → take-profit):

```bash
cd solana && yarn ts-node agent/perp-e2e.ts
```

**Run against devnet** instead of localnet: set
`ANCHOR_PROVIDER_URL=https://api.devnet.solana.com` (the three programs are
already deployed there).

## Layout

| path | what |
| ---- | ---- |
| `solana/programs/porst_perp` | the perpetuals engine (PORST-gated open/close, liquidation, SL/TP) |
| `solana/programs/porst_agent` + `cpswap` | PORST-authorized spot swaps + AMM |
| `solana/core` | shared PORST/XMSS crypto (on-chain + signer, one source of truth) |
| `solana/agent` | AI mode, policy engine, isolated signer, keeper, server |
| `solana/web` | React UI (swap + perps) |

Full crypto/protocol detail: [`solana/README.md`](solana/README.md).
