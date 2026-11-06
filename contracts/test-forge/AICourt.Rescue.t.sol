// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AICourtTestBase} from "./AICourt.Base.t.sol";
import {AICourt} from "../src/AICourt.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";
import {MockBlacklistERC20} from "../test-helpers/MockBlacklistERC20.sol";

/// @dev rescueFee and its interaction with finalize (fee is paid at most once).
contract AICourtRescueTest is AICourtTestBase {
    uint256 internal id;
    uint256 internal appealedAt;

    function setUp() public override {
        super.setUp();
        id = _closed();
        _appealBy(id, client);
        appealedAt = block.timestamp;
    }

    // ------------------------------------------------------------ gating

    function test_Rescue_UnknownCaseReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AICourt.UnknownCase.selector, uint256(0)));
        court.rescueFee(0);
        vm.expectRevert(abi.encodeWithSelector(AICourt.UnknownCase.selector, uint256(50)));
        court.rescueFee(50);
    }

    function test_Rescue_OnlyAppealedCases() public {
        uint256 other = _closed();
        vm.warp(block.timestamp + 10 days);
        vm.expectRevert(AICourt.NotAppealed.selector);
        court.rescueFee(other);
        uint256 open_ = _open();
        vm.expectRevert(AICourt.NotAppealed.selector);
        court.rescueFee(open_);
    }

    function test_Rescue_TooEarly() public {
        vm.expectRevert(AICourt.RescueTooEarly.selector);
        court.rescueFee(id);
        vm.warp(appealedAt + 1 days - 1);
        vm.expectRevert(AICourt.RescueTooEarly.selector);
        court.rescueFee(id);
    }

    function test_Rescue_TooEarlyAtExactly1Day() public {
        vm.warp(appealedAt + 1 days);
        vm.expectRevert(AICourt.RescueTooEarly.selector);
        court.rescueFee(id);
        assertEq(_bal(address(court)), DEFAULT_FEE);
    }

    function test_Rescue_DelayRunsFromAppealNotFromVerdict() public {
        // appeal at the very end of the window
        uint256 other = _closed();
        vm.warp(court.getCase(other).appealDeadline);
        uint256 at = block.timestamp;
        _appealBy(other, freelancer);
        vm.warp(court.getCase(other).appealDeadline + 1 days); // == at + 1 days
        assertEq(block.timestamp, at + 1 days);
        vm.expectRevert(AICourt.RescueTooEarly.selector);
        court.rescueFee(other);
        vm.warp(at + 1 days + 1);
        court.rescueFee(other);
    }

    // ------------------------------------------------------------ happy path

    function test_Rescue_ReturnsFeeToAppellantAndEmits() public {
        vm.warp(appealedAt + 1 days + 1);
        vm.expectEmit(true, true, false, true, address(court));
        emit AICourt.FeeRescued(id, client, DEFAULT_FEE);
        vm.prank(stranger);
        court.rescueFee(id);
        assertEq(_bal(client), PARTY_START);
        assertEq(_bal(address(court)), 0);
        AICourt.Case memory c = court.getCase(id);
        assertTrue(c.feeSettled);
        assertFalse(c.finalized);
        (bool f, uint8 b) = court.finalVerdict(id);
        assertFalse(f);
        assertEq(b, 0);
    }

    function test_Rescue_FreelancerAppellantRefunded() public {
        uint256 other = _closed();
        _appealBy(other, freelancer);
        uint256 at = block.timestamp;
        vm.warp(at + 1 days + 1);
        vm.expectEmit(true, true, false, true, address(court));
        emit AICourt.FeeRescued(other, freelancer, DEFAULT_FEE);
        court.rescueFee(other);
        assertEq(_bal(freelancer), PARTY_START);
    }

    function test_Rescue_ZeroFeeEmitsAndMovesNothing() public {
        escrowMock.setAmount(3);
        uint256 other = _closed();
        _appealBy(other, client);
        vm.warp(block.timestamp + 1 days + 1);
        vm.expectEmit(true, true, false, true, address(court));
        emit AICourt.FeeRescued(other, client, 0);
        court.rescueFee(other);
        assertTrue(court.getCase(other).feeSettled);
    }

    function test_Rescue_OnlyOnce() public {
        vm.warp(appealedAt + 1 days + 1);
        court.rescueFee(id);
        vm.expectRevert(AICourt.FeeAlreadySettled.selector);
        court.rescueFee(id);
        assertEq(_bal(client), PARTY_START);
    }

    // ------------------------------------------------------------ rescue vs finalize

    function test_FinalizeAfterRescueSetsBandButPaysNothing() public {
        address[] memory js = _jurors(3);
        _decide(id, 50, js);
        vm.warp(appealedAt + 1 days + 1);
        court.rescueFee(id);
        uint256 clientBal = _bal(client);
        uint256 courtBal = _bal(address(court));

        vm.expectEmit(true, false, false, true, address(court));
        emit AICourt.Finalized(id, 50, true);
        court.finalize(id);

        assertEq(_bal(client), clientBal);
        assertEq(_bal(address(court)), courtBal);
        assertEq(_sumBal(js), 0);
        AICourt.Case memory c = court.getCase(id);
        assertTrue(c.finalized);
        assertEq(c.finalBand, 50);
        assertTrue(c.byHumans);
        (bool f, uint8 b) = court.finalVerdict(id);
        assertTrue(f);
        assertEq(b, 50);
    }

    function test_FinalizeAfterRescueStillNeedsDecision() public {
        vm.warp(appealedAt + 1 days + 1);
        court.rescueFee(id);
        vm.expectRevert(AICourt.JuryNotDecided.selector);
        court.finalize(id);
    }

    function test_FinalizeAfterRescueBand255() public {
        _decide(id, 255, new address[](0));
        vm.warp(appealedAt + 1 days + 1);
        court.rescueFee(id);
        court.finalize(id);
        assertEq(_bal(client), PARTY_START); // refunded once, not twice
        assertEq(court.getCase(id).finalBand, AI_BAND);
        assertFalse(court.getCase(id).byHumans);
    }

    function test_RescueAfterFinalizeReverts() public {
        _decide(id, 80, _jurors(2));
        court.finalize(id);
        vm.warp(appealedAt + 1 days + 1);
        vm.expectRevert(AICourt.FeeAlreadySettled.selector);
        court.rescueFee(id);
        assertEq(_sumBal(_jurors(2)), DEFAULT_FEE);
        assertEq(_bal(address(court)), 0);
    }

    function test_RescueAfterRefundFinalizeReverts() public {
        _decide(id, 255, new address[](0));
        court.finalize(id);
        vm.warp(appealedAt + 1 days + 1);
        vm.expectRevert(AICourt.FeeAlreadySettled.selector);
        court.rescueFee(id);
        assertEq(_bal(client), PARTY_START);
    }

    function test_RescueUnblocksInvalidBandFinalizeAttempt() public {
        _decide(id, 33, _jurors(2));
        vm.expectRevert(abi.encodeWithSelector(AICourt.InvalidBand.selector, uint8(33)));
        court.finalize(id);
        vm.warp(appealedAt + 1 days + 1);
        court.rescueFee(id);
        assertEq(_bal(client), PARTY_START);
    }

    function test_RescueDoesNotAffectOtherCasesFee() public {
        uint256 other = _closed();
        _appealBy(other, client);
        vm.warp(block.timestamp + 1 days + 1);
        court.rescueFee(id);
        assertEq(_bal(address(court)), DEFAULT_FEE);
        assertFalse(court.getCase(other).feeSettled);
    }
}

