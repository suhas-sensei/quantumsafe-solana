// SPDX-License-Identifier: MIT
pragma solidity =0.8.34;

import {Test} from "forge-std/Test.sol";
import {PORST} from "../src/PORST.sol";

contract PORSTTest is Test {
    uint256 internal constant TREE_HEIGHT = 16;
    uint256 internal constant SUBSET_SIZE = 24;
    uint256 internal constant NUM_LEAVES = 65536;
    bytes4 internal constant MAGIC = 0x1626ba7e;

    PORST porst;
    bytes32[] tree; // 1-indexed: tree[1]=root, leaves at [NUM_LEAVES .. 2*NUM_LEAVES)
    bytes32[] preimages;

    function setUp() public {
        // Build preimages and Merkle tree entirely in assembly.
        // Solidity's abi.encode/encodePacked allocates temporary memory on
        // each call that is never freed, causing OOM at 2^16 iterations.
        assembly ("memory-safe") {
            sstore(preimages.slot, NUM_LEAVES)
            sstore(tree.slot, mul(2, NUM_LEAVES))

            mstore(0x00, preimages.slot)
            let preSlot := keccak256(0x00, 0x20)
            mstore(0x00, tree.slot)
            let treeSlot := keccak256(0x00, 0x20)

            // preimages[i] = keccak256(i), tree[N+i] = keccak256(preimages[i])
            for { let i } lt(i, NUM_LEAVES) { i := add(i, 1) } {
                mstore(0x00, i)
                let pre := keccak256(0x00, 0x20)
                sstore(add(preSlot, i), pre)
                mstore(0x00, pre)
                sstore(add(treeSlot, add(NUM_LEAVES, i)), keccak256(0x00, 0x20))
            }

            // tree[i] = keccak256(tree[2i] || tree[2i+1])
            for { let i := sub(NUM_LEAVES, 1) } gt(i, 0) { i := sub(i, 1) } {
                let l := shl(1, i)
                mstore(0x00, sload(add(treeSlot, l)))
                mstore(0x20, sload(add(treeSlot, add(l, 1))))
                sstore(add(treeSlot, i), keccak256(0x00, 0x40))
            }
        }

        porst = new PORST(tree[1]);
    }

    // ---- helpers ----

    /// @dev Mirrors the contract's subset derivation exactly.
    function _deriveSubset(bytes32 salt, bytes32 hash_) internal pure returns (uint256[] memory subset) {
        bytes32 S = keccak256(abi.encodePacked(hash_, salt));
        bytes32 seedState;
        uint256 seedVal;
        uint256 seedCount = 256 / TREE_HEIGHT; // triggers immediate reseed
        uint256 mask = (1 << TREE_HEIGHT) - 1;

        subset = new uint256[](SUBSET_SIZE);
        uint256 count;

        while (count < SUBSET_SIZE) {
            if (seedCount >= 256 / TREE_HEIGHT) {
                bytes32 s = keccak256(abi.encodePacked(seedState, S));
                seedState = s;
                seedVal = uint256(s);
                seedCount = 0;
            }
            seedCount++;
            uint256 sel = seedVal & mask;
            seedVal >>= TREE_HEIGHT;

            // lower-bound binary search
            uint256 lo;
            uint256 hi = count;
            while (lo < hi) {
                uint256 mid = (lo + hi) / 2;
                if (subset[mid] < sel) lo = mid + 1;
                else hi = mid;
            }
            if (lo < count && subset[lo] == sel) continue; // duplicate

            // shift right and insert
            for (uint256 j = count; j > lo; j--) {
                subset[j] = subset[j - 1];
            }
            subset[lo] = sel;
            count++;
        }
    }

    function _msb(uint256 x) internal pure returns (uint256 r) {
        while (x > 1) {
            x >>= 1;
            r++;
        }
    }

    /// @dev Constructs a valid signature (salt || preimages || witnesses) for the stored tree.
    function _sign(bytes32 salt, bytes32 hash_) internal view returns (bytes memory) {
        uint256[] memory subset = _deriveSubset(salt, hash_);

        bytes32[] memory elems = new bytes32[](SUBSET_SIZE * (TREE_HEIGHT + 1)); // over-allocate
        uint256 n;
        bytes32[] memory frontier = new bytes32[](TREE_HEIGHT + 1);

        for (uint256 idx; idx < SUBSET_SIZE; idx++) {
            uint256 i = subset[idx];
            uint256 parkLevel = (idx + 1 < SUBSET_SIZE) ? _msb(i ^ subset[idx + 1]) : TREE_HEIGHT;

            elems[n++] = preimages[i];
            bytes32 node = keccak256(abi.encodePacked(preimages[i]));

            for (uint256 lvl; lvl < parkLevel; lvl++) {
                uint256 c = (i >> lvl) & 1;
                uint256 sibIdx = ((NUM_LEAVES + i) >> lvl) ^ 1;

                if (c == 0) {
                    // left child — right sibling always from tree
                    elems[n++] = tree[sibIdx];
                    node = keccak256(abi.encodePacked(node, tree[sibIdx]));
                } else if (frontier[lvl] == bytes32(0)) {
                    // right child — left sibling from tree (not in frontier)
                    elems[n++] = tree[sibIdx];
                    node = keccak256(abi.encodePacked(tree[sibIdx], node));
                } else {
                    // right child — left sibling from frontier
                    node = keccak256(abi.encodePacked(frontier[lvl], node));
                    frontier[lvl] = bytes32(0);
                }
            }
            frontier[parkLevel] = node;
        }

        // pack: salt || elems[0..n)
        bytes memory sig = new bytes(32 + n * 32);
        assembly ("memory-safe") {
            mstore(add(sig, 0x20), salt)
        }
        for (uint256 j; j < n; j++) {
            bytes32 e = elems[j];
            assembly ("memory-safe") {
                mstore(add(add(sig, 0x40), shl(5, j)), e)
            }
        }
        return sig;
    }

    // ---- tests ----

    function test_pubkey() public view {
        assertEq(porst.pubkey(), tree[1]);
    }

    function test_validSignature() public view {
        bytes32 hash_ = keccak256("test message");
        bytes32 salt = bytes32(uint256(42));
        bytes memory sig = _sign(salt, hash_);
        assertEq(porst.isValidSignature(hash_, sig), MAGIC);
    }

    function test_validSignature_differentSalt() public view {
        bytes32 hash_ = keccak256("hello world");
        bytes32 salt = bytes32(uint256(0xdeadbeef));
        bytes memory sig = _sign(salt, hash_);
        assertEq(porst.isValidSignature(hash_, sig), MAGIC);
    }

    function test_validSignature_zeroHash() public view {
        bytes32 hash_ = bytes32(0);
        bytes32 salt = bytes32(uint256(1));
        bytes memory sig = _sign(salt, hash_);
        assertEq(porst.isValidSignature(hash_, sig), MAGIC);
    }

    function test_validSignature_zeroSalt() public view {
        bytes32 hash_ = keccak256("msg");
        bytes32 salt = bytes32(0);
        bytes memory sig = _sign(salt, hash_);
        assertEq(porst.isValidSignature(hash_, sig), MAGIC);
    }

    function test_invalidSignature_wrongHash() public view {
        bytes32 hash_ = keccak256("test message");
        bytes32 salt = bytes32(uint256(42));
        bytes memory sig = _sign(salt, hash_);
        bytes4 result = porst.isValidSignature(keccak256("wrong message"), sig);
        assertTrue(result != MAGIC);
    }

    function test_invalidSignature_empty() public view {
        bytes4 result = porst.isValidSignature(keccak256("msg"), "");
        assertTrue(result != MAGIC);
    }

    function test_invalidSignature_saltOnly() public view {
        bytes4 result = porst.isValidSignature(keccak256("msg"), abi.encodePacked(bytes32(uint256(1))));
        assertTrue(result != MAGIC);
    }

    function test_invalidSignature_truncated() public view {
        bytes32 hash_ = keccak256("test message");
        bytes memory sig = _sign(bytes32(uint256(42)), hash_);
        // drop the last 32 bytes
        assembly ("memory-safe") {
            mstore(sig, sub(mload(sig), 0x20))
        }
        bytes4 result = porst.isValidSignature(hash_, sig);
        assertTrue(result != MAGIC);
    }

    function test_invalidSignature_extraBytes() public view {
        bytes32 hash_ = keccak256("test message");
        bytes memory sig = _sign(bytes32(uint256(42)), hash_);
        sig = bytes.concat(sig, bytes32(0));
        bytes4 result = porst.isValidSignature(hash_, sig);
        assertTrue(result != MAGIC);
    }

    function test_invalidSignature_corruptedWitness() public view {
        bytes32 hash_ = keccak256("test message");
        bytes memory sig = _sign(bytes32(uint256(42)), hash_);
        // flip a byte in the middle of the witness area
        sig[100] = bytes1(uint8(sig[100]) ^ 0xff);
        bytes4 result = porst.isValidSignature(hash_, sig);
        assertTrue(result != MAGIC);
    }

    function test_invalidSignature_wrongPubkey() public {
        PORST wrong = new PORST(keccak256("wrong key"));
        bytes32 hash_ = keccak256("test message");
        bytes memory sig = _sign(bytes32(uint256(42)), hash_);
        bytes4 result = wrong.isValidSignature(hash_, sig);
        assertTrue(result != MAGIC);
    }
}
