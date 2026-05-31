# Security review — PORST/XMSS Solana wallet

**Status: internal review, not a certified external audit.** This documents the
threat model, the mitigations in the code, and the adversarial test coverage. A
production deployment should still commission an independent third-party audit
and (ideally) formal verification of the verifier.

## Assets and trust boundaries

- **Master seed** (`Keystore.seed`): the single secret. Whoever holds it can
  drain the wallet. It never leaves the client / `porst-signer` process and is
  never sent on-chain.
- **Wallet vault** (a PDA holding SOL): spendable only via `execute_transfer`,
  which requires a valid post-quantum signature.
- **On-chain wallet state** `(epoch, used, nonce)`: the authority for replay and
  few-time-capacity enforcement. The chain is the source of truth; the signer
  reads it before every signature.

## Cryptographic design

- **PORST** is a *few-time* scheme. One 2¹⁶-leaf tree may sign `SIGNING_CAPACITY
  = 16` messages at ~258-bit security for `TREE_HEIGHT=16, SUBSET_SIZE=38` (per
  the parameter table in `PORST.sol`). Exceeding capacity lets an adversary, who
  has seen enough revealed preimages, grind a message whose subset is fully
  covered.
- **XMSS layering** turns it many-time: `2^XMSS_HEIGHT = 16` independent PORST
  keys under one Merkle root → `16 × 16 = 256` lifetime signatures. The wallet
  advances `epoch` after each key's capacity is spent and refuses to sign once
  all epochs are exhausted.
- **Single source of truth**: all verification (subset derivation, multiproof,
  digest, XMSS fold) lives in `porst-core` and is used verbatim by both the
  on-chain program and the off-chain signer — there are no divergent copies to
  drift apart. Keccak-256 is the Ethereum-compatible variant, identical to
  `PORST.sol`.

## Threats and mitigations

| # | Threat | Mitigation | Tested |
|---|--------|------------|--------|
| 1 | **Replay** of a captured signature | The digest binds a monotonic `nonce`, incremented on every success; a stale signature no longer matches the recomputed digest. | `rejects replay of a previously used signature` |
| 2 | **Amount / recipient substitution** | `amount` and `recipient` are bound into the digest; the program recomputes the digest from its own instruction args and state, not from the signature. | `rejects a signature that authorizes a different amount` |
| 3 | **Signature forgery / tampering** | Full PORST multiproof must reconstruct the epoch root *and* the XMSS path must fold to the pinned wallet root; buffer length must equal `porst_len + XMSS_HEIGHT·32` exactly. | `rejects a tampered signature`, plus the few-time suite (corrupted/truncated/extra/salt-only) |
| 4 | **Few-time key reuse** (security erosion) | Per-epoch `used` counter enforces `SIGNING_CAPACITY`; epoch auto-advances; wallet refuses to operate past `NUM_EPOCHS`. The signer reads on-chain state first, so it never reuses a slot. | `advances to the next epoch after SIGNING_CAPACITY signatures` |
| 5 | **Cross-context PRF/hash reuse** | Domain-separation tags (`:preimage`, `:salt`, `:transfer`) prevent a value produced in one context from being valid in another. | covered structurally |
| 6 | **Salt grinding** by an adversary | The per-message salt is derived from the *secret* seed (`keccak(DS_SALT‖seed‖epoch‖digest)`), so an attacker cannot search salts to land a weak subset. | n/a (design) |
| 7 | **Wrong-epoch fold** | The XMSS path is folded using the on-chain `epoch` bits; a path for a different leaf will not reach the root. | signer test `wrong_epoch_fails` |
| 8 | **Buffer-account squatting / spoofing** | `write_buffer` and `execute_transfer` require `buffer.owner == program_id`; the buffer is created client-side and assigned to the program. | enforced (`BufferNotOwned`) |
| 9 | **Vault drain by non-holder** | `execute_transfer` is permissionless to *submit*, but the signature is the authorization — only the seed holder can produce one. Vault lamports move only via `invoke_signed` with the vault PDA seeds. | implied by transfer tests |
| 10 | **Compute exhaustion** | Verification is ~121k CU (measured), well under the 1.4M cap; the client sets a 400k limit. No unbounded loops (subset and tree heights are constants). | measured in CI logs |
| 11 | **Arithmetic overflow** | `nonce`/`used` use `checked_add`; `epoch` is bounded by the `< NUM_EPOCHS` guard. | `Overflow` error path |

## Known limitations / non-goals

- **Stateful signing requires a correct, monotonic client.** If a seed is copied
  to two machines that sign concurrently without sharing on-chain state, they can
  burn the same epoch slot twice. The on-chain `nonce` still prevents *replay of
  the same bytes*, and capacity enforcement still caps usage per epoch, but
  operators must treat the seed as single-writer. A hardware-backed counter or a
  custodial signing service is the production answer.
- **No key rotation / recovery / social recovery** is implemented; the wallet is
  pinned to one XMSS root for life (256 signatures). Rotation would mean
  publishing a new root, which is a natural extension.
- **Vault rent**: transfers do not guard the vault's rent-exempt minimum; in
  practice the vault is a 0-data system account and holds SOL freely, but very
  small residual balances are out of scope.
- **Generic CPItransaction authorization** (arbitrary instructions, SPL tokens)
  is not implemented — only native SOL transfer. The digest scheme generalizes
  by adding intent types with their own domain tags.
- This review covers the wallet logic, not the toolchain supply chain, the RPC,
  or the operator's key custody.

## Reproducing the adversarial tests

```bash
cargo test -p porst-core -p porst-signer --release   # crypto-level
cargo test -p porst --lib                             # few-time parity
anchor test                                           # on-chain, incl. wallet suite
```