/// @dev Same fixture, but USDC reverts on transfers to blacklisted recipients.
contract AICourtBlockedRecipientTest is AICourtTestBase {
    MockBlacklistERC20 internal bl;

    function _deployUsdc() internal override returns (MockERC20) {
        bl = new MockBlacklistERC20("Mock USDC", "mUSDC", 6);
        return bl;
    }

    /// @dev TOUCHED: previously a blocked juror reverted finalize until rescue. Now finalize
    ///      succeeds, credits the blocked juror, and claimFee pays it once after unblocking.
    function test_BlockedJurorNoLongerBlocksFinalize_CreditedAndClaimable() public {
        uint256 id = _closed();
        _appealBy(id, client);
        address[] memory js = _jurors(3);
        _decide(id, 50, js);
        bl.setBlacklisted(js[1], true);
        uint256 share = DEFAULT_FEE / 3; // 33_333_333; last member gets 33_333_334

        vm.expectEmit(true, false, false, true, address(court));
        emit AICourt.FeeCredited(js[1], share);
        court.finalize(id);

        (bool f, uint8 b) = court.finalVerdict(id);
        assertTrue(f);
        assertEq(b, 50);
        assertTrue(court.getCase(id).feeSettled);
        assertEq(_bal(js[0]), share);
        assertEq(_bal(js[1]), 0);
        assertEq(_bal(js[2]), DEFAULT_FEE - 2 * share);
        assertEq(court.claimable(js[1]), share);
        assertEq(court.totalClaimable(), share);
        assertEq(_bal(address(court)), share); // balances conserved: only the credit remains

        // still blocked: claim reverts and the credit persists
        vm.prank(js[1]);
        vm.expectRevert(abi.encodeWithSelector(MockBlacklistERC20.Blacklisted.selector, js[1]));
        court.claimFee();
        assertEq(court.claimable(js[1]), share);
        assertEq(court.totalClaimable(), share);
        assertEq(_bal(address(court)), share);

        // rescue cannot pay it a second time
        vm.warp(block.timestamp + 1 days + 1);
        vm.expectRevert(AICourt.FeeAlreadySettled.selector);
        court.rescueFee(id);

        // unblocked: paid exactly once
        bl.setBlacklisted(js[1], false);
        vm.expectEmit(true, false, false, true, address(court));
        emit AICourt.FeeClaimed(js[1], share);
        vm.prank(js[1]);
        court.claimFee();
        assertEq(_bal(js[1]), share);
        assertEq(_sumBal(js), DEFAULT_FEE);
        assertEq(court.claimable(js[1]), 0);
        assertEq(court.totalClaimable(), 0);
        assertEq(_bal(address(court)), 0);
        vm.prank(js[1]);
        vm.expectRevert(AICourt.NothingToClaim.selector);
        court.claimFee();
    }

    /// @dev TOUCHED: previously finalize reverted until the juror was unblocked. Now the
    ///      blocked juror is credited at finalize and the whole fee is delivered after unblocking.
    function test_BlockedJurorCreditedThenUnblockedClaimsRestPaid() public {
        uint256 id = _closed();
        _appealBy(id, freelancer);
        address[] memory js = _jurors(2);
        _decide(id, 100, js);
        bl.setBlacklisted(js[0], true);
        court.finalize(id); // does not revert
        assertEq(court.getCase(id).finalBand, 100);
        assertEq(_bal(js[1]), DEFAULT_FEE / 2);
        assertEq(court.claimable(js[0]), DEFAULT_FEE / 2);
        bl.setBlacklisted(js[0], false);
        vm.prank(js[0]);
        court.claimFee();
        assertEq(_sumBal(js), DEFAULT_FEE);
        assertEq(_bal(address(court)), 0);
    }
}
