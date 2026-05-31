//! Hardened off-chain keygen and many-time signing for the PORST wallet.
//!
//! PORST alone is a *few-time* scheme: one Merkle tree over `2^TREE_HEIGHT`
//! leaves can safely sign only `SIGNING_CAPACITY` messages before revealed
//! preimages let an adversary forge. To build a usable wallet we layer **XMSS**
//! over `NUM_EPOCHS = 2^XMSS_HEIGHT` independent PORST keys:
//!
//! * Each epoch `j` has its own PORST tree with root `R_j`, derived
//!   deterministically from the wallet seed via a domain-separated PRF.
//! * An XMSS Merkle tree is built over `R_0..R_{NUM_EPOCHS-1}`; its root is the
//!   wallet public key.
//! * A signature for epoch `j` is `PORST_sig(R_j) ‖ xmss_auth_path(j)` — the
//!   PORST part reconstructs `R_j`, and the auth path proves `R_j` is leaf `j`
//!   of the XMSS tree, folding up to the wallet public key.
//!
//! Total lifetime capacity is `NUM_EPOCHS * SIGNING_CAPACITY`. Signing is
//! *stateful*: each epoch may be used at most `SIGNING_CAPACITY` times. The
//! on-chain wallet enforces this and is the source of truth for `(epoch, used,
//! nonce)`; this library is deterministic given `(seed, epoch, message)`.
//!
//! All hashing is Ethereum-compatible Keccak-256, identical to the on-chain
//! verifier and to `PORST.sol`.

use porst_core::{derive_subset, hash1, hash2, SUBSET_SIZE, TREE_HEIGHT};
use serde::{Deserialize, Serialize};
use solana_keccak_hasher as keccak;

// The wallet's shared verification primitives live in `porst-core` (single
// source of truth, also used by the on-chain program). Re-export them here so
// callers of the signer have one import surface.
pub use porst_core::{
    close_perp_digest, open_perp_digest, route_hash, swap_digest, transfer_digest,
    verify_wallet_sig, xmss_root_from_path, NUM_EPOCHS, SIGNING_CAPACITY, XMSS_HEIGHT,
};

/// Total leaves per PORST tree.
pub const NUM_LEAVES: usize = 1 << TREE_HEIGHT;

// Signing-only domain-separation tags (the verifier never needs these): the
// preimage PRF and the deterministic per-message salt.
const DS_PRE: &[u8] = b"PORST-WALLET-v1:preimage";
const DS_SALT: &[u8] = b"PORST-WALLET-v1:salt";

/// Secret wallet keystore. `seed` is the only true secret; everything else is
/// derivable from it but cached so that signing rebuilds only one PORST tree.
#[derive(Serialize, Deserialize, Clone)]
pub struct Keystore {
    pub version: u32,
    /// 32-byte master seed, hex-encoded. SECRET.
    pub seed: String,
    /// XMSS root = wallet public key, hex-encoded.
    pub xmss_root: String,
    /// Full 1-indexed XMSS node array (`2 * NUM_EPOCHS` entries), hex-encoded.
    /// Cached so signing can read auth paths without rebuilding every PORST tree.
    pub xmss_nodes: Vec<String>,
}

fn be8(x: u64) -> [u8; 8] {
    x.to_be_bytes()
}

/// PRF deriving the preimage of leaf `leaf` in epoch `epoch`:
/// `keccak256(DS_PRE ‖ seed ‖ epoch ‖ leaf)`.
fn prf_preimage(seed: &[u8; 32], epoch: u64, leaf: u32) -> [u8; 32] {
    keccak::hashv(&[DS_PRE, seed, &be8(epoch), &leaf.to_be_bytes()]).to_bytes()
}

/// Deterministic per-message salt: `keccak256(DS_SALT ‖ seed ‖ epoch ‖ digest)`.
/// Derived from the secret seed so it cannot be ground by an adversary.
fn derive_salt(seed: &[u8; 32], epoch: u64, digest: &[u8; 32]) -> [u8; 32] {
    keccak::hashv(&[DS_SALT, seed, &be8(epoch), digest]).to_bytes()
}

/// Build epoch `epoch`'s PORST tree from the seed.
/// Returns `(preimages, tree)` with `tree` 1-indexed: `tree[1]` is the root,
/// leaves in `[NUM_LEAVES .. 2*NUM_LEAVES)`.
fn build_epoch_tree(seed: &[u8; 32], epoch: u64) -> (Vec<[u8; 32]>, Vec<[u8; 32]>) {
    let mut preimages = vec![[0u8; 32]; NUM_LEAVES];
    let mut tree = vec![[0u8; 32]; 2 * NUM_LEAVES];
    for i in 0..NUM_LEAVES {
        let pre = prf_preimage(seed, epoch, i as u32);
        preimages[i] = pre;
        tree[NUM_LEAVES + i] = hash1(&pre);
    }
    for i in (1..NUM_LEAVES).rev() {
        tree[i] = hash2(&tree[2 * i], &tree[2 * i + 1]);
    }
    (preimages, tree)
}

fn msb(mut x: u32) -> u32 {
    let mut r = 0;
    while x > 1 {
        x >>= 1;
        r += 1;
    }
    r
}

