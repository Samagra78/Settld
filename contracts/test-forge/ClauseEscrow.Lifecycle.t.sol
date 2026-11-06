// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ClauseEscrow} from "../src/ClauseEscrow.sol";
import {ClauseEscrowTestBase} from "./ClauseEscrow.Base.t.sol";

/// @dev submitEvidence, verification reports, release window + dependencies.
contract ClauseEscrowLifecycleTest is ClauseEscrowTestBase {
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        ClauseEscrow.ClauseTerms[] memory t = _mk(3);
        t[1].dependsOn = 0;
        id = _funded(t); // clause amounts 100e6, 200e6, 300e6; clause1 depends on clause0
    }

    // -------------------------------------------------------- submitEvidence

    function test_Submit_HappyPathAndEvent() public {
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseSubmitted(id, 0, "video-123");
        vm.prank(creator);
        escrow.submitEvidence(id, 0, "video-123");
        assertEq(_status(id, 0), SUBMITTED);
    }

    function test_Submit_RevertsNonCreator() public {
        vm.prank(brand);
        vm.expectRevert(ClauseEscrow.NotCreator.selector);
        escrow.submitEvidence(id, 0, "v");
        vm.prank(stranger);
        vm.expectRevert(ClauseEscrow.NotCreator.selector);
        escrow.submitEvidence(id, 0, "v");
    }

    function test_Submit_RevertsWhenNotFunded() public {
        ClauseEscrow.ClauseTerms[] memory t = _mk(1);
        uint256 id2 = _propose(t);
        _accept(id2);
        _certify(id2);
        vm.prank(creator);
        vm.expectRevert(ClauseEscrow.NotFunded.selector);
        escrow.submitEvidence(id2, 0, "v");
    }

    function test_Submit_RevertsUnknownClause() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.UnknownClause.selector, id, uint8(3)));
        escrow.submitEvidence(id, 3, "v");
    }

    function test_Submit_RevertsUnknownDeal() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.UnknownDeal.selector, uint256(77)));
        escrow.submitEvidence(77, 0, "v");
    }

    function test_Submit_RevertsTwice() public {
        _submit(id, 0);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidClauseStatus.selector, SUBMITTED));
        escrow.submitEvidence(id, 0, "again");
    }

    function test_Submit_AllowedAtDeadline() public {
        uint64 dl = escrow.getClause(id, 0).deadline;
        vm.warp(dl);
        _submit(id, 0);
        assertEq(_status(id, 0), SUBMITTED);
    }

    function test_Submit_RejectedAfterDeadline() public {
        uint64 dl = escrow.getClause(id, 0).deadline;
        vm.warp(uint256(dl) + 1);
        vm.prank(creator);
        vm.expectRevert(ClauseEscrow.DeadlinePassed.selector);
        escrow.submitEvidence(id, 0, "late");
    }

    // ------------------------------------------------------------ reports 1/2

    function test_Report_Kind1VerifiesAndEmits() public {
        _submit(id, 0);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseVerified(id, 0);
        _report(1, id, 0, bytes32(0));
        ClauseEscrow.Clause memory c = escrow.getClause(id, 0);
        assertEq(c.status, VERIFIED);
        assertEq(c.verifiedAt, uint64(block.timestamp));
    }

    function test_Report_Kind2FailsAndEmits() public {
        _submit(id, 0);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseFailed(id, 0);
        _report(2, id, 0, bytes32(0));
        assertEq(_status(id, 0), FAILED);
    }

    function test_Report_Kind1And2RequireSubmitted() public {
        // Pending
        for (uint8 k = 1; k <= 2; k++) {
            bytes memory r = _reportBytes(k, id, 0, bytes32(0));
            vm.prank(forwarder);
            vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidClauseStatus.selector, PENDING));
            escrow.onReport("", r);
        }
        // Already verified -> cannot verify or fail again
        _verify(id, 0);
        for (uint8 k = 1; k <= 2; k++) {
            bytes memory r = _reportBytes(k, id, 0, bytes32(0));
            vm.prank(forwarder);
            vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidClauseStatus.selector, VERIFIED));
            escrow.onReport("", r);
        }
    }

    function test_Report_Kind1And2RequireFunded() public {
        uint256 id2 = _propose(_mk(1));
        for (uint8 k = 1; k <= 2; k++) {
            bytes memory r = _reportBytes(k, id2, 0, bytes32(0));
            vm.prank(forwarder);
            vm.expectRevert(ClauseEscrow.NotFunded.selector);
            escrow.onReport("", r);
        }
    }

    function test_Report_Kind1UnknownClause() public {
        bytes memory r = _reportBytes(1, id, 9, bytes32(0));
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.UnknownClause.selector, id, uint8(9)));
        escrow.onReport("", r);
    }

    function test_Report_Kind1CannotRevivePostFailure() public {
        _failReport(id, 0);
        bytes memory r = _reportBytes(1, id, 0, bytes32(0));
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidClauseStatus.selector, FAILED));
        escrow.onReport("", r);
    }

    function testFuzz_Report_UnknownKindReverts(uint8 kind) public {
        kind = uint8(bound(kind, 3, 255));
        bytes memory r = _reportBytes(kind, id, 0, bytes32(0));
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidReportKind.selector, kind));
        escrow.onReport("", r);
    }

    function test_Report_ValueAndSelectorAreInformational() public {
        _submit(id, 0);
        bytes memory r = abi.encode(uint8(1), id, uint8(0), uint8(0), bytes32(uint256(5)), uint64(9), uint64(1));
        vm.prank(forwarder);
        escrow.onReport("", r);
        assertEq(_status(id, 0), VERIFIED);
    }

    // ---------------------------------------------------------------- release

    function test_Release_WaitsForWindow() public {
        _verify(id, 0);
        uint64 v = escrow.getClause(id, 0).verifiedAt;
        vm.warp(uint256(v) + 119);
        vm.expectRevert(ClauseEscrow.ReleaseWindowActive.selector);
        escrow.release(id, 0);
        vm.warp(uint256(v) + 120);
        escrow.release(id, 0);
        assertEq(_status(id, 0), RELEASED);
    }

    function test_Release_ImmediatelyRevertsWindow() public {
        _verify(id, 0);
        vm.expectRevert(ClauseEscrow.ReleaseWindowActive.selector);
        escrow.release(id, 0);
    }

    function test_Release_PaysCreatorAndEmits() public {
        _verify(id, 0);
        skip(120);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseSettled(id, 0, RELEASED, 100e6);
        vm.prank(stranger); // permissionless trigger, funds still go to creator
        escrow.release(id, 0);
        assertEq(usdc.balanceOf(creator), 100e6);
        assertEq(usdc.balanceOf(stranger), 0);
        assertEq(usdc.balanceOf(address(escrow)), 600e6 - 100e6);
    }

    function test_Release_RevertsPendingSubmittedFailed() public {
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidClauseStatus.selector, PENDING));
        escrow.release(id, 0);
        _submit(id, 0);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidClauseStatus.selector, SUBMITTED));
        escrow.release(id, 0);
        _report(2, id, 0, bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidClauseStatus.selector, FAILED));
        escrow.release(id, 0);
    }

    function test_Release_RevertsNotFundedAndUnknown() public {
        uint256 id2 = _propose(_mk(1));
        vm.expectRevert(ClauseEscrow.NotFunded.selector);
        escrow.release(id2, 0);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.UnknownClause.selector, id, uint8(3)));
        escrow.release(id, 3);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.UnknownDeal.selector, uint256(0)));
        escrow.release(0, 0);
    }

    function test_Release_NoDoubleRelease() public {
        _verify(id, 0);
        skip(120);
        escrow.release(id, 0);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidClauseStatus.selector, RELEASED));
        escrow.release(id, 0);
        assertEq(usdc.balanceOf(creator), 100e6);
    }

    // ------------------------------------------------------------ dependencies

    function test_Release_DependentWaitsForDependencyReleased() public {
        _verify(id, 0);
        _verify(id, 1);
        skip(1 hours); // windows long over for both
        vm.expectRevert(ClauseEscrow.DependencyNotReleased.selector);
        escrow.release(id, 1);
        escrow.release(id, 0);
        escrow.release(id, 1);
        assertEq(_status(id, 1), RELEASED);
        assertEq(usdc.balanceOf(creator), 300e6);
    }

    function test_Release_DependentBlockedWhileDependencyOnlyVerified() public {
        _verify(id, 0);
        skip(10 minutes);
        _verify(id, 1);
        skip(10 minutes);
        // dependency Verified (not Released) -> dependent still blocked
        vm.expectRevert(ClauseEscrow.DependencyNotReleased.selector);
        escrow.release(id, 1);
    }

    function test_Release_DependentBlockedWhenDependencyRefunded() public {
        _failReport(id, 0);
        _verify(id, 1);
        skip(120);
        escrow.refund(id, 0);
        skip(1 hours);
        vm.expectRevert(ClauseEscrow.DependencyNotReleased.selector);
        escrow.release(id, 1);
    }

    function test_Release_IndependentClauseIgnoresOtherClauses() public {
        _verify(id, 2);
        skip(120);
        escrow.release(id, 2);
        assertEq(usdc.balanceOf(creator), 300e6);
    }
}
