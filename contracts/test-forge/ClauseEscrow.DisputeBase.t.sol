// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ClauseEscrow} from "../src/ClauseEscrow.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";
import {MockAICourt} from "../test-helpers/MockAICourt.sol";
import {ClauseEscrowTestBase} from "./ClauseEscrow.Base.t.sol";

/// @dev Dispute fixture on top of the shared Base: a court is deployed and set once by the owner.
///      No test functions here.
abstract contract ClauseEscrowDisputeBase is ClauseEscrowTestBase {
    MockAICourt internal court;

    uint8 internal constant DISPUTED = 4;
    uint256 internal constant WINDOW = 120;

    function setUp() public virtual override {
        super.setUp();
        court = new MockAICourt();
        vm.prank(owner);
        escrow.setCourt(address(court));
    }

    /// @dev Replace `escrow` by a fresh instance with NO court set (brand pre-approved).
    function _freshEscrowNoCourt() internal {
        escrow = new ClauseEscrow(forwarder, address(usdc), owner);
        vm.prank(brand);
        usdc.approve(address(escrow), type(uint256).max);
    }

    function _str(uint256 n) internal pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i = 0; i < n; i++) b[i] = "a";
        return string(b);
    }

    function _dispute(address who, uint256 id, uint8 c) internal returns (uint256) {
        vm.prank(who);
        escrow.dispute(id, c, "reason");
        return escrow.caseOf(id, c);
    }

    /// @dev Court decides: final verdict with the given band.
    function _decide(uint256 caseId, uint8 band) internal {
        court.setVerdict(caseId, true, band);
    }

    function _resolve(uint256 id, uint8 c) internal {
        escrow.resolveDispute(id, c);
    }

    /// @dev Two clauses: c0 (amount a0) and c1 (amount a1, optionally dependsOn c0). Funded.
    function _two(uint256 a0, uint256 a1, bool dep) internal returns (uint256 id) {
        ClauseEscrow.ClauseTerms[] memory t = _mk(2);
        t[0].amount = a0;
        t[1].amount = a1;
        if (dep) t[1].dependsOn = 0;
        id = _funded(t);
    }

    function _bal(address a) internal view returns (uint256) {
        return usdc.balanceOf(a);
    }
}
