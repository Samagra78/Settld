// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AICourtTestBase} from "./AICourt.Base.t.sol";
import {AICourt} from "../src/AICourt.sol";
import {ReceiverTemplate} from "../src/cre/ReceiverTemplate.sol";
import {MockJurorRegistry} from "../test-helpers/MockJurorRegistry.sol";

/// @dev Constructor, setJury, openCase and view behaviour.
contract AICourtAdminTest is AICourtTestBase {
    // ------------------------------------------------------------ constructor

    function test_Constructor_SetsState() public view {
        assertEq(court.usdc(), address(usdc));
        assertEq(court.escrow(), address(escrowMock));
        assertEq(court.owner(), owner);
        assertEq(court.getForwarderAddress(), forwarder);
        assertEq(court.caseCount(), 0);
    }

    function test_Constructor_Constants() public view {
        assertEq(court.WORD_BUDGET(), 200);
        assertEq(court.EXTEND_WORDS(), 100);
        assertEq(court.EXTEND_SECS(), 60);
        assertEq(court.BASE_SECS(), 180);
        assertEq(court.HARD_CAP_SECS(), 300);
        assertEq(court.MAX_EXT(), 2);
        assertEq(court.MAX_ROUNDS(), 3);
        assertEq(court.APPEAL_BPS(), 1000);
        assertEq(court.BPS_DENOMINATOR(), 10000);
        assertEq(court.APPEAL_WINDOW(), 120);
        assertEq(court.RESCUE_DELAY(), 1 days);
    }

    function test_Constructor_RevertsZeroUsdc() public {
        vm.expectRevert(AICourt.ZeroUSDC.selector);
        new AICourt(forwarder, address(0), address(escrowMock), owner);
    }

    function test_Constructor_RevertsZeroEscrow() public {
        vm.expectRevert(AICourt.ZeroEscrow.selector);
        new AICourt(forwarder, address(usdc), address(0), owner);
    }

    function test_Constructor_RevertsZeroOwner() public {
        vm.expectRevert(AICourt.ZeroOwner.selector);
        new AICourt(forwarder, address(usdc), address(escrowMock), address(0));
    }

    function test_Constructor_RevertsUsdcWithoutCode() public {
        vm.expectRevert(AICourt.USDCNotContract.selector);
        new AICourt(forwarder, makeAddr("eoaUsdc"), address(escrowMock), owner);
    }

    function test_Constructor_RevertsEscrowWithoutCode() public {
        vm.expectRevert(AICourt.EscrowNotContract.selector);
        new AICourt(forwarder, address(usdc), makeAddr("eoaEscrow"), owner);
    }

    function test_Constructor_RevertsZeroForwarder() public {
        vm.expectRevert(ReceiverTemplate.InvalidForwarderAddress.selector);
        new AICourt(address(0), address(usdc), address(escrowMock), owner);
    }

    // ------------------------------------------------------------ setJury

    function _freshCourt() internal returns (AICourt c) {
        c = new AICourt(forwarder, address(usdc), address(escrowMock), owner);
    }

    function test_SetJury_OwnerSetsAndEmits() public {
        AICourt c = _freshCourt();
        MockJurorRegistry j = new MockJurorRegistry();
        vm.expectEmit(true, false, false, false, address(c));
        emit AICourt.JurySet(address(j));
        vm.prank(owner);
        c.setJury(address(j));
        assertEq(address(c.jury()), address(j));
    }

    function test_SetJury_RevertsForNonOwner() public {
        AICourt c = _freshCourt();
        MockJurorRegistry j = new MockJurorRegistry();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        c.setJury(address(j));
    }

    function test_SetJury_OnlyOnce() public {
        // base fixture already set the jury
        MockJurorRegistry j2 = new MockJurorRegistry();
        vm.prank(owner);
        vm.expectRevert(AICourt.JuryAlreadySet.selector);
        court.setJury(address(j2));
        assertEq(address(court.jury()), address(jury));
    }

    function test_SetJury_RevertsZero() public {
        AICourt c = _freshCourt();
        vm.prank(owner);
        vm.expectRevert(AICourt.ZeroJury.selector);
        c.setJury(address(0));
    }

    function test_SetJury_RevertsWithoutCode() public {
        AICourt c = _freshCourt();
        vm.prank(owner);
        vm.expectRevert(AICourt.JuryNotContract.selector);
        c.setJury(makeAddr("eoaJury"));
    }

    function test_SetJury_FailedAttemptDoesNotConsumeOnce() public {
        AICourt c = _freshCourt();
        vm.prank(owner);
        vm.expectRevert(AICourt.ZeroJury.selector);
        c.setJury(address(0));
        MockJurorRegistry j = new MockJurorRegistry();
        vm.prank(owner);
        c.setJury(address(j));
        assertEq(address(c.jury()), address(j));
    }

    // ------------------------------------------------------------ openCase

    function test_OpenCase_StoresFreshCase() public {
        uint256 id = escrowMock.callOpenCase(7, 2, client, freelancer, "why");
        assertEq(id, 1);
        assertEq(court.caseCount(), 1);
        AICourt.Case memory c = court.getCase(1);
        assertEq(c.dealId, 7);
        assertEq(c.clauseId, 2);
        assertEq(c.client, client);
        assertEq(c.freelancer, freelancer);
        assertEq(c.openedAt, T0);
        assertEq(c.deadline, T0 + 180);
        assertEq(c.wordBudget, 200);
        assertEq(c.extensions, 0);
        assertEq(c.nextRound, 0);
        assertFalse(c.aiSet);
        assertEq(c.aiBand, 0);
        assertEq(c.appealDeadline, 0);
        assertFalse(c.appealed);
        assertEq(c.appellant, address(0));
        assertEq(c.appealedAt, 0);
        assertEq(c.feePaid, 0);
        assertFalse(c.feeSettled);
        assertFalse(c.finalized);
        assertEq(c.finalBand, 0);
        assertFalse(c.byHumans);
    }

    function test_OpenCase_EmitsCaseOpenedExact() public {
        vm.expectEmit(true, false, false, true, address(court));
        emit AICourt.CaseOpened(1, 7, 2, "why", uint64(T0 + 180));
        escrowMock.callOpenCase(7, 2, client, freelancer, "why");
    }

    function test_OpenCase_IdsSequentialAndDeadlinePerOpenTime() public {
        uint256 a = _open();
        vm.warp(T0 + 1000);
        uint256 b = _open();
        uint256 c = _open();
        assertEq(a, 1);
        assertEq(b, 2);
        assertEq(c, 3);
        assertEq(court.caseCount(), 3);
        assertEq(court.getCase(1).deadline, T0 + 180);
        assertEq(court.getCase(2).deadline, T0 + 1000 + 180);
        assertEq(court.getCase(2).openedAt, T0 + 1000);
    }

    function test_OpenCase_RevertsForNonEscrow() public {
        address[4] memory callers = [stranger, owner, forwarder, client];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(AICourt.NotEscrow.selector);
            court.openCase(1, 0, client, freelancer, "x");
        }
        assertEq(court.caseCount(), 0);
    }

    function test_OpenCase_MovesNoFunds() public {
        uint256 before_ = _bal(address(court));
        _open();
        assertEq(_bal(address(court)), before_);
        assertEq(_bal(client), PARTY_START);
    }

    // ------------------------------------------------------------ views

    function test_Views_UnknownCaseReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AICourt.UnknownCase.selector, uint256(0)));
        court.getCase(0);
        vm.expectRevert(abi.encodeWithSelector(AICourt.UnknownCase.selector, uint256(1)));
        court.getCase(1);
        _open();
        vm.expectRevert(abi.encodeWithSelector(AICourt.UnknownCase.selector, uint256(2)));
        court.getCase(2);
        vm.expectRevert(abi.encodeWithSelector(AICourt.UnknownCase.selector, uint256(99)));
        court.judgeLatest(99, 0);
        vm.expectRevert(abi.encodeWithSelector(AICourt.UnknownCase.selector, uint256(0)));
        court.appealFee(0);
    }

    function test_JudgeLatest_ZeroBeforeReportAndInvalidJudge() public {
        uint256 id = _open();
        for (uint8 j = 0; j < 3; ++j) {
            AICourt.Judge memory jd = court.judgeLatest(id, j);
            assertEq(jd.wordsUsed, 0);
            assertEq(jd.band, 0);
            assertFalse(jd.wantsExtend);
            assertFalse(jd.isFinal);
            assertEq(jd.citedMask, 0);
        }
        vm.expectRevert(abi.encodeWithSelector(AICourt.InvalidJudge.selector, uint8(3)));
        court.judgeLatest(id, 3);
        vm.expectRevert(abi.encodeWithSelector(AICourt.InvalidJudge.selector, uint8(255)));
        court.judgeLatest(id, 255);
        // unknown case takes precedence over invalid judge
        vm.expectRevert(abi.encodeWithSelector(AICourt.UnknownCase.selector, uint256(42)));
        court.judgeLatest(42, 3);
    }

    function test_FinalVerdict_UnknownIdsAreNotFinal() public view {
        (bool f, uint8 b) = court.finalVerdict(0);
        assertFalse(f);
        assertEq(b, 0);
        (f, b) = court.finalVerdict(1);
        assertFalse(f);
        assertEq(b, 0);
        (f, b) = court.finalVerdict(type(uint256).max);
        assertFalse(f);
        assertEq(b, 0);
    }
}
