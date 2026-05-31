//! Reference signer for PORST — host-only (never compiled into the on-chain
//! program). Mirrors `PORST.t.sol`'s `setUp`/`_sign` so we can produce valid
//! signatures and known-good test vectors that exercise the on-chain
//! [`crate::verify::verify_porst`].

use porst_core::{derive_subset, hash1, hash2, SUBSET_SIZE, TREE_HEIGHT};

/// Total number of leaves, `2^TREE_HEIGHT`.
pub const NUM_LEAVES: usize = 1 << TREE_HEIGHT;

/// Build the deterministic tree used by the Solidity test:
/// `preimages[i] = keccak256(i)` (i as a 32-byte big-endian word),
/// leaf hash `tree[N+i] = keccak256(preimages[i])`,
/// internal `tree[i] = keccak256(tree[2i] ‖ tree[2i+1])`.
///
/// Returns `(preimages, tree)` with `tree` 1-indexed: `tree[1]` is the root and
/// leaves live in `[NUM_LEAVES .. 2*NUM_LEAVES)`.
pub fn build_tree() -> (Vec<[u8; 32]>, Vec<[u8; 32]>) {
    let mut preimages = vec![[0u8; 32]; NUM_LEAVES];
    let mut tree = vec![[0u8; 32]; 2 * NUM_LEAVES];
    for i in 0..NUM_LEAVES {
        let mut idx = [0u8; 32];
        idx[24..32].copy_from_slice(&(i as u64).to_be_bytes());
        let pre = hash1(&idx);
        preimages[i] = pre;
        tree[NUM_LEAVES + i] = hash1(&pre);
    }
    for i in (1..NUM_LEAVES).rev() {
        tree[i] = hash2(&tree[2 * i], &tree[2 * i + 1]);
    }
    (preimages, tree)
}

/// Index of the most-significant set bit of `x` (`x > 0`).
fn msb(mut x: u32) -> u32 {
    let mut r = 0;
    while x > 1 {
        x >>= 1;
        r += 1;
    }
    r
}

/// Construct a valid signature `salt ‖ <streamed preimages/witnesses>` for the
/// given message hash, mirroring `PORST.t.sol::_sign` exactly.
pub fn sign(salt: &[u8; 32], hash: &[u8; 32], preimages: &[[u8; 32]], tree: &[[u8; 32]]) -> Vec<u8> {
    let subset = derive_subset(hash, salt);
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

/// `keccak256` of an arbitrary byte string — used to derive message hashes.
pub fn keccak_bytes(b: &[u8]) -> [u8; 32] {
    solana_keccak_hasher::hashv(&[b]).to_bytes()
}

#[cfg(test)]
mod gen {
    use super::*;
    use std::fmt::Write as _;

    fn hex(b: &[u8]) -> String {
        let mut s = String::with_capacity(b.len() * 2);
        for x in b {
            write!(s, "{:02x}", x).unwrap();
        }
        s
    }

    fn salt_u(n: u64) -> [u8; 32] {
        let mut s = [0u8; 32];
        s[24..32].copy_from_slice(&n.to_be_bytes());
        s
    }

    /// Emit known-good test vectors (root + exact signature bytes) consumed by
    /// the TypeScript integration test. Run with:
    ///   cargo test -p porst emit_vectors -- --ignored --nocapture
    #[test]
    #[ignore]
    fn emit_vectors() {
        let (pre, tree) = build_tree();
        let root = tree[1];

        let cases: Vec<(&str, [u8; 32], [u8; 32])> = vec![
            ("valid_test_message", keccak_bytes(b"test message"), salt_u(42)),
            ("valid_diff_salt", keccak_bytes(b"hello world"), salt_u(0xdead_beef)),
            ("valid_zero_hash", [0u8; 32], salt_u(1)),
            ("valid_zero_salt", keccak_bytes(b"msg"), [0u8; 32]),
        ];

        let mut out = String::new();
        out.push_str("{\n");
        out.push_str(&format!("  \"treeHeight\": {},\n", TREE_HEIGHT));
        out.push_str(&format!("  \"subsetSize\": {},\n", SUBSET_SIZE));
        out.push_str(&format!("  \"root\": \"{}\",\n", hex(&root)));
        out.push_str(&format!("  \"wrongRoot\": \"{}\",\n", hex(&keccak_bytes(b"wrong key"))));
        out.push_str(&format!("  \"wrongHash\": \"{}\",\n", hex(&keccak_bytes(b"wrong message"))));
        out.push_str("  \"cases\": [\n");
        for (idx, (name, hash, salt)) in cases.iter().enumerate() {
            let sig = sign(salt, hash, &pre, &tree);
            // sanity: every emitted vector must verify against the root
            assert!(crate::verify::verify_porst(&root, hash, &sig), "{name} failed self-check");
            out.push_str("    {\n");
            out.push_str(&format!("      \"name\": \"{}\",\n", name));
            out.push_str(&format!("      \"hash\": \"{}\",\n", hex(hash)));
            out.push_str(&format!("      \"salt\": \"{}\",\n", hex(salt)));
            out.push_str(&format!("      \"sig\": \"{}\"\n", hex(&sig)));
            out.push_str(if idx + 1 == cases.len() { "    }\n" } else { "    },\n" });
        }
        out.push_str("  ]\n}\n");

        let path = format!("{}/../../tests/vectors.json", env!("CARGO_MANIFEST_DIR"));
        std::fs::write(&path, out).unwrap();
        eprintln!("wrote {path}");
    }
}
