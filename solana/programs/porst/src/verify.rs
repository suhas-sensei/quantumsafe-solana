//! PORST verification for the few-time (single-tree) program.
//!
//! The cryptography lives in the shared [`porst_core`] crate so that this
//! program, the many-time `porst_wallet` program, and the off-chain signer all
//! use one implementation. This module simply re-exports it and hosts the
//! parity tests against the reference signer.

pub use porst_core::{verify_porst, SUBSET_SIZE, TREE_HEIGHT};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reference::{build_tree, sign};
    use solana_keccak_hasher as keccak;

    fn keccak_str(s: &str) -> [u8; 32] {
        keccak::hash(s.as_bytes()).to_bytes()
    }

    #[test]
    fn valid_signature() {
        let (pre, tree) = build_tree();
        let root = tree[1];
        let hash = keccak_str("test message");
        let mut salt = [0u8; 32];
        salt[31] = 42;
        let sig = sign(&salt, &hash, &pre, &tree);
        assert!(verify_porst(&root, &hash, &sig));
    }

    #[test]
    fn valid_zero_hash_and_salt() {
        let (pre, tree) = build_tree();
        let root = tree[1];
        let hash = [0u8; 32];
        let salt = [0u8; 32];
        let sig = sign(&salt, &hash, &pre, &tree);
        assert!(verify_porst(&root, &hash, &sig));
    }

    #[test]
    fn invalid_wrong_hash() {
        let (pre, tree) = build_tree();
        let root = tree[1];
        let hash = keccak_str("test message");
        let mut salt = [0u8; 32];
        salt[31] = 42;
        let sig = sign(&salt, &hash, &pre, &tree);
        assert!(!verify_porst(&root, &keccak_str("wrong message"), &sig));
    }

    #[test]
    fn invalid_empty_and_salt_only() {
        let (_pre, tree) = build_tree();
        let root = tree[1];
        let hash = keccak_str("msg");
        assert!(!verify_porst(&root, &hash, &[]));
        assert!(!verify_porst(&root, &hash, &[0u8; 32]));
    }

    #[test]
    fn invalid_truncated_and_extra() {
        let (pre, tree) = build_tree();
        let root = tree[1];
        let hash = keccak_str("test message");
        let mut salt = [0u8; 32];
        salt[31] = 42;
        let sig = sign(&salt, &hash, &pre, &tree);

        let truncated = &sig[..sig.len() - 32];
        assert!(!verify_porst(&root, &hash, truncated));

        let mut extra = sig.clone();
        extra.extend_from_slice(&[0u8; 32]);
        assert!(!verify_porst(&root, &hash, &extra));
    }

    #[test]
    fn invalid_corrupted_witness() {
        let (pre, tree) = build_tree();
        let root = tree[1];
        let hash = keccak_str("test message");
        let mut salt = [0u8; 32];
        salt[31] = 42;
        let mut sig = sign(&salt, &hash, &pre, &tree);
        sig[100] ^= 0xff;
        assert!(!verify_porst(&root, &hash, &sig));
    }

    #[test]
    fn invalid_wrong_pubkey() {
        let (pre, tree) = build_tree();
        let hash = keccak_str("test message");
        let mut salt = [0u8; 32];
        salt[31] = 42;
        let sig = sign(&salt, &hash, &pre, &tree);
        let wrong = keccak_str("wrong key");
        assert!(!verify_porst(&wrong, &hash, &sig));
    }
}
