//! Shared PORST verification primitives — the single source of truth for the
//! cryptography, used by both on-chain programs (`porst`, `porst_wallet`) and the
//! off-chain `porst-signer` library. Keeping one implementation avoids the
//! divergence between copies that an audit would flag.
//!
//! This is a faithful port of the PORST verification routine from `PORST.sol`
//! (<https://eprint.iacr.org/2017/933.pdf>). The Keccak-256 used here
//! (`solana-keccak-hasher`) is the Ethereum-compatible Keccak, identical to
//! Solidity's `keccak256`.
//!
//! PORST is a *few-time* signature scheme. The public key is the root of a
//! Merkle tree over `2^TREE_HEIGHT` leaves, each leaf being
//! `keccak256(preimage)`. A signature reveals the preimages of a pseudo-random
//! subset of leaves (derived from the message) together with a compact Merkle
//! multiproof, streamed in the exact order the verifier consumes it. The
//! "frontier" / park-level technique exploits the sorted subset's shared
//! prefixes so that internal nodes computed for one leaf are reused as witnesses
//! for the next, minimizing witness size.

use solana_keccak_hasher as keccak;

/// Tree height: total leaves are `2^TREE_HEIGHT`. Must match `PORST.sol`.
pub const TREE_HEIGHT: u32 = 16;
/// Number of distinct leaves revealed per signature. Must match `PORST.sol`.
pub const SUBSET_SIZE: usize = 38;

/// `keccak256` of a single 32-byte word (leaf preimage hashing).
#[inline(always)]
pub fn hash1(word: &[u8; 32]) -> [u8; 32] {
    keccak::hash(word).to_bytes()
}

/// `keccak256(a ‖ b)` of two 32-byte words (internal node hashing).
#[inline(always)]
pub fn hash2(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    keccak::hashv(&[a, b]).to_bytes()
}

/// Mirrors the EVM `calldataload`: reads a 32-byte word at `offset`, zero-padding
/// past the end. The final exact-length check is what rejects truncated or
/// over-long signatures, exactly as in the Solidity contract where reads past
/// calldata return zero.
#[inline(always)]
fn load32(sig: &[u8], offset: usize) -> [u8; 32] {
    let mut w = [0u8; 32];
    if offset < sig.len() {
        let end = core::cmp::min(offset + 32, sig.len());
        w[..end - offset].copy_from_slice(&sig[offset..end]);
    }
    w
}

/// Interpret a 32-byte big-endian value as four little-endian 64-bit limbs
/// (`limbs[0]` = least-significant 64 bits), matching how the EVM treats a
/// `keccak256` output word as a `uint256` for `& mask` / `>>` operations.
#[inline(always)]
fn be_to_limbs(b: &[u8; 32]) -> [u64; 4] {
    [
        u64::from_be_bytes(b[24..32].try_into().unwrap()),
        u64::from_be_bytes(b[16..24].try_into().unwrap()),
        u64::from_be_bytes(b[8..16].try_into().unwrap()),
        u64::from_be_bytes(b[0..8].try_into().unwrap()),
    ]
}

/// Logical right shift of a 256-bit value (as limbs) by `n` bits, `0 < n < 64`.
#[inline(always)]
fn shr(limbs: &mut [u64; 4], n: u32) {
    limbs[0] = (limbs[0] >> n) | (limbs[1] << (64 - n));
    limbs[1] = (limbs[1] >> n) | (limbs[2] << (64 - n));
    limbs[2] = (limbs[2] >> n) | (limbs[3] << (64 - n));
    limbs[3] >>= n;
}