/// Produce the PORST signature bytes `salt ‖ <stream>` for one tree, mirroring
/// `PORST.sol`'s witness ordering (the verifier consumes exactly this).
fn porst_sign(salt: &[u8; 32], digest: &[u8; 32], preimages: &[[u8; 32]], tree: &[[u8; 32]]) -> Vec<u8> {
    let subset = derive_subset(digest, salt);
    let mut elems: Vec<[u8; 32]> = Vec::new();
    let mut frontier: Vec<Option<[u8; 32]>> = vec![None; (TREE_HEIGHT as usize) + 1];

    for idx in 0..SUBSET_SIZE {
        let i = subset[idx] as usize;
        let park_level = if idx + 1 < SUBSET_SIZE {
            msb(subset[idx] ^ subset[idx + 1])
        } else {
            TREE_HEIGHT
        };

        elems.push(preimages[i]);
        let mut node = hash1(&preimages[i]);

        for lvl in 0..park_level {
            let c = (i >> lvl) & 1;
            let sib_idx = ((NUM_LEAVES + i) >> lvl) ^ 1;
            if c == 0 {
                elems.push(tree[sib_idx]);
                node = hash2(&node, &tree[sib_idx]);
            } else if frontier[lvl as usize].is_none() {
                elems.push(tree[sib_idx]);
                node = hash2(&tree[sib_idx], &node);
            } else {
                let parked = frontier[lvl as usize].take().unwrap();
                node = hash2(&parked, &node);
            }
        }
        frontier[park_level as usize] = Some(node);
    }

    let mut sig = Vec::with_capacity(32 + elems.len() * 32);
    sig.extend_from_slice(salt);
    for e in &elems {
        sig.extend_from_slice(e);
    }
    sig
}

/// Number of epochs as a `usize`, for indexing/sizing.
const EPOCHS: usize = NUM_EPOCHS as usize;

/// Build the XMSS node array (1-indexed, `2 * NUM_EPOCHS`) over the epoch roots.
fn build_xmss(roots: &[[u8; 32]]) -> Vec<[u8; 32]> {
    let mut nodes = vec![[0u8; 32]; 2 * EPOCHS];
    for (j, r) in roots.iter().enumerate() {
        nodes[EPOCHS + j] = *r;
    }
    for i in (1..EPOCHS).rev() {
        nodes[i] = hash2(&nodes[2 * i], &nodes[2 * i + 1]);
    }
    nodes
}

/// XMSS authentication path for leaf `epoch`: the sibling at each level from the
/// leaf up to (but excluding) the root, length `XMSS_HEIGHT`.
fn xmss_auth(nodes: &[[u8; 32]], epoch: u64) -> Vec<[u8; 32]> {
    let mut auth = Vec::with_capacity(XMSS_HEIGHT as usize);
    for level in 0..XMSS_HEIGHT {
        let sib = ((NUM_EPOCHS + epoch) >> level) ^ 1;
        auth.push(nodes[sib as usize]);
    }
    auth
}

/// Generate a keystore from a 32-byte master seed.
pub fn keygen(seed: &[u8; 32]) -> Keystore {
    let mut roots = vec![[0u8; 32]; EPOCHS];
    for (j, root) in roots.iter_mut().enumerate() {
        let (_pre, tree) = build_epoch_tree(seed, j as u64);
        *root = tree[1];
    }
    let nodes = build_xmss(&roots);
    Keystore {
        version: 1,
        seed: hex::encode(seed),
        xmss_root: hex::encode(nodes[1]),
        xmss_nodes: nodes.iter().map(hex::encode).collect(),
    }
}

/// Sign `digest` with epoch `epoch`'s key. Returns the full wallet signature
/// `salt ‖ porst_stream ‖ xmss_auth`.
pub fn sign_digest(ks: &Keystore, epoch: u64, digest: &[u8; 32]) -> Vec<u8> {
    let seed = decode32(&ks.seed);
    let (pre, tree) = build_epoch_tree(&seed, epoch);
    let salt = derive_salt(&seed, epoch, digest);
    let mut sig = porst_sign(&salt, digest, &pre, &tree);

    let nodes: Vec<[u8; 32]> = ks.xmss_nodes.iter().map(|h| decode32(h)).collect();
    for sib in xmss_auth(&nodes, epoch) {
        sig.extend_from_slice(&sib);
    }
    sig
}

fn decode32(h: &str) -> [u8; 32] {
    let v = hex::decode(h).expect("valid hex");
    let mut out = [0u8; 32];
    out.copy_from_slice(&v);
    out
}

