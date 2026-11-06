// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ClauseEscrow} from "../src/ClauseEscrow.sol";
import {MockAICourt} from "../test-helpers/MockAICourt.sol";
import {ClauseEscrowDisputeBase} from "./ClauseEscrow.DisputeBase.t.sol";

/// @dev Ownership/court wiring, dispute window, dispute() and its freezing effects.
contract ClauseEscrowDisputeTest is ClauseEscrowDisputeBase {
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        ClauseEscrow.ClauseTerms[] memory t = _mk(3);
        t[2].dependsOn = 0;
        id = _funded(t); // c0=100e6, c1=200e6, c2=300e6 (dep c0)
    }

    function _expectStatus(uint8 s) internal {
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidClauseStatus.selector, s));
    }

    // ------------------------------------------------------------- ownership

    function test_Owner_ConstructorSetsOwner() public view {
        assertEq(escrow.owner(), owner);
    }

    function test_Owner_ZeroOwnerReverts() public {
        vm.expectRevert(ClauseEscrow.ZeroOwner.selector);
        new ClauseEscrow(forwarder, address(usdc), address(0));
    }

    function test_Court_UnsetByDefaultAndPublic() public {
        _freshEscrowNoCourt();
        assertEq(address(escrow.court()), address(0));
    }

    function test_SetCourt_OwnerSetsAndEmits() public {
        _freshEscrowNoCourt();
        vm.expectEmit(true, false, false, false, address(escrow));
        emit ClauseEscrow.CourtSet(address(court));
        vm.prank(owner);
        escrow.setCourt(address(court));
        assertEq(address(escrow.court()), address(court));
    }

    function test_SetCourt_NonOwnerReverts() public {
        _freshEscrowNoCourt();
        address[3] memory callers = [stranger, brand, creator];
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, callers[i]));
            escrow.setCourt(address(court));
        }
        assertEq(address(escrow.court()), address(0));
    }

    function test_SetCourt_OnlyOnce() public {
        // fixture escrow already has the court set
        MockAICourt other = new MockAICourt();
        vm.prank(owner);
        vm.expectRevert(ClauseEscrow.CourtAlreadySet.selector);
        escrow.setCourt(address(other));
        assertEq(address(escrow.court()), address(court));
    }

    function test_SetCourt_ZeroReverts() public {
        _freshEscrowNoCourt();
        vm.prank(owner);
        vm.expectRevert(ClauseEscrow.ZeroCourt.selector);
        escrow.setCourt(address(0));
        // a failed attempt does not consume the one-shot
        vm.prank(owner);
        escrow.setCourt(address(court));
        assertEq(address(escrow.court()), address(court));
    }

    function test_SetCourt_ZeroAfterSetIsAlreadySet() public {
        vm.prank(owner);
        vm.expectRevert(ClauseEscrow.CourtAlreadySet.selector);
        escrow.setCourt(address(0));
    }

    // ------------------------------------------------------ disputeWindowEnd

    function test_WindowEnd_AfterVerifiedReport() public {
        skip(1 hours);
        _verify(id, 0);
        assertEq(escrow.disputeWindowEnd(id, 0), uint64(block.timestamp + 120));
    }

    function test_WindowEnd_AfterFailedReport() public {
        skip(1 hours);
        _failReport(id, 1);
        assertEq(escrow.disputeWindowEnd(id, 1), uint64(block.timestamp + 120));
    }

    function test_WindowEnd_AfterExpire() public {
        vm.warp(block.timestamp + 8 days);
        escrow.expire(id, 0);
        assertEq(escrow.disputeWindowEnd(id, 0), uint64(block.timestamp + 120));
    }

    function test_WindowEnd_UsesVerdictTimeNotSubmitTime() public {
        _submit(id, 0);
        skip(600);
        _report(1, id, 0, bytes32(0));
        assertEq(escrow.disputeWindowEnd(id, 0), uint64(block.timestamp + 120));
    }

    // ---------------------------------------------------------------- dispute

    function test_Dispute_BrandCanDisputeVerified() public {
        _verify(id, 0);
        _dispute(brand, id, 0);
        assertEq(_status(id, 0), DISPUTED);
    }

    function test_Dispute_CreatorCanDisputeVerified() public {
        _verify(id, 0);
        _dispute(creator, id, 0);
        assertEq(_status(id, 0), DISPUTED);
    }

    function test_Dispute_BrandAndCreatorCanDisputeFailed() public {
        _failReport(id, 0);
        _failReport(id, 1);
        _dispute(brand, id, 0);
        _dispute(creator, id, 1);
        assertEq(_status(id, 0), DISPUTED);
        assertEq(_status(id, 1), DISPUTED);
    }

    function test_Dispute_OutsidersRevertNotParty() public {
        _verify(id, 0);
        address[3] memory outsiders = [stranger, owner, forwarder];
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(outsiders[i]);
            vm.expectRevert(ClauseEscrow.NotParty.selector);
            escrow.dispute(id, 0, "x");
        }
        assertEq(_status(id, 0), VERIFIED);
    }

    function test_Dispute_RevertsOnPending() public {
        _expectStatus(PENDING);
        vm.prank(brand);
        escrow.dispute(id, 0, "x");
    }

    function test_Dispute_RevertsOnSubmitted() public {
        _submit(id, 0);
        _expectStatus(SUBMITTED);
        vm.prank(creator);
        escrow.dispute(id, 0, "x");
    }

    function test_Dispute_RevertsOnReleased() public {
        _verify(id, 0);
        skip(120);
        escrow.release(id, 0);
        _expectStatus(RELEASED);
        vm.prank(brand);
        escrow.dispute(id, 0, "x");
    }

    function test_Dispute_RevertsOnRefunded() public {
        _failReport(id, 0);
        skip(120);
        escrow.refund(id, 0);
        _expectStatus(REFUNDED);
        vm.prank(creator);
        escrow.dispute(id, 0, "x");
    }

    function test_Dispute_RevertsWhenAlreadyDisputed() public {
        _verify(id, 0);
        _dispute(brand, id, 0);
        _expectStatus(DISPUTED);
        vm.prank(brand);
        escrow.dispute(id, 0, "again");
        _expectStatus(DISPUTED);
        vm.prank(creator);
        escrow.dispute(id, 0, "again");
        assertEq(court.caseCount(), 1);
    }

    function test_Dispute_VerifiedWindowBoundary() public {
        _verify(id, 0);
        _verify(id, 1);
        uint256 end = escrow.disputeWindowEnd(id, 0);
        vm.warp(end - 1);
        _dispute(brand, id, 0); // last valid second
        assertEq(_status(id, 0), DISPUTED);
        vm.warp(end);
        vm.prank(brand);
        vm.expectRevert(ClauseEscrow.DisputeWindowClosed.selector);
        escrow.dispute(id, 1, "late");
        vm.warp(end + 1 days);
        vm.prank(creator);
        vm.expectRevert(ClauseEscrow.DisputeWindowClosed.selector);
        escrow.dispute(id, 1, "later");
        assertEq(_status(id, 1), VERIFIED);
    }

    function test_Dispute_FailedWindowBoundary() public {
        _failReport(id, 0);
        _failReport(id, 1);
        uint256 end = escrow.disputeWindowEnd(id, 0);
        vm.warp(end - 1);
        _dispute(creator, id, 0);
        vm.warp(end);
        vm.prank(creator);
        vm.expectRevert(ClauseEscrow.DisputeWindowClosed.selector);
        escrow.dispute(id, 1, "late");
        assertEq(_status(id, 1), FAILED);
    }

    function test_Dispute_ExpiredClauseWithinWindow() public {
        vm.warp(block.timestamp + 8 days);
        escrow.expire(id, 0);
        _dispute(creator, id, 0);
        assertEq(_status(id, 0), DISPUTED);
    }

    function test_Dispute_RevertsOnUnfundedDeal() public {
        uint256 id2 = _propose(_mk(1));
        vm.prank(brand);
        vm.expectRevert(ClauseEscrow.NotFunded.selector);
        escrow.dispute(id2, 0, "x");
    }

    function test_Dispute_ReasonLengthBoundary() public {
        _verify(id, 0);
        vm.prank(brand);
        vm.expectRevert(ClauseEscrow.ReasonTooLong.selector);
        escrow.dispute(id, 0, _str(501));
        assertEq(_status(id, 0), VERIFIED);
        vm.prank(brand);
        escrow.dispute(id, 0, _str(500));
        assertEq(_status(id, 0), DISPUTED);
        assertEq(court.getCase(1).reason, _str(500));
    }

    function test_Dispute_CourtNotSetReverts() public {
        _freshEscrowNoCourt();
        uint256 id2 = _funded(_mk(1));
        _verify(id2, 0);
        vm.prank(brand);
        vm.expectRevert(ClauseEscrow.CourtNotSet.selector);
        escrow.dispute(id2, 0, "x");
        assertEq(_status(id2, 0), VERIFIED);
    }

    function test_Dispute_VerifiedPassesArgsToCourt() public {
        _verify(id, 1);
        vm.prank(creator);
        escrow.dispute(id, 1, "payment fair?");
        assertEq(court.caseCount(), 1);
        MockAICourt.Case memory c = court.getCase(1);
        assertEq(c.dealId, id);
        assertEq(c.clauseId, 1);
        assertEq(c.client, brand);
        assertEq(c.freelancer, creator);
        assertEq(c.reason, "payment fair?");
        (bool isFinal,) = court.finalVerdict(1);
        assertFalse(isFinal);
    }

    function test_Dispute_FailedPassesArgsToCourt() public {
        _failReport(id, 1);
        _dispute(brand, id, 1);
        MockAICourt.Case memory c = court.getCase(1);
        assertEq(c.client, brand);
        assertEq(c.freelancer, creator);
        assertEq(c.dealId, id);
        assertEq(c.clauseId, 1);
    }

    function test_Dispute_StoresCaseIdAndEmits() public {
        _verify(id, 0);
        _failReport(id, 1);
        vm.expectEmit(true, true, false, true, address(escrow));
        emit ClauseEscrow.ClauseDisputed(id, 0, 1, creator, "because");
        vm.prank(creator);
        escrow.dispute(id, 0, "because");
        assertEq(escrow.caseOf(id, 0), 1);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit ClauseEscrow.ClauseDisputed(id, 1, 2, brand, "other");
        vm.prank(brand);
        escrow.dispute(id, 1, "other");
        assertEq(escrow.caseOf(id, 1), 2);
        assertEq(escrow.caseOf(id, 2), 0, "undisputed clause has no case");
    }

    function test_Dispute_MovesNoFunds() public {
        _verify(id, 0);
        uint256 e = _bal(address(escrow));
        _dispute(brand, id, 0);
        assertEq(_bal(address(escrow)), e);
    }

    // ------------------------------------------------- frozen / refund rules

    function test_Disputed_ReleaseReverts() public {
        _verify(id, 0);
        _dispute(brand, id, 0);
        skip(1 days);
        _expectStatus(DISPUTED);
        escrow.release(id, 0);
        assertEq(_bal(creator), 0);
    }

    function test_Disputed_RefundReverts() public {
        _verify(id, 0);
        _dispute(creator, id, 0);
        skip(1 days);
        vm.expectRevert(ClauseEscrow.RefundNotAllowed.selector);
        escrow.refund(id, 0);
        _failReport(id, 1);
        _dispute(brand, id, 1);
        skip(1 days);
        vm.expectRevert(ClauseEscrow.RefundNotAllowed.selector);
        escrow.refund(id, 1);
    }

    function test_Disputed_NotCascadeRefundableWhenDependencyRefunded() public {
        // c2 depends on c0. c0 fails and is refunded; c2 (already Verified) is disputed first.
        _failReport(id, 0);
        _verify(id, 2);
        _dispute(creator, id, 2);
        skip(120);
        escrow.refund(id, 0);
        assertEq(_status(id, 0), REFUNDED);
        vm.expectRevert(ClauseEscrow.RefundNotAllowed.selector);
        escrow.refund(id, 2);
        _expectStatus(DISPUTED);
        escrow.release(id, 2);
        assertEq(_status(id, 2), DISPUTED);
    }

    function test_Refund_FailedWaitsForWindow() public {
        _failReport(id, 1);
        vm.expectRevert(ClauseEscrow.WindowOpen.selector);
        escrow.refund(id, 1);
        vm.warp(escrow.disputeWindowEnd(id, 1) - 1);
        vm.expectRevert(ClauseEscrow.WindowOpen.selector);
        escrow.refund(id, 1);
        vm.warp(escrow.disputeWindowEnd(id, 1));
        escrow.refund(id, 1);
        assertEq(_status(id, 1), REFUNDED);
    }

    function test_Refund_ExpiredWaitsForWindow() public {
        vm.warp(block.timestamp + 8 days);
        escrow.expire(id, 1);
        vm.expectRevert(ClauseEscrow.WindowOpen.selector);
        escrow.refund(id, 1);
        skip(120);
        escrow.refund(id, 1);
        assertEq(_status(id, 1), REFUNDED);
    }

    function test_Refund_CascadeDoesNotWaitForWindow() public {
        _failReport(id, 0);
        skip(120);
        escrow.refund(id, 0);
        // c2 (dep c0) is Pending and refundable immediately.
        escrow.refund(id, 2);
        assertEq(_status(id, 2), REFUNDED);
    }

    /// @dev CHANGED: a Failed dependent of a Refunded dependency now ALWAYS waits for its own window.
    function test_Refund_CascadeOfFailedDependentWaitsForWindow() public {
        _failReport(id, 0);
        skip(120);
        escrow.refund(id, 0);
        _failReport(id, 2);
        uint256 failedAt = block.timestamp;
        vm.expectRevert(ClauseEscrow.WindowOpen.selector);
        escrow.refund(id, 2); // same timestamp as its Failed verdict
        vm.warp(failedAt + 119);
        vm.expectRevert(ClauseEscrow.WindowOpen.selector);
        escrow.refund(id, 2);
        assertEq(_status(id, 2), FAILED);
        vm.warp(failedAt + 120);
        escrow.refund(id, 2);
        assertEq(_status(id, 2), REFUNDED);
    }

    function test_Refund_FailedDependentWithoutRefundedDependencyStillWaits() public {
        _verify(id, 0); // dependency Verified, not Refunded
        _failReport(id, 2);
        vm.expectRevert(ClauseEscrow.WindowOpen.selector);
        escrow.refund(id, 2);
    }
}