/// Derive the sorted, de-duplicated subset of leaf indices for a message.
///
/// Faithful to `PORST.sol`'s subset-derivation loop: `S = keccak256(hash ‖ salt)`,
/// then reseed `seed = keccak256(seed_state ‖ S)` every `256 / TREE_HEIGHT`
/// selections, extracting `TREE_HEIGHT`-bit selections from the low end of `seed`.
/// Selections are inserted in sorted order; exact duplicates are skipped (the
/// selection is still consumed).
pub fn derive_subset(hash: &[u8; 32], salt: &[u8; 32]) -> [u32; SUBSET_SIZE] {
    let s = hash2(hash, salt); // S = keccak256(hash ‖ salt)

    let mask: u64 = (1u64 << TREE_HEIGHT) - 1;
    let reseed_interval: u32 = 256 / TREE_HEIGHT;

    let mut seed_state = [0u8; 32]; // mem[0x00] starts as zero in the contract
    let mut seed = [0u64; 4];
    let mut seed_count = reseed_interval; // forces an immediate reseed

    let mut subset = [0u32; SUBSET_SIZE];
    let mut count: usize = 0;

    while count < SUBSET_SIZE {
        if seed_count >= reseed_interval {
            let h = hash2(&seed_state, &s); // keccak256(seed_state ‖ S)
            seed_state = h;
            seed = be_to_limbs(&h);
            seed_count = 0;
        }
        seed_count += 1;
        let selection = (seed[0] & mask) as u32;
        shr(&mut seed, TREE_HEIGHT);

        // lower-bound binary search over the sorted prefix subset[..count]
        let mut lo = 0usize;
        let mut hi = count;
        while lo < hi {
            let mid = (lo + hi) / 2;
            if subset[mid] < selection {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if lo < count && subset[lo] == selection {
            continue; // duplicate — skip, selection already consumed
        }

        let mut j = count;
        while j > lo {
            subset[j] = subset[j - 1];
            j -= 1;
        }
        subset[lo] = selection;
        count += 1;
    }

    subset
}

/// Run the PORST multiproof over `sig = salt ‖ <stream>` for message `hash` and
/// return `(reconstructed_root, bytes_consumed)`.
///
/// Unlike [`verify_porst`], this does **not** require the signature to be
/// consumed exactly — it returns how many bytes the multiproof read, so a caller
/// (e.g. the many-time XMSS wallet) can place additional data (an authentication
/// path) after the PORST stream. Returns `None` only if the signature is too
/// short to contain the salt.
pub fn compute_porst_root(hash: &[u8; 32], sig: &[u8]) -> Option<([u8; 32], usize)> {
    if sig.len() < 32 {
        return None;
    }
    let salt: [u8; 32] = sig[0..32].try_into().unwrap();
    let subset = derive_subset(hash, &salt);

    // frontier[level] holds a parked internal node awaiting its left subtree, or
    // None when empty. `None` corresponds to the contract's `0x00` sentinel; real
    // Keccak nodes are never zero in practice.
    let mut frontier: [Option<[u8; 32]>; (TREE_HEIGHT as usize) + 1] =
        [None; (TREE_HEIGHT as usize) + 1];

    let mut cursor = 32usize; // bytes consumed so far (salt already read)

    for idx in 0..SUBSET_SIZE {
        let i = subset[idx];

        // Park level: where this leaf's path merges with the next subset leaf's
        // path = index of the most-significant differing bit. The last leaf parks
        // at the root level (TREE_HEIGHT).
        let park_level: u32 = if idx + 1 < SUBSET_SIZE {
            let x = i ^ subset[idx + 1]; // nonzero: subset is strictly increasing
            31 - x.leading_zeros()
        } else {
            TREE_HEIGHT
        };

        // hash the revealed leaf preimage
        let mut node = hash1(&load32(sig, cursor));
        cursor += 32;

        // ascend from level 0 toward park_level
        for level in 0..park_level {
            let c = (i >> level) & 1;
            if c == 0 {
                // node is a left child; right sibling is a witness from the stream
                let sib = load32(sig, cursor);
                cursor += 32;
                node = hash2(&node, &sib);
            } else {
                // node is a right child; left sibling is parked or streamed
                match frontier[level as usize].take() {
                    Some(parked) => {
                        node = hash2(&parked, &node);
                    }
                    None => {
                        let sib = load32(sig, cursor);
                        cursor += 32;
                        node = hash2(&sib, &node);
                    }
                }
            }
        }

        frontier[park_level as usize] = Some(node);
    }

    // The last subset element always parks at TREE_HEIGHT, so this is set.
    let root = frontier[TREE_HEIGHT as usize].expect("root computed");
    Some((root, cursor))
}

/// Verify a single-tree (few-time) PORST signature `sig = salt ‖ <stream>` over
/// `hash` against the Merkle-root public key `pubkey`.
///
/// Returns `true` iff the multiproof reconstructs `pubkey` **and** every byte of
/// the signature is consumed exactly — matching the two success conditions in
/// `PORST.sol::isValidSignature`.
pub fn verify_porst(pubkey: &[u8; 32], hash: &[u8; 32], sig: &[u8]) -> bool {
    match compute_porst_root(hash, sig) {
        Some((root, consumed)) => consumed == sig.len() && root == *pubkey,
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Many-time wallet layer: XMSS over PORST.
//
// These primitives are shared verbatim between the off-chain signer and the
// on-chain `porst_wallet` program so the message digest and verification can
// never diverge.
// ---------------------------------------------------------------------------

/// XMSS tree height: a wallet has `2^XMSS_HEIGHT` epochs (independent PORST keys).
pub const XMSS_HEIGHT: u32 = 4;
/// Number of epochs / PORST keys per wallet.
pub const NUM_EPOCHS: u64 = 1 << XMSS_HEIGHT;
/// Messages a single epoch may safely sign (from `PORST.sol`'s security table
/// for `TREE_HEIGHT = 16`, `SUBSET_SIZE = 38`: `r = 16` at ~258-bit security).
pub const SIGNING_CAPACITY: u64 = 16;

/// Domain tag binding a digest to the SOL-transfer intent.
const DS_TRANSFER: &[u8] = b"PORST-WALLET-v1:transfer";
/// Domain tag binding a digest to a token-swap intent.
const DS_SWAP: &[u8] = b"PORST-WALLET-v1:swap";
/// Domain tag binding the swap route (which DEX program + pool).
const DS_ROUTE: &[u8] = b"PORST-WALLET-v1:route";
/// Domain tag binding a digest to opening a perpetual-futures position.
const DS_PERP_OPEN: &[u8] = b"PORST-WALLET-v1:perp-open";
/// Domain tag binding a digest to closing a perpetual-futures position.
const DS_PERP_CLOSE: &[u8] = b"PORST-WALLET-v1:perp-close";

/// Message digest signed for a SOL-transfer intent:
/// `keccak256(DS_TRANSFER ‖ xmss_root ‖ epoch ‖ nonce ‖ recipient ‖ amount)`,
/// all integers big-endian. Binding `xmss_root`, `epoch`, and `nonce` makes
/// every authorized transfer unique to this wallet and un-replayable.
pub fn transfer_digest(
    xmss_root: &[u8; 32],
    epoch: u64,
    nonce: u64,
    recipient: &[u8; 32],
    amount: u64,
) -> [u8; 32] {
    keccak::hashv(&[
        DS_TRANSFER,
        xmss_root,
        &epoch.to_be_bytes(),
        &nonce.to_be_bytes(),
        recipient,
        &amount.to_be_bytes(),
    ])
    .to_bytes()
}

/// Route binding: which DEX program and pool a swap is authorized to touch.
/// `route_hash = keccak256(DS_ROUTE ‖ amm_program ‖ pool)`. The agent computes
/// this and signs it inside the swap digest; the on-chain program recomputes it
/// from the accounts it is about to CPI into and requires a match — so a valid
/// signature authorizes *exactly one* route, not arbitrary DEX calls.
pub fn route_hash(amm_program: &[u8; 32], pool: &[u8; 32]) -> [u8; 32] {
    keccak::hashv(&[DS_ROUTE, amm_program, pool]).to_bytes()
}

/// Message digest signed for a token-swap intent:
/// `keccak256(DS_SWAP ‖ xmss_root ‖ epoch ‖ nonce ‖ input_mint ‖ output_mint ‖
/// amount_in ‖ min_out ‖ route_hash ‖ expiry)`.
///
/// Binds every parameter the agent proposed: which tokens, how much in, the
/// minimum acceptable out (slippage floor), the exact route, and an expiry —
/// plus `(xmss_root, epoch, nonce)` for replay protection. The chain recomputes
/// this digest from its own state + the instruction args, so the model/agent
/// cannot substitute any field after signing.
#[allow(clippy::too_many_arguments)]
pub fn swap_digest(
    xmss_root: &[u8; 32],
    epoch: u64,
    nonce: u64,
    input_mint: &[u8; 32],
    output_mint: &[u8; 32],
    amount_in: u64,
    min_out: u64,
    route_hash: &[u8; 32],
    expiry: i64,
) -> [u8; 32] {
    keccak::hashv(&[
        DS_SWAP,
        xmss_root,
        &epoch.to_be_bytes(),
        &nonce.to_be_bytes(),
        input_mint,
        output_mint,
        &amount_in.to_be_bytes(),
        &min_out.to_be_bytes(),
        route_hash,
        &expiry.to_be_bytes(),
    ])
    .to_bytes()
}

/// Message digest signed to OPEN a perpetual-futures position:
/// `keccak256(DS_PERP_OPEN ‖ xmss_root ‖ epoch ‖ nonce ‖ market ‖ side ‖
/// collateral ‖ leverage ‖ max_entry_price ‖ sl_price ‖ tp_price ‖ expiry)`.
///
/// Binds every parameter the agent proposed: which market, long/short (`side`:
/// 0 = long, 1 = short), the USDT collateral, the leverage, the worst entry
/// price the trader will accept (oracle-priced slippage guard), the stop-loss
/// and take-profit trigger prices (0 = unset), and an expiry — plus
/// `(xmss_root, epoch, nonce)` for replay protection. Prices are fixed-point
/// (USDT-per-SOL × 1e6). The on-chain program recomputes this from its own
/// `Trader` state + the instruction args, so nothing can be substituted after
/// signing. The signed `sl_price`/`tp_price` are what later authorizes a
/// permissionless keeper trigger — no second signature needed.
#[allow(clippy::too_many_arguments)]
pub fn open_perp_digest(
    xmss_root: &[u8; 32],
    epoch: u64,
    nonce: u64,
    market: &[u8; 32],
    side: u8,
    collateral: u64,
    leverage: u64,
    max_entry_price: u64,
    sl_price: u64,
    tp_price: u64,
    expiry: i64,
) -> [u8; 32] {
    keccak::hashv(&[
        DS_PERP_OPEN,
        xmss_root,
        &epoch.to_be_bytes(),
        &nonce.to_be_bytes(),
        market,
        &[side],
        &collateral.to_be_bytes(),
        &leverage.to_be_bytes(),
        &max_entry_price.to_be_bytes(),
        &sl_price.to_be_bytes(),
        &tp_price.to_be_bytes(),
        &expiry.to_be_bytes(),
    ])
    .to_bytes()
}

/// Message digest signed to CLOSE a perpetual-futures position:
/// `keccak256(DS_PERP_CLOSE ‖ xmss_root ‖ epoch ‖ nonce ‖ position ‖ expiry)`.
///
/// Binds the exact `position` account being closed plus `(xmss_root, epoch,
/// nonce, expiry)`. Settlement uses the live oracle price, so there is no
/// amount to bind — the position fully determines the payout. Liquidations and
/// stop-loss/take-profit triggers are settled by the same path but are
/// permissionless (protocol-enforced or pre-authorized at open), so they do
/// not consume a signature.
pub fn close_perp_digest(
    xmss_root: &[u8; 32],
    epoch: u64,
    nonce: u64,
    position: &[u8; 32],
    expiry: i64,
) -> [u8; 32] {
    keccak::hashv(&[
        DS_PERP_CLOSE,
        xmss_root,
        &epoch.to_be_bytes(),
        &nonce.to_be_bytes(),
        position,
        &expiry.to_be_bytes(),
    ])
    .to_bytes()
}

/// Fold an epoch root `r` with its XMSS authentication path up to the XMSS root,
/// using the bits of `epoch` to decide left/right at each level.
pub fn xmss_root_from_path(r: &[u8; 32], auth: &[[u8; 32]], epoch: u64) -> [u8; 32] {
    let mut node = *r;
    for (level, sib) in auth.iter().enumerate() {
        if (epoch >> level) & 1 == 0 {
            node = hash2(&node, sib);
        } else {
            node = hash2(sib, &node);
        }
    }
    node
}

/// Verify a full many-time wallet signature `sig = salt ‖ porst_stream ‖
/// xmss_auth` against the wallet public key `xmss_root` for `(digest, epoch)`.
///
/// The PORST multiproof reconstructs epoch `epoch`'s root `R`; the trailing
/// `XMSS_HEIGHT` siblings must fold `R` up to `xmss_root`, and the buffer length
/// must be exactly `porst_stream_len + XMSS_HEIGHT*32` (no slack), which binds
/// the boundary between the two parts.
pub fn verify_wallet_sig(xmss_root: &[u8; 32], digest: &[u8; 32], sig: &[u8], epoch: u64) -> bool {
    let (root, consumed) = match compute_porst_root(digest, sig) {
        Some(v) => v,
        None => return false,
    };
    // A signature verified against a *different* digest derives a different leaf
    // subset, so the multiproof can consume more bytes than the buffer holds.
    // Reject cleanly rather than panicking on the slice (matters on-chain).
    if consumed > sig.len() {
        return false;
    }
    let auth_bytes = &sig[consumed..];
    if auth_bytes.len() != (XMSS_HEIGHT as usize) * 32 {
        return false;
    }
    let mut node = root;
    for (level, sib) in auth_bytes.chunks_exact(32).enumerate() {
        let sib: [u8; 32] = sib.try_into().unwrap();
        if (epoch >> level) & 1 == 0 {
            node = hash2(&node, &sib);
        } else {
            node = hash2(&sib, &node);
        }
    }
    &node == xmss_root
}
