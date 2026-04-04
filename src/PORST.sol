// SPDX-License-Identifier: MIT
pragma solidity =0.8.34;

import {IERC1271} from "./interfaces/IERC1271.sol";

/// https://eprint.iacr.org/2017/933.pdf
contract PORST is IERC1271 {
    // For security; given a signing capacity `r`, tree height `a` (total leaves `2ᵃ`)
    // [TREE_HEIGHT], and subset size `k` [SUBSET_SIZE]; you must choose parameters such that:
    //
    // k-1
    // Sum[ log_2(k*r - j) - log_2(2**a - j) ] < -256
    // j=0
    //
    // Signature verification costs are dominated by the size of the witness. The following table
    // gives suggested average-witness-optimizing choices for `TREE_HEIGHT` and `SUBSET_SIZE` given
    // a specific target signing capacity.
    //
    // | `log_2(r)` | `TREE_HEIGHT` | `SUBSET_SIZE` | average witness size |
    // | :--------- | :------------ | :------------ | :------------------- |
    // | 1          | 16            | 24            | 8877 bytes           |
    // | 1          | 24            | 13            | 8514 bytes           |
    // | 4          | 16            | 38            | 13236 bytes          |
    // | 4          | 24            | 16            | 10320 bytes          |
    // | 8          | 24            | 23            | 14439 bytes          |
    // | 10         | 24            | 28            | 17319 bytes          |
    // | 16         | 32            | 23            | 20327 bytes          |
    // | 20         | 32            | 38            | 32688 bytes          |
    uint256 internal constant TREE_HEIGHT = 16;
    uint256 internal constant SUBSET_SIZE = 24;

    bytes32 public immutable pubkey;

    constructor(bytes32 pubkey_) {
        pubkey = pubkey_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view override returns (bytes4) {
        bytes32 pubkey_ = pubkey;
        assembly { // not `"memory-safe"`
            // the first word is the public salt used to derive the subset
            mstore(0x20, calldataload(signature.offset))
            mstore(0x00, hash)
            mstore(0x20, keccak256(0x00, 0x40))
            mstore(0x00, 0x00)

            // determine the subset of preimages that serve as the signature

            let subset_end := 0x40
            for {
                let end := add(shl(0x05, SUBSET_SIZE), subset_end)
                let seed
                let reseed_interval := div(0x100, TREE_HEIGHT)
                let seed_count := reseed_interval
            } xor(subset_end, end) {} {
                if iszero(gt(reseed_interval, seed_count)) {
                    seed := keccak256(0x00, 0x40)
                    mstore(0x00, seed)
                    seed_count := 0x00
                }
                seed_count := add(0x01, seed_count)
                let selection := and(sub(shl(TREE_HEIGHT, 0x01), 0x01), seed)
                seed := shr(TREE_HEIGHT, seed)

                let left := 0x40
                let right := subset_end
                for {} lt(left, right) {} {
                    let mid := and(not(0x1f), shr(0x01, add(left, right)))
                    let mid_val := mload(mid)
                    switch lt(mid_val, selection)
                    case false { right := mid }
                    default { left := add(0x20, mid) }
                }
                if and(lt(left, subset_end), eq(mload(left), selection)) { continue }

                mcopy(add(0x20, left), left, sub(subset_end, left))
                mstore(left, selection)
                subset_end := add(0x20, subset_end)
            }

            // verify the Merkle multiproof that the correct preimages have been supplied

            let cursor := add(0x20, signature.offset)
            let frontier_base := add(0x40, shl(0x05, SUBSET_SIZE))
            for { let subset_ptr := 0x40 } lt(subset_ptr, subset_end) { subset_ptr := add(0x20, subset_ptr) } {
                let i := mload(subset_ptr)
                let next_ptr := add(0x20, subset_ptr)
                let park_level :=
                    xor(
                        TREE_HEIGHT,
                        mul(lt(next_ptr, subset_end), xor(TREE_HEIGHT, sub(0xff, clz(xor(mload(next_ptr), i)))))
                    )

                // hash leaf preimage
                mstore(0x00, calldataload(cursor))
                let node := keccak256(0x00, 0x20)
                cursor := add(cursor, 0x20)

                // ascend from level 0 toward park_level
                for { let level } lt(level, park_level) { level := add(0x01, level) } {
                    let c := and(0x01, shr(level, i))
                    mstore(shl(0x05, c), node)

                    switch c
                    case false {
                        // sibling is a witness from the stream
                        mstore(0x20, calldataload(cursor))
                        cursor := add(0x20, cursor)
                    }
                    default {
                        // sibling is in frontier or stream
                        let frontier_ptr := add(frontier_base, shl(0x05, level))
                        let parked := mload(frontier_ptr)
                        switch parked
                        case 0x00 {
                            mstore(0x00, calldataload(cursor))
                            cursor := add(0x20, cursor)
                        }
                        default {
                            mstore(0x00, parked)
                            mstore(frontier_ptr, 0x00)
                        }
                    }
                    node := keccak256(0x00, 0x40)
                }

                mstore(add(frontier_base, shl(0x05, park_level)), node)
            }

            let success := eq(cursor, add(signature.offset, signature.length))
            success := and(eq(pubkey_, mload(add(frontier_base, shl(0x05, TREE_HEIGHT)))), success)

            mstore(0x00, shl(0xe0, xor(0xffffffff, mul(0xe9d94581, success))))
            return(0x00, 0x20)
        }
    }
}
