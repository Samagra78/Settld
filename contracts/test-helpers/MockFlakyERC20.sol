// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MockERC20} from "./MockERC20.sol";

interface ITransferHook {
    function onTokenReceived() external;
}

/// @dev Test-only ERC-20 whose `transfer` can, per recipient, revert (`blocked`) or return false
///      without moving funds (`soft`). With hooks enabled it also calls `onTokenReceived()` on
///      contract recipients after a successful transfer (ERC-777 style), to test reentrancy.
contract MockFlakyERC20 is MockERC20 {
    mapping(address => bool) public blocked;
    mapping(address => bool) public soft;
    bool public hooksEnabled;

    error Blocked(address account);

    constructor(string memory n, string memory s, uint8 d) MockERC20(n, s, d) {}

    function setBlocked(address a, bool v) external {
        blocked[a] = v;
    }

    function setSoft(address a, bool v) external {
        soft[a] = v;
    }

    function setHooks(bool v) external {
        hooksEnabled = v;
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        if (blocked[to]) revert Blocked(to);
        if (soft[to]) return false;
        bool ok = super.transfer(to, value);
        if (hooksEnabled && to.code.length > 0) ITransferHook(to).onTokenReceived();
        return ok;
    }
}