/// Decode a hex string into a 32-byte array (public helper for the CLI).
pub fn hex32(h: &str) -> Result<[u8; 32], String> {
    let v = hex::decode(h.trim()).map_err(|e| e.to_string())?;
    if v.len() != 32 {
        return Err(format!("expected 32 bytes, got {}", v.len()));
    }
    let mut out = [0u8; 32];
    out.copy_from_slice(&v);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed_of(b: u8) -> [u8; 32] {
        [b; 32]
    }

    #[test]
    fn keygen_is_deterministic() {
        let s = seed_of(7);
        assert_eq!(keygen(&s).xmss_root, keygen(&s).xmss_root);
    }

    #[test]
    fn sign_then_verify_each_epoch() {
        let seed = seed_of(3);
        let ks = keygen(&seed);
        let root = hex32(&ks.xmss_root).unwrap();
        let recipient = [9u8; 32];
        // exercise the first, a middle, and the last epoch
        for &epoch in &[0u64, 7, (NUM_EPOCHS as u64) - 1] {
            let digest = transfer_digest(&root, epoch, 0, &recipient, 1_000_000);
            let sig = sign_digest(&ks, epoch, &digest);
            assert!(verify_wallet_sig(&root, &digest, &sig, epoch), "epoch {epoch} should verify");
        }
    }

    #[test]
    fn wrong_epoch_fails() {
        let seed = seed_of(5);
        let ks = keygen(&seed);
        let root = hex32(&ks.xmss_root).unwrap();
        let recipient = [1u8; 32];
        let digest = transfer_digest(&root, 2, 0, &recipient, 5);
        let sig = sign_digest(&ks, 2, &digest);
        // correct epoch verifies, a different epoch's fold does not
        assert!(verify_wallet_sig(&root, &digest, &sig, 2));
        assert!(!verify_wallet_sig(&root, &digest, &sig, 3));
    }

    #[test]
    fn tampered_signature_fails() {
        let seed = seed_of(11);
        let ks = keygen(&seed);
        let root = hex32(&ks.xmss_root).unwrap();
        let recipient = [2u8; 32];
        let digest = transfer_digest(&root, 1, 0, &recipient, 42);
        let mut sig = sign_digest(&ks, 1, &digest);
        sig[50] ^= 0xff; // corrupt the PORST stream
        assert!(!verify_wallet_sig(&root, &digest, &sig, 1));

        let mut sig2 = sign_digest(&ks, 1, &digest);
        let n = sig2.len();
        sig2[n - 1] ^= 0xff; // corrupt the XMSS auth path
        assert!(!verify_wallet_sig(&root, &digest, &sig2, 1));
    }

    #[test]
    fn wrong_message_fails() {
        let seed = seed_of(13);
        let ks = keygen(&seed);
        let root = hex32(&ks.xmss_root).unwrap();
        let recipient = [3u8; 32];
        let digest = transfer_digest(&root, 0, 0, &recipient, 100);
        let sig = sign_digest(&ks, 0, &digest);
        let other = transfer_digest(&root, 0, 1, &recipient, 100); // different nonce
        assert!(!verify_wallet_sig(&root, &other, &sig, 0));
    }

    #[test]
    fn perp_open_sign_then_verify() {
        let seed = seed_of(17);
        let ks = keygen(&seed);
        let root = hex32(&ks.xmss_root).unwrap();
        let market = [4u8; 32];
        for &epoch in &[0u64, 9, (NUM_EPOCHS as u64) - 1] {
            let digest = open_perp_digest(
                &root, epoch, 3, &market, 0, 250_000_000, 5, 160_000_000, 140_000_000,
                190_000_000, 1_900_000_000,
            );
            let sig = sign_digest(&ks, epoch, &digest);
            assert!(verify_wallet_sig(&root, &digest, &sig, epoch), "epoch {epoch}");
        }
    }

    #[test]
    fn perp_open_field_tampering_fails() {
        let seed = seed_of(19);
        let ks = keygen(&seed);
        let root = hex32(&ks.xmss_root).unwrap();
        let market = [4u8; 32];
        let digest = open_perp_digest(
            &root, 2, 0, &market, 0, 250_000_000, 5, 160_000_000, 0, 0, 1_900_000_000,
        );
        let sig = sign_digest(&ks, 2, &digest);
        assert!(verify_wallet_sig(&root, &digest, &sig, 2));
        // Flip long -> short: a different digest, the signature must not verify.
        let flipped = open_perp_digest(
            &root, 2, 0, &market, 1, 250_000_000, 5, 160_000_000, 0, 0, 1_900_000_000,
        );
        assert!(!verify_wallet_sig(&root, &flipped, &sig, 2));
        // Bump leverage 5 -> 10.
        let levered = open_perp_digest(
            &root, 2, 0, &market, 0, 250_000_000, 10, 160_000_000, 0, 0, 1_900_000_000,
        );
        assert!(!verify_wallet_sig(&root, &levered, &sig, 2));
    }

    #[test]
    fn perp_close_sign_then_verify() {
        let seed = seed_of(23);
        let ks = keygen(&seed);
        let root = hex32(&ks.xmss_root).unwrap();
        let position = [7u8; 32];
        let digest = close_perp_digest(&root, 1, 4, &position, 1_900_000_000);
        let sig = sign_digest(&ks, 1, &digest);
        assert!(verify_wallet_sig(&root, &digest, &sig, 1));
        // A different position must not verify under the same signature.
        let other = close_perp_digest(&root, 1, 4, &[8u8; 32], 1_900_000_000);
        assert!(!verify_wallet_sig(&root, &other, &sig, 1));
    }
}
