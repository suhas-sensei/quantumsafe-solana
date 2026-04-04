// SPDX-License-Identifier: MIT
pragma solidity =0.8.34;

import {IERC1271} from "./interfaces/IERC1271.sol";

/// https://eprint.iacr.org/2017/933.pdf
contract PORST is IERC1271 {
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
            calldatacopy(0x00, signature.offset, 0x20)
            mstore(0x20, hash)
            mstore(0x00, keccak256(0x00, 0x40))

            // determine the subset of preimages that serve as the signature

            let heap_end := 0x40
            for {
                let end := add(shl(0x05, SUBSET_SIZE), heap_end)
                let seed
                let reseed_interval := div(0x100, TREE_HEIGHT)
                let seed_count := reseed_interval
            } xor(heap_end, end) { } {
                if iszero(gt(reseed_interval, seed_count)) {
                    seed := keccak256(0x00, 0x20)
                    mstore(0x00, seed)
                    seed_count := 0x00
                }
                seed_count := add(0x01, seed_count)
                let selection := and(sub(shl(TREE_HEIGHT, 0x01), 0x01), seed)
                seed := shr(TREE_HEIGHT, seed)

                let found
                for {
                    let stack_ptr := heap_end
                    mstore(stack_ptr, 0x40)
                    stack_ptr := add(stack_ptr, 0x20)
                } gt(stack_ptr, heap_end) { } {
                    stack_ptr := sub(stack_ptr, 0x20)
                    let node := mload(stack_ptr)
                    if lt(node, heap_end) {
                        let node_val := mload(node)
                        if eq(node_val, selection) {
                            found := true
                            break
                        }
                        if lt(node_val, selection) {
                            let right_child := shl(0x01, node)
                            let left_child := sub(right_child, 0x20)
                            mstore(stack_ptr, right_child)
                            stack_ptr := add(0x20, stack_ptr)
                            mstore(stack_ptr, left_child)
                            stack_ptr := add(0x20, stack_ptr)
                        }
                    }
                }
                if found { continue }

                for {
                    mstore(heap_end, selection)
                    let child_ptr := heap_end
                } lt(0x40, child_ptr) { } {
                    let parent_ptr := add(0x20, and(not(0x1f), shr(0x01, sub(child_ptr, 0x20))))
                    let child_val := mload(child_ptr)
                    let parent_val := mload(parent_ptr)
                    if iszero(lt(child_val, parent_val)) { break }
                    mstore(child_ptr, parent_val)
                    mstore(parent_ptr, child_val)
                    child_ptr := parent_ptr
                }
                heap_end := add(heap_end, 0x20)
            }

            // verify the Merkle multiproof that the correct preimages have been supplied

            let cursor := add(0x20, signature.offset)

            let frontier_base := add(0x40, shl(0x05, SUBSET_SIZE))
            let frontier_size := shl(0x05, TREE_HEIGHT)
            codecopy(frontier_base, codesize(), frontier_size) // zeroize scratch space

            for { } xor(0x40, heap_end) { } {
                // pop
                let i := mload(0x40)
                heap_end := sub(heap_end, 0x20)

                // sift down
                mstore(0x40, mload(heap_end))
                {
                    let ptr := 0x40
                    for { } true { } {
                        let right_child := shl(0x01, ptr)
                        let left_child := sub(right_child, 0x20)
                        if iszero(lt(left_child, heap_end)) { break }

                        let best := left_child
                        let best_val := mload(left_child)
                        if lt(right_child, heap_end) {
                            let rv := mload(right_child)
                            if lt(rv, best_val) {
                                best := right_child
                                best_val := rv
                            }
                        }

                        let pv := mload(ptr)
                        if iszero(gt(pv, best_val)) { break }
                        mstore(ptr, best_val)
                        mstore(best, pv)
                        ptr := best
                    }
                }

                let park_level := TREE_HEIGHT
                if xor(0x40, heap_end) {
                    park_level := sub(0xff, clz(xor(mload(0x40), i)))
                }

                // hash leaf preimage
                calldatacopy(0x00, cursor, 0x20)
                let node := keccak256(0x00, 0x20)
                cursor := add(cursor, 0x20)

                // ascend from level 0 toward park_level
                for { let level } lt(level, park_level) { level := add(0x01, level) } {
                    let c := and(0x01, shr(level, i))
                    mstore(shl(0x05, c), node)

                    switch c
                    case false {
                        // sibling is a witness from the stream
                        calldatacopy(0x20, cursor, 0x20)
                        cursor := add(0x20, cursor)
                    }
                    default {
                        // sibling is in frontier or stream
                        let frontier_ptr := add(frontier_base, shl(0x05, level))
                        let parked := mload(frontier_ptr)
                        switch parked
                        case 0x00 {
                            calldatacopy(0x00, cursor, 0x20)
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
            success := and(success, eq(pubkey_, mload(add(frontier_base, shl(0x05, TREE_HEIGHT)))))

            mstore(0x00, shl(0xe0, xor(0xffffffff, mul(0xe9d94581, success))))
            return(0x00, 0x20)
        }
    }
}
