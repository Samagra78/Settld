// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ClauseEscrow} from "../src/ClauseEscrow.sol";
import {ClauseEscrowTestBase} from "./ClauseEscrow.Base.t.sol";

/// @dev refund (incl. cascade), expire, exclusivity of settlement, conservation.
contract ClauseEscrowSettleTest is ClauseEscrowTestBase {
    // 4 clauses: c0=100, c1=200 (dep 0), c2=300 (dep 0), c3=400 (dep 0). Total 1000e6.
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        ClauseEscrow.ClauseTerms[] memory t = _mk(4);
        t[1].dependsOn = 0;
        t[2].dependsOn = 0;
        t[3].dependsOn = 0;
        id = _funded(t);
    }

    function _escrowBal() internal view returns (uint256) {
        return usdc.balanceOf(address(escrow));
    }

    // ----------------------------------------------------------------- refund

    function test_Refund_FailedClauseReturnsToBrandAndEmits() public {
        _failReport(id, 0);
        skip(120); // release window must elapse before a Failed clause is refundable
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseSettled(id, 0, REFUNDED, 100e6);
        vm.prank(stranger); // permissionless trigger
        escrow.refund(id, 0);
        assertEq(_status(id, 0), REFUNDED);
        assertEq(usdc.balanceOf(brand), BRAND_START - 1000e6 + 100e6);
        assertEq(usdc.balanceOf(stranger), 0);
        assertEq(_escrowBal(), 900e6);
    }

    /// NEW: a Failed clause is not refundable inside the 120s window, and is at the window end.
    function test_Refund_FailedClauseRevertsWindowOpenInsideWindow() public {
        _failReport(id, 0);
        uint256 failedAt = block.timestamp;
        vm.expectRevert(ClauseEscrow.WindowOpen.selector);
        escrow.refund(id, 0);
        vm.warp(failedAt + 119);
        vm.expectRevert(ClauseEscrow.WindowOpen.selector);
        escrow.refund(id, 0);
        assertEq(_status(id, 0), FAILED);
        vm.warp(failedAt + 120);
        escrow.refund(id, 0);
        assertEq(_status(id, 0), REFUNDED);
    }

    function test_Refund_RevertsNotFunded() public {
        uint256 id2 = _propose(_mk(1));
        vm.expectRevert(ClauseEscrow.NotFunded.selector);
        escrow.refund(id2, 0);
    }

    function test_Refund_RevertsUnknown() public {
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.UnknownClause.selector, id, uint8(4)));
        escrow.refund(id, 4);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.UnknownDeal.selector, uint256(50)));
        escrow.refund(50, 0);
    }

    function test_Refund_NotFailedNoRefundedDependencyReverts() public {
        // Pending, no dep
        vm.expectRevert(ClauseEscrow.RefundNotAllowed.selector);
        escrow.refund(id, 0);
        // Submitted, no dep
        _submit(id, 0);
        vm.expectRevert(ClauseEscrow.RefundNotAllowed.selector);
        escrow.refund(id, 0);
        // Verified, no dep
        _report(1, id, 0, bytes32(0));
        vm.expectRevert(ClauseEscrow.RefundNotAllowed.selector);
        escrow.refund(id, 0);
    }

    function test_Refund_DependentNotRefundableWhileDependencyOnlyFailed() public {
        _failReport(id, 0);
        vm.expectRevert(ClauseEscrow.RefundNotAllowed.selector);
        escrow.refund(id, 1);
        assertEq(_status(id, 1), PENDING);
    }

    function test_Refund_CascadeAllDependentStates() public {
        // c1 Pending, c2 Submitted, c3 Verified; c0 fails and is refunded.
        _submit(id, 2);
        _verify(id, 3);
        _failReport(id, 0);
        skip(120);
        escrow.refund(id, 0);
        assertEq(_status(id, 1), PENDING);
        assertEq(_status(id, 2), SUBMITTED);
        assertEq(_status(id, 3), VERIFIED);
        uint256 brandBefore = usdc.balanceOf(brand);
        for (uint8 c = 1; c <= 3; c++) {
            vm.expectEmit(true, false, false, true, address(escrow));
            emit ClauseEscrow.ClauseSettled(id, c, REFUNDED, uint256(c + 1) * 100e6);
            escrow.refund(id, c);
            assertEq(_status(id, c), REFUNDED);
        }
        assertEq(usdc.balanceOf(brand), brandBefore + 900e6);
        assertEq(_escrowBal(), 0);
    }

    function test_Refund_ChainedCascade() public {
        // c0 <- c1 <- c2 chain in a fresh deal
        ClauseEscrow.ClauseTerms[] memory t = _mk(3);
        t[1].dependsOn = 0;
        t[2].dependsOn = 1;
        uint256 id2 = _funded(t);
        _failReport(id2, 0);
        vm.expectRevert(ClauseEscrow.RefundNotAllowed.selector);
        escrow.refund(id2, 2); // grandchild: dep c1 not refunded yet
        skip(120);
        escrow.refund(id2, 0);
        vm.expectRevert(ClauseEscrow.RefundNotAllowed.selector);
        escrow.refund(id2, 2); // still: c1 not yet refunded
        escrow.refund(id2, 1);
        escrow.refund(id2, 2);
        assertEq(_status(id2, 2), REFUNDED);
    }

    function test_Refund_IndependentClauseUnaffectedByOtherRefund() public {
        // c0 is root; in a deal where c1 has no dependency, c0's refund doesn't free c1.
        ClauseEscrow.ClauseTerms[] memory t = _mk(2); // no deps
        uint256 id2 = _funded(t);
        _failReport(id2, 0);
        skip(120);
        escrow.refund(id2, 0);
        vm.expectRevert(ClauseEscrow.RefundNotAllowed.selector);
        escrow.refund(id2, 1);
    }

    function test_Refund_NoDoubleRefund() public {
        _failReport(id, 0);
        skip(120);
        escrow.refund(id, 0);
        uint256 b = usdc.balanceOf(brand);
        vm.expectRevert(ClauseEscrow.RefundNotAllowed.selector);
        escrow.refund(id, 0);
        assertEq(usdc.balanceOf(brand), b);
    }

    function test_Refund_NoDoubleRefundOfCascadedClause() public {
        _failReport(id, 0);
        skip(120);
        escrow.refund(id, 0);
        escrow.refund(id, 1);
        vm.expectRevert(ClauseEscrow.RefundNotAllowed.selector);
        escrow.refund(id, 1);
    }

    function test_Refund_NotAllowedAfterRelease() public {
        _verify(id, 0);
        skip(120);
        escrow.release(id, 0);
        vm.expectRevert(ClauseEscrow.RefundNotAllowed.selector);
        escrow.refund(id, 0);
    }

    function test_Release_NotAllowedAfterRefund() public {
        _failReport(id, 0);
        skip(120);
        escrow.refund(id, 0);
        skip(1 days);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidClauseStatus.selector, REFUNDED));
        escrow.release(id, 0);
    }

    function test_Refund_NotAllowedOnReleasedDependentOfRefundedRoot() public {
        // Independent root released; dependent of a *different* refunded root stays unrelated.
        _verify(id, 0);
        skip(120);
        escrow.release(id, 0);
        // c1's dependency (c0) is Released, not Refunded -> no cascade
        vm.expectRevert(ClauseEscrow.RefundNotAllowed.selector);
        escrow.refund(id, 1);
    }

    // ----------------------------------------------------------------- expire

    function test_Expire_PendingNotAtDeadline() public {
        uint64 dl = escrow.getClause(id, 0).deadline;
        vm.warp(dl);
        vm.expectRevert(ClauseEscrow.NotExpired.selector);
        escrow.expire(id, 0);
    }

    function test_Expire_PendingPastDeadlineFailsAndEmits() public {
        uint64 dl = escrow.getClause(id, 0).deadline;
        vm.warp(uint256(dl) + 1);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseFailed(id, 0);
        vm.prank(stranger);
        escrow.expire(id, 0);
        assertEq(_status(id, 0), FAILED);
        skip(120);
        escrow.refund(id, 0); // failed clause then refundable (after the window)
        assertEq(_status(id, 0), REFUNDED);
    }

    function test_Expire_SubmittedAfterOneDay() public {
        _submit(id, 0);
        uint256 s = block.timestamp;
        vm.warp(s + 1 days - 1);
        vm.expectRevert(ClauseEscrow.NotExpired.selector);
        escrow.expire(id, 0);
        vm.warp(s + 1 days);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseFailed(id, 0);
        escrow.expire(id, 0);
        assertEq(_status(id, 0), FAILED);
    }

    function test_Expire_SubmittedAtDeadlineStillNeedsFullDay() public {
        uint64 dl = escrow.getClause(id, 0).deadline;
        vm.warp(dl);
        _submit(id, 0); // submitted exactly at deadline
        vm.warp(uint256(dl) + 5 hours);
        vm.expectRevert(ClauseEscrow.NotExpired.selector);
        escrow.expire(id, 0);
    }

    function test_Expire_SubmittedThenLateReportRejected() public {
        _submit(id, 0);
        skip(1 days);
        escrow.expire(id, 0);
        bytes memory r = _reportBytes(1, id, 0, bytes32(0));
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidClauseStatus.selector, FAILED));
        escrow.onReport("", r);
    }

    function test_Expire_UnfundedDealCannotExpire() public {
        uint256 id2 = _propose(_mk(1));
        vm.warp(block.timestamp + 365 days);
        vm.expectRevert(ClauseEscrow.NotFunded.selector);
        escrow.expire(id2, 0);
    }

    function test_Expire_VerifiedFailedSettledCannotExpire() public {
        _verify(id, 0);
        _failReport(id, 1);
        vm.warp(block.timestamp + 365 days);
        vm.expectRevert(ClauseEscrow.NotExpired.selector);
        escrow.expire(id, 0); // Verified
        vm.expectRevert(ClauseEscrow.NotExpired.selector);
        escrow.expire(id, 1); // Failed
        escrow.release(id, 0);
        vm.expectRevert(ClauseEscrow.NotExpired.selector);
        escrow.expire(id, 0); // Released
        escrow.refund(id, 1);
        vm.expectRevert(ClauseEscrow.NotExpired.selector);
        escrow.expire(id, 1); // Refunded
    }

    function test_Expire_RevertsUnknown() public {
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.UnknownClause.selector, id, uint8(4)));
        escrow.expire(id, 4);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.UnknownDeal.selector, uint256(9)));
        escrow.expire(9, 0);
    }

    function test_Expire_TwiceReverts() public {
        vm.warp(block.timestamp + 8 days);
        escrow.expire(id, 0);
        vm.expectRevert(ClauseEscrow.NotExpired.selector);
        escrow.expire(id, 0);
    }

    // ----------------------------------------------------------- conservation

    function test_Conservation_FullySettledDealLeavesZero() public {
        // c0 releases; c1 (dep c0) releases; c2 fails -> refund; c3 pending -> expires -> refund
        _verify(id, 0);
        _verify(id, 1);
        _failReport(id, 2);
        skip(120);
        assertEq(_escrowBal(), 1000e6);
        escrow.release(id, 0);
        assertEq(_escrowBal(), 900e6);
        escrow.release(id, 1);
        assertEq(_escrowBal(), 700e6);
        escrow.refund(id, 2);
        assertEq(_escrowBal(), 400e6);
        vm.warp(block.timestamp + 8 days);
        escrow.expire(id, 3);
        skip(120);
        escrow.refund(id, 3);
        assertEq(_escrowBal(), 0);
        assertEq(usdc.balanceOf(creator), 300e6);
        assertEq(usdc.balanceOf(brand), BRAND_START - 1000e6 + 700e6);
        assertEq(usdc.balanceOf(creator) + (usdc.balanceOf(brand) - (BRAND_START - 1000e6)), 1000e6);
    }

    function test_Conservation_AllFailedAllRefunded() public {
        vm.warp(block.timestamp + 8 days);
        for (uint8 c = 0; c < 4; c++) {
            escrow.expire(id, c);
        }
        skip(120);
        // c0 refund frees dependents' cascade too, but they are Failed anyway.
        for (uint8 c = 0; c < 4; c++) {
            escrow.refund(id, c);
        }
        assertEq(_escrowBal(), 0);
        assertEq(usdc.balanceOf(brand), BRAND_START);
        assertEq(usdc.balanceOf(creator), 0);
    }

    function test_Conservation_MultipleDealsIndependent() public {
        uint256 id2 = _funded(_mk(1)); // 100e6
        assertEq(_escrowBal(), 1100e6);
        _verify(id2, 0);
        skip(120);
        escrow.release(id2, 0);
        assertEq(_escrowBal(), 1000e6);
        // Refunding deal 2's clause is impossible and deal 1's funds are untouched
        vm.expectRevert(ClauseEscrow.RefundNotAllowed.selector);
        escrow.refund(id2, 0);
        assertEq(_escrowBal(), 1000e6);
    }
}
