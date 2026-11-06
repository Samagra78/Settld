// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @dev Test-only AI court whose finalVerdict returns an enormous payload.
///      The first two words are either a valid (final=1, band) pair or garbage; everything after is zero.
///      The caller of finalVerdict must only ever read the first 64 bytes.
contract MockHugeCourt {
    uint256 public caseCount;
    uint256 public size = 5_000_000;
    uint256 public band;
    bool public garbage;

    function setSize(uint256 s) external {
        size = s;
    }

    function setBand(uint256 b) external {
        band = b;
    }

    function setGarbage(bool g) external {
        garbage = g;
    }

    function openCase(uint256, uint8, address, address, string calldata) external returns (uint256) {
        return ++caseCount;
    }

    function finalVerdict(uint256) external view returns (bool, uint8) {
        uint256 s = size;
        uint256 b = band;
        bool g = garbage;
        assembly {
            switch g
            case 0 {
                mstore(0, 1)
                mstore(0x20, b)
            }
            default {
                mstore(0, not(0))
                mstore(0x20, not(0))
            }
            return(0, s)
        }
    }
}
