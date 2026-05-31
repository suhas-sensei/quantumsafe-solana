#!/usr/bin/env bash
#
# Deploy the PORST programs to a Solana cluster (devnet by default).
#
# Usage:
#   scripts/deploy.sh [devnet|mainnet-beta|localnet] [path/to/deployer-keypair.json]
#
# The program IDs are fixed by the keypairs in target/deploy/*-keypair.json and
# are already wired into Anchor.toml and the `declare_id!`s, so a deploy keeps
# the same addresses across clusters. Mainnet deploys cost real SOL and are
# gated behind an explicit confirmation.
set -euo pipefail

CLUSTER="${1:-devnet}"
WALLET="${2:-$HOME/.config/solana/id.json}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"

case "$CLUSTER" in
  devnet)        URL="https://api.devnet.solana.com" ;;
  mainnet-beta)  URL="https://api.mainnet-beta.solana.com" ;;
  localnet)      URL="http://127.0.0.1:8899" ;;
  *) echo "unknown cluster: $CLUSTER" >&2; exit 2 ;;
esac

echo "» cluster:  $CLUSTER ($URL)"
echo "» deployer: $WALLET ($(solana-keygen pubkey "$WALLET"))"
echo "» programs:"
echo "    porst        = $(solana-keygen pubkey target/deploy/porst-keypair.json)"
echo "    porst_wallet = $(solana-keygen pubkey target/deploy/porst_wallet-keypair.json)"

solana config set --url "$URL" --keypair "$WALLET" >/dev/null

BAL=$(solana balance "$WALLET" | awk '{print $1}')
echo "» balance:  $BAL SOL"
if [ "$CLUSTER" = "devnet" ]; then
  # ~7 SOL is plenty for both program deploys; airdrops are rate-limited so we
  # only nudge if clearly underfunded.
  if (( $(echo "$BAL < 4" | bc -l) )); then
    echo "» requesting devnet airdrop (may be rate-limited; fund manually if it fails)…"
    solana airdrop 2 || true
    solana airdrop 2 || true
  fi
fi

if [ "$CLUSTER" = "mainnet-beta" ]; then
  read -r -p "!! Mainnet deploy spends real SOL. Type 'deploy mainnet' to proceed: " CONFIRM
  [ "$CONFIRM" = "deploy mainnet" ] || { echo "aborted."; exit 1; }
fi

echo "» building…"
anchor build

echo "» deploying…"
anchor deploy --provider.cluster "$URL" --provider.wallet "$WALLET"

echo "✓ deployed. Verify with:"
echo "    solana program show $(solana-keygen pubkey target/deploy/porst_wallet-keypair.json) --url $URL"
