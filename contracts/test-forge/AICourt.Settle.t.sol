// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AICourtTestBase} from "./AICourt.Base.t.sol";
import {AICourt} from "../src/AICourt.sol";
import {MockJurorRegistry} from "../test-helpers/MockJurorRegistry.sol";

/// @dev finalize() for appealed cases: jury decision handling and fee distribution.
contract AICourtSettleTest is AICourtTestBase {
    function _appealed(uint256 fee, address by) internal returns (uint256 id) {
        _setFee(fee);
        id = _closed(); // AI band 80
        _appealBy(id, by);
    }

    /// @dev Full human-path run; asserts exact payouts + conservation.
    function _runHuman(uint256 n, uint256 fee, uint8 band) internal {
        uint256 id = _appealed(fee, client);
        address[] memory js = _jurors(n);
        _decide(id, band, js);

        vm.expectEmit(true, false, false, true, address(court));
        emit AICourt.Finalized(id, band, true);
        vm.prank(stranger);
        court.finalize(id);

        uint256 share = fee / n;
        uint256 last = fee - share * (n - 1);
        for (uint256 i = 0; i < n; ++i) {
            assertEq(_bal(js[i]), i == n - 1 ? last : share, "juror payout");
        }
        assertEq(_sumBal(js), fee, "jurors receive exactly the fee");
        assertEq(_bal(address(court)), 0, "court drained");
        assertEq(_bal(client), PARTY_START - fee, "appellant not refunded");

        AICourt.Case memory c = court.getCase(id);
        assertTrue(c.finalized);
        assertTrue(c.feeSettled);
        assertTrue(c.byHumans);
        assertEq(c.finalBand, band);
        (bool f, uint8 b) = court.finalVerdict(id);
        assertTrue(f);
        assertEq(b, band);
    }

    // ------------------------------------------------------------ gating

    function test_Finalize_AppealedUndecidedReverts() public {
        uint256 id = _appealed(DEFAULT_FEE, client);
        vm.expectRevert(AICourt.JuryNotDecided.selector);
        court.finalize(id);
        // decided=false with a band still counts as undecided
        jury.setDecision(id, false, 50, _jurors(3));
        vm.expectRevert(AICourt.JuryNotDecided.selector);
        court.finalize(id);
        assertFalse(court.getCase(id).finalized);
        assertEq(_bal(address(court)), DEFAULT_FEE);
    }

    function test_Finalize_AppealedDoesNotNeedWindowToElapse() public {
        uint256 id = _appealed(DEFAULT_FEE, client);
        assertLe(block.timestamp, court.getCase(id).appealDeadline);
        _decide(id, 50, _jurors(2));
        court.finalize(id);
        assertTrue(court.getCase(id).finalized);
    }

    function test_Finalize_DecisionRevertBubblesAndNothingChanges() public {
        uint256 id = _appealed(DEFAULT_FEE, client);
        jury.setDecisionReverts(true);
        vm.expectRevert(MockJurorRegistry.MockDecisionReverted.selector);
        court.finalize(id);
        assertFalse(court.getCase(id).finalized);
        assertEq(_bal(address(court)), DEFAULT_FEE);
    }

    function test_Finalize_AlreadyFinalizedOnRepeat() public {
        uint256 id = _appealed(DEFAULT_FEE, client);
        _decide(id, 100, _jurors(2));
        court.finalize(id);
        vm.expectRevert(AICourt.AlreadyFinalized.selector);
        court.finalize(id);
        assertEq(_sumBal(_jurors(2)), DEFAULT_FEE);
    }

    function test_Finalize_AnyoneCanCall() public {
        address[3] memory callers = [stranger, owner, address(0xBEEF)];
        for (uint256 i = 0; i < callers.length; ++i) {
            uint256 id = _appealed(DEFAULT_FEE, client);
            _decide(id, 0, _jurors(1));
            vm.prank(callers[i]);
            court.finalize(id);
            assertTrue(court.getCase(id).finalized);
        }
    }

    // ------------------------------------------------------------ human path payouts

    function test_Human_SingleMember() public {
        _runHuman(1, DEFAULT_FEE, 50);
    }

    function test_Human_TwoMembersEvenFee() public {
        _runHuman(2, DEFAULT_FEE, 100);
    }

    function test_Human_ThreeMembersRemainderToLast() public {
        _runHuman(3, 100e6, 0); // 33_333_333 x2 + 33_333_334
        assertEq(_bal(_jurors(3)[2]), 33_333_334);
        assertEq(_bal(_jurors(3)[0]), 33_333_333);
    }

    function test_Human_SevenMembersOddFee() public {
        _runHuman(7, 100e6 + 3, 80);
    }

    function test_Human_OddFeeTwoMembers() public {
        _runHuman(2, 7, 50); // 3 + 4
        assertEq(_bal(_jurors(2)[0]), 3);
        assertEq(_bal(_jurors(2)[1]), 4);
    }

    function test_Human_FeeSmallerThanMemberCount() public {
        _runHuman(7, 3, 100); // share 0, last gets all 3
        assertEq(_bal(_jurors(7)[6]), 3);
        assertEq(_bal(_jurors(7)[0]), 0);
    }

    function test_Human_ZeroFeeSetsBandWithoutPayments() public {
        _runHuman(3, 0, 50);
    }

    function test_Human_BandDiffersFromAiBand() public {
        uint256 id = _appealed(DEFAULT_FEE, freelancer);
        assertEq(court.getCase(id).aiBand, AI_BAND);
        _decide(id, 0, _jurors(3));
        court.finalize(id);
        assertEq(court.getCase(id).aiBand, AI_BAND);
        assertEq(court.getCase(id).finalBand, 0);
        (, uint8 b) = court.finalVerdict(id);
        assertEq(b, 0);
    }

    function testFuzz_Human_ConservationAndExactSplit(uint256 n, uint256 fee, uint8 bandSel) public {
        n = bound(n, 1, 15);
        fee = bound(fee, 0, 50_000e6);
        uint8[4] memory bands = [0, 50, 80, 100];
        _runHuman(n, fee, bands[bandSel % 4]);
    }

    // ------------------------------------------------------------ refund paths

    function test_Human_EmptyMajorityRefundsAppellant() public {
        uint256 id = _appealed(DEFAULT_FEE, client);
        _decide(id, 50, new address[](0));
        vm.expectEmit(true, false, false, true, address(court));
        emit AICourt.Finalized(id, 50, true);
        court.finalize(id);
        assertEq(_bal(client), PARTY_START);
        assertEq(_bal(address(court)), 0);
        AICourt.Case memory c = court.getCase(id);
        assertEq(c.finalBand, 50);
        assertTrue(c.byHumans);
        assertTrue(c.feeSettled);
    }

    function test_Human_EmptyMajorityRefundsFreelancerAppellant() public {
        uint256 id = _appealed(DEFAULT_FEE, freelancer);
        _decide(id, 100, new address[](0));
        court.finalize(id);
        assertEq(_bal(freelancer), PARTY_START);
        assertEq(_bal(client), PARTY_START);
    }

    function test_Band255UsesAiBandAndRefundsAppellant() public {
        uint256 id = _appealed(DEFAULT_FEE, client);
        _decide(id, 255, _jurors(3)); // majority ignored for 255
        vm.expectEmit(true, false, false, true, address(court));
        emit AICourt.Finalized(id, AI_BAND, false);
        court.finalize(id);
        assertEq(_bal(client), PARTY_START);
        assertEq(_sumBal(_jurors(3)), 0);
        assertEq(_bal(address(court)), 0);
        AICourt.Case memory c = court.getCase(id);
        assertEq(c.finalBand, AI_BAND);
        assertFalse(c.byHumans);
        (bool f, uint8 b) = court.finalVerdict(id);
        assertTrue(f);
        assertEq(b, AI_BAND);
    }

    function test_Band255RefundsFreelancerAppellant() public {
        uint256 id = _appealed(DEFAULT_FEE, freelancer);
        _decide(id, 255, new address[](0));
        court.finalize(id);
        assertEq(_bal(freelancer), PARTY_START);
    }

    function test_InvalidHumanBandReverts() public {
        uint8[5] memory bad = [1, 30, 79, 101, 254];
        for (uint256 i = 0; i < bad.length; ++i) {
            uint256 id = _appealed(DEFAULT_FEE, client);
            _decide(id, bad[i], _jurors(3));
            vm.expectRevert(abi.encodeWithSelector(AICourt.InvalidBand.selector, bad[i]));
            court.finalize(id);
            AICourt.Case memory c = court.getCase(id);
            assertFalse(c.finalized);
            assertFalse(c.feeSettled);
            assertEq(_sumBal(_jurors(3)), 0);
        }
    }

    function test_FinalizeDoesNotTouchOtherCasesFees() public {
        uint256 a = _appealed(DEFAULT_FEE, client);
        uint256 b = _appealed(2 * DEFAULT_FEE, freelancer);
        _decide(a, 50, _jurors(2));
        court.finalize(a);
        assertEq(_bal(address(court)), 2 * DEFAULT_FEE);
        assertFalse(court.getCase(b).feeSettled);
        assertFalse(court.getCase(b).finalized);
    }
}
