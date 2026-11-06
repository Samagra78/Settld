// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ClauseEscrow} from "../src/ClauseEscrow.sol";
import {ClauseEscrowDisputeBase} from "./ClauseEscrow.DisputeBase.t.sol";

/// @dev refund(): a Failed clause ALWAYS waits for its dispute window (even with a Refunded dependency);
///      cascade refunds of non-Failed clauses stay immediate; Disputed clauses are never refundable.
contract ClauseEscrowRefundWindowTest is ClauseEscrowDisputeBase {
    uint256 internal constant ODD = 1_000_003;
    uint256 internal constant OTHER = 100e6;
    uint256 internal constant ESCAPE = 1 days;

    /// @dev c0 Failed and Refunded; c1 (dep c0) Failed just now. Returns deal id and c1's failure time.
    function _failedCascade() internal returns (uint256 id, uint256 failedAt) {
        id = _two(ODD, OTHER, true);
        _failReport(id, 0);
        skip(WINDOW);
        escrow.refund(id, 0);
        assertEq(_status(id, 0), REFUNDED);
        _failReport(id, 1);
        failedAt = block.timestamp;
    }

    // ------------------------------------------------ Failed dependent waits

    function test_FailedDependentOfRefunded_WindowOpenThenRefunds() public {
        (uint256 id, uint256 failedAt) = _failedCascade();
        uint256 bBefore = _bal(brand);
        vm.expectRevert(ClauseEscrow.WindowOpen.selector);
        escrow.refund(id, 1);
        vm.warp(failedAt + WINDOW - 1);
        vm.expectRevert(ClauseEscrow.WindowOpen.selector);
        escrow.refund(id, 1);
        assertEq(_status(id, 1), FAILED);
        assertEq(_bal(brand), bBefore);

        vm.warp(failedAt + WINDOW);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseSettled(id, 1, REFUNDED, OTHER);
        vm.prank(stranger);
        escrow.refund(id, 1);
        assertEq(_status(id, 1), REFUNDED);
        assertEq(_bal(brand) - bBefore, OTHER);
        assertEq(_bal(address(escrow)), 0);
    }

    function test_ExpiredDependentOfRefunded_AlsoWaitsForWindow() public {
        uint256 id = _two(ODD, OTHER, true);
        _failReport(id, 0);
        skip(WINDOW);
        escrow.refund(id, 0);
        vm.warp(block.timestamp + 8 days);
        escrow.expire(id, 1);
        vm.expectRevert(ClauseEscrow.WindowOpen.selector);
        escrow.refund(id, 1);
        skip(WINDOW);
        escrow.refund(id, 1);
        assertEq(_status(id, 1), REFUNDED);
    }

    function testFuzz_FailedDependentOfRefunded_RefundGate(uint256 dt) public {
        dt = bound(dt, 0, 600);
        (uint256 id, uint256 failedAt) = _failedCascade();
        vm.warp(failedAt + dt);
        if (dt < WINDOW) vm.expectRevert(ClauseEscrow.WindowOpen.selector);
        escrow.refund(id, 1);
        assertEq(_status(id, 1), dt < WINDOW ? FAILED : REFUNDED);
    }

    // ------------------------------------------ dispute still opens in window

    function test_DisputeStillOpensInsideWindowOnFailedCascadeClause() public {
        (uint256 id, uint256 failedAt) = _failedCascade();
        vm.warp(failedAt + WINDOW - 1);
        uint256 caseId = _dispute(creator, id, 1);
        assertGt(caseId, 0);
        assertEq(_status(id, 1), DISPUTED);
        // Disputed clauses can never be refunded, window over or not.
        vm.warp(failedAt + WINDOW + 1 days);
        vm.expectRevert(ClauseEscrow.RefundNotAllowed.selector);
        escrow.refund(id, 1);
    }

    function test_DisputedCascadeClauseSettlesToBrandViaCourtEvenWithFullBand() public {
        (uint256 id,) = _failedCascade();
        uint256 caseId = _dispute(creator, id, 1);
        _decide(caseId, 100); // refunded dependency forces band 0
        uint256 bBefore = _bal(brand);
        escrow.resolveDispute(id, 1);
        assertEq(_status(id, 1), REFUNDED);
        assertEq(_bal(brand) - bBefore, OTHER);
        assertEq(_bal(creator), 0);
    }

    function test_DisputedCascadeClauseSettlesToBrandViaEscape() public {
        (uint256 id,) = _failedCascade();
        _dispute(brand, id, 1);
        skip(ESCAPE);
        uint256 bBefore = _bal(brand);
        escrow.resolveStuckDispute(id, 1);
        assertEq(_status(id, 1), REFUNDED);
        assertEq(_bal(brand) - bBefore, OTHER);
        assertEq(_bal(address(escrow)), 0);
    }

    function test_DisputeClosedAfterWindowOnFailedCascadeClause() public {
        (uint256 id, uint256 failedAt) = _failedCascade();
        vm.warp(failedAt + WINDOW);
        vm.prank(creator);
        vm.expectRevert(ClauseEscrow.DisputeWindowClosed.selector);
        escrow.dispute(id, 1, "late");
        escrow.refund(id, 1);
        assertEq(_status(id, 1), REFUNDED);
    }

    function test_FailedDisputedBeforeDependencyRefund_StaysNonRefundable() public {
        uint256 id = _two(ODD, OTHER, true);
        _failReport(id, 0);
        _failReport(id, 1);
        _dispute(creator, id, 1);
        skip(WINDOW);
        escrow.refund(id, 0); // dependency now Refunded
        vm.expectRevert(ClauseEscrow.RefundNotAllowed.selector);
        escrow.refund(id, 1);
        assertEq(_status(id, 1), DISPUTED);
    }

    // ------------------------------------------ non-Failed cascade immediate

    function test_NonFailedCascadeStaysImmediate() public {
        ClauseEscrow.ClauseTerms[] memory t = _mk(4);
        t[1].dependsOn = 0;
        t[2].dependsOn = 0;
        t[3].dependsOn = 0;
        uint256 id = _funded(t); // 100, 200, 300, 400 (c1..c3 depend on c0)
        _failReport(id, 0);
        skip(WINDOW);
        escrow.refund(id, 0);
        uint256 stamp = block.timestamp;
        _submit(id, 2); // Submitted
        _verify(id, 3); // Verified moments ago, release window still open
        assertEq(block.timestamp, stamp);
        uint256 bBefore = _bal(brand);

        escrow.refund(id, 1); // Pending
        escrow.refund(id, 2); // Submitted
        escrow.refund(id, 3); // Verified
        assertEq(block.timestamp, stamp);
        assertEq(_status(id, 1), REFUNDED);
        assertEq(_status(id, 2), REFUNDED);
        assertEq(_status(id, 3), REFUNDED);
        assertEq(_bal(brand) - bBefore, 900e6);
        assertEq(_bal(address(escrow)), 0);
    }

    function test_FailedWithoutRefundedDependencyStillWaits() public {
        uint256 id = _two(ODD, OTHER, true);
        _verify(id, 0);
        _failReport(id, 1);
        vm.expectRevert(ClauseEscrow.WindowOpen.selector);
        escrow.refund(id, 1);
    }
}
