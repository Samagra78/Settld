// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ClauseEscrow} from "../src/ClauseEscrow.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";

/// @dev Shared fixture + helpers. No test functions here (inherited by every category file).
abstract contract ClauseEscrowTestBase is Test {
    ClauseEscrow internal escrow;
    MockERC20 internal usdc;

    address internal forwarder = makeAddr("forwarder");
    address internal brand = makeAddr("brand");
    address internal creator = makeAddr("creator");
    address internal stranger = makeAddr("stranger");
    address internal owner = makeAddr("owner");

    uint8 internal constant NONE = 255;
    uint8 internal constant PENDING = 0;
    uint8 internal constant SUBMITTED = 1;
    uint8 internal constant VERIFIED = 2;
    uint8 internal constant FAILED = 3;
    uint8 internal constant RELEASED = 5;
    uint8 internal constant REFUNDED = 6;

    uint256 internal constant BRAND_START = 1_000_000e6;
    uint64 internal constant DEADLINE_OFFSET = 7 days;

    function setUp() public virtual {
        vm.warp(1_700_000_000);
        usdc = new MockERC20("Mock USDC", "mUSDC", 6);
        escrow = new ClauseEscrow(forwarder, address(usdc), owner);
        usdc.mint(brand, BRAND_START);
        vm.prank(brand);
        usdc.approve(address(escrow), type(uint256).max);
    }

    // ---------------------------------------------------------------- builders

    /// @dev n clauses, amount (i+1)*100e6, no dependencies, deadline now + 7 days.
    function _mk(uint256 n) internal view returns (ClauseEscrow.ClauseTerms[] memory t) {
        t = new ClauseEscrow.ClauseTerms[](n);
        for (uint256 i = 0; i < n; i++) {
            t[i] = ClauseEscrow.ClauseTerms({
                kind: uint8(i % 3),
                checkType: 1,
                param: "param",
                deadline: uint64(block.timestamp) + DEADLINE_OFFSET,
                amount: (i + 1) * 100e6,
                dependsOn: NONE,
                onFail: 0,
                vestDays: 0
            });
        }
    }

    function _total(ClauseEscrow.ClauseTerms[] memory t) internal pure returns (uint256 s) {
        for (uint256 i = 0; i < t.length; i++) s += t[i].amount;
    }

    function _propose(ClauseEscrow.ClauseTerms[] memory t) internal returns (uint256 id) {
        vm.prank(brand);
        id = escrow.proposeDeal(creator, _total(t), t);
    }

    function _accept(uint256 id) internal {
        vm.prank(creator);
        escrow.acceptDeal(id);
    }

    function _specHash(uint256 id) internal view returns (bytes32) {
        return escrow.getDeal(id).specHash;
    }

    function _reportBytes(uint8 kind, uint256 id, uint8 clauseId, bytes32 data) internal view returns (bytes memory) {
        return abi.encode(kind, id, clauseId, uint8(1), data, uint64(0), uint64(block.timestamp));
    }

    function _report(uint8 kind, uint256 id, uint8 clauseId, bytes32 data) internal {
        bytes memory r = _reportBytes(kind, id, clauseId, data);
        vm.prank(forwarder);
        escrow.onReport("", r);
    }

    function _certify(uint256 id) internal {
        _report(0, id, 0, _specHash(id));
    }

    function _fund(uint256 id) internal {
        vm.prank(brand);
        escrow.fundDeal(id);
    }

    /// @dev propose + accept + certify + fund.
    function _funded(ClauseEscrow.ClauseTerms[] memory t) internal returns (uint256 id) {
        id = _propose(t);
        _accept(id);
        _certify(id);
        _fund(id);
    }

    function _submit(uint256 id, uint8 c) internal {
        vm.prank(creator);
        escrow.submitEvidence(id, c, "vid");
    }

    function _verify(uint256 id, uint8 c) internal {
        _submit(id, c);
        _report(1, id, c, bytes32(0));
    }

    function _failReport(uint256 id, uint8 c) internal {
        _submit(id, c);
        _report(2, id, c, bytes32(0));
    }

    function _status(uint256 id, uint8 c) internal view returns (uint8) {
        return escrow.getClause(id, c).status;
    }

    function _revertsWith(bytes4 sel) internal {
        vm.expectRevert(sel);
    }
}
