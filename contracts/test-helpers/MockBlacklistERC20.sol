// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MockERC20} from "./MockERC20.sol";

/// @dev Test-only ERC-20 whose transfers TO a blacklisted address revert.
contract MockBlacklistERC20 is MockERC20 {
    mapping(address => bool) public blacklisted;

    error Blacklisted(address account);

    constructor(string memory n, string memory s, uint8 d) MockERC20(n, s, d) {}

    function setBlacklisted(address account, bool v) external {
        blacklisted[account] = v;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blacklisted[to]) revert Blacklisted(to);
        super._update(from, to, value);
    }
}
