// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {AICourtTestBase} from "./AICourt.Base.t.sol";
import {AICourt} from "../src/AICourt.sol";
import {MockEscrowView} from "../test-helpers/MockEscrowView.sol";
import {MockJurorRegistry} from "../test-helpers/MockJurorRegistry.sol";

/// @dev appealFee, appeal, and finalize for unappealed cases.
contract AICourtAppealTest is AICourtTestBase {
    // ------------------------------------------------------------ appealFee

    function test_AppealFee_TenPercent() public {
        uint256 id = _open();
        assertEq(court.appealFee(id), 100e6);
    }

    function test_AppealFee_FloorsOddAmounts() public {
        uint256 id = _open();
        uint256[8] memory amounts = [uint256(0), 9, 10, 19, 99, 1_234_567, 1_000_000_001, 999_999_999];
        uint256[8] memory fees = [uint256(0), 0, 1, 1, 9, 123_456, 100_000_000, 99_999_999];
        for (uint256 i = 0; i < amounts.length; ++i) {
            escrowMock.setAmount(amounts[i]);
            assertEq(court.appealFee(id), fees[i]);
        }
    }

    function testFuzz_AppealFee_MatchesFormula(uint256 amount) public {
        amount = bound(amount, 0, type(uint128).max);
        uint256 id = _open();
        escrowMock.setAmount(amount);
        assertEq(court.appealFee(id), amount * 1000 / 10000);
    }

    function test_AppealFee_UsesDealAndClauseOfTheCase() public {
        escrowMock.setClauseAmount(5, 3, 777e6);
        uint256 id = escrowMock.callOpenCase(5, 3, client, freelancer, "r");
        assertEq(court.appealFee(id), 77_700_000);
        uint256 id2 = _open(); // deal 1 clause 0 -> default amount
        assertEq(court.appealFee(id2), DEFAULT_FEE);
    }

    // ------------------------------------------------------------ appeal reverts

    function test_Appeal_UnknownCaseReverts() public {
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AICourt.UnknownCase.selector, uint256(1)));
        court.appeal(1);
    }

    function test_Appeal_OutsiderNotParty() public {
        uint256 id = _closed();
        address[3] memory who = [stranger, owner, forwarder];
        for (uint256 i = 0; i < who.length; ++i) {
            vm.prank(who[i]);
            vm.expectRevert(AICourt.NotParty.selector);
            court.appeal(id);
        }
    }

    function test_Appeal_OutsiderNotPartyEvenBeforeVerdict() public {
        uint256 id = _open();
        vm.prank(stranger);
        vm.expectRevert(AICourt.NotParty.selector);
        court.appeal(id);
    }

    function test_Appeal_NeedsAiVerdict() public {
        uint256 id = _open();
        vm.prank(client);
        vm.expectRevert(AICourt.NoAiVerdict.selector);
        court.appeal(id);
        _round(id, 0, _b3(50, 50, 50)); // reported but not closed
        vm.prank(freelancer);
        vm.expectRevert(AICourt.NoAiVerdict.selector);
        court.appeal(id);
    }

    function test_Appeal_OnlyOnce() public {
        uint256 id = _closed();
        _appealBy(id, client);
        vm.prank(client);
        vm.expectRevert(AICourt.AlreadyAppealed.selector);
        court.appeal(id);
        vm.prank(freelancer);
        vm.expectRevert(AICourt.AlreadyAppealed.selector);
        court.appeal(id);
        assertEq(_bal(address(court)), DEFAULT_FEE);
    }

    function test_Appeal_WindowInclusiveAtDeadline() public {
        uint256 id = _closed();
        vm.warp(court.getCase(id).appealDeadline);
        _appealBy(id, client);
        assertTrue(court.getCase(id).appealed);
    }

    function test_Appeal_RevertsAfterWindow() public {
        uint256 id = _closed();
        vm.warp(uint256(court.getCase(id).appealDeadline) + 1);
        vm.prank(client);
        vm.expectRevert(AICourt.AppealWindowClosed.selector);
        court.appeal(id);
        assertEq(_bal(client), PARTY_START);
    }

    function test_Appeal_RevertsJuryNotSet() public {
        MockEscrowView e = new MockEscrowView();
        e.setAmount(DEFAULT_AMOUNT);
        AICourt c = new AICourt(forwarder, address(usdc), address(e), owner);
        e.setCourt(address(c));
        vm.prank(client);
        usdc.approve(address(c), type(uint256).max);
        court = c;
        escrowMock = e;
        uint256 id = _closed();
        vm.prank(client);
        vm.expectRevert(AICourt.JuryNotSet.selector);
        court.appeal(id);
        assertEq(_bal(client), PARTY_START);
    }

    function test_Appeal_RevertsWithoutAllowance() public {
        uint256 id = _closed();
        vm.prank(client);
        usdc.approve(address(court), DEFAULT_FEE - 1);
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientAllowance.selector, address(court), DEFAULT_FEE - 1, DEFAULT_FEE
            )
        );
        court.appeal(id);
        assertFalse(court.getCase(id).appealed);
        assertEq(jury.panelCallCount(), 0);
    }

    function test_Appeal_RevertsWithoutBalance() public {
        uint256 id = _closed();
        vm.prank(client);
        usdc.transfer(stranger, PARTY_START - DEFAULT_FEE + 1);
        vm.prank(client);
        vm.expectRevert(
            abi.encodeWithSelector(
                IERC20Errors.ERC20InsufficientBalance.selector, client, DEFAULT_FEE - 1, DEFAULT_FEE
            )
        );
        court.appeal(id);
        assertFalse(court.getCase(id).appealed);
        assertEq(_bal(address(court)), 0);
    }

    function test_Appeal_OpenPanelRevertRollsEverythingBack() public {
        uint256 id = _closed();
        jury.setOpenPanelReverts(true);
        vm.prank(client);
        vm.expectRevert(MockJurorRegistry.MockOpenPanelReverted.selector);
        court.appeal(id);
        assertFalse(court.getCase(id).appealed);
        assertEq(_bal(client), PARTY_START);
        assertEq(_bal(address(court)), 0);
        // can retry once the registry works
        jury.setOpenPanelReverts(false);
        _appealBy(id, client);
        assertTrue(court.getCase(id).appealed);
    }

    // ------------------------------------------------------------ appeal happy path

    function test_Appeal_ClientPullsExactFeeAndWritesState() public {
        uint256 id = _closed();
        uint256 ts = block.timestamp;
        _appealBy(id, client);
        assertEq(_bal(client), PARTY_START - DEFAULT_FEE);
        assertEq(_bal(address(court)), DEFAULT_FEE);
        assertEq(_bal(freelancer), PARTY_START);
        AICourt.Case memory c = court.getCase(id);
        assertTrue(c.appealed);
        assertEq(c.appellant, client);
        assertEq(c.appealedAt, ts);
        assertEq(c.feePaid, DEFAULT_FEE);
        assertFalse(c.feeSettled);
        assertFalse(c.finalized);
    }

    function test_Appeal_FreelancerCanAppeal() public {
        uint256 id = _closed();
        _appealBy(id, freelancer);
        assertEq(court.getCase(id).appellant, freelancer);
        assertEq(_bal(freelancer), PARTY_START - DEFAULT_FEE);
        assertEq(_bal(client), PARTY_START);
    }

    function test_Appeal_EmitsAppealed() public {
        uint256 id = _closed();
        vm.expectEmit(true, false, false, true, address(court));
        emit AICourt.Appealed(id, freelancer, DEFAULT_FEE);
        _appealBy(id, freelancer);
    }

    function test_Appeal_OpensPanelWithCaseAndParties() public {
        uint256 id = _closed();
        _appealBy(id, freelancer);
        assertEq(jury.panelCallCount(), 1);
        MockJurorRegistry.PanelCall memory p = jury.panelCall(0);
        assertEq(p.caseId, id);
        assertEq(p.client, client);
        assertEq(p.freelancer, freelancer);
        assertEq(p.caller, address(court));
    }

    function test_Appeal_ZeroFeeAppealWorks() public {
        escrowMock.setAmount(5); // 5 * 10% floors to 0
        uint256 id = _closed();
        _appealBy(id, client);
        AICourt.Case memory c = court.getCase(id);
        assertTrue(c.appealed);
        assertEq(c.feePaid, 0);
        assertEq(_bal(client), PARTY_START);
        assertEq(_bal(address(court)), 0);
    }

    function test_Appeal_FeeFrozenAtAppealTime() public {
        uint256 id = _closed();
        _appealBy(id, client);
        escrowMock.setAmount(1);
        assertEq(court.getCase(id).feePaid, DEFAULT_FEE);
    }

    function testFuzz_Appeal_PullsExactlyFloorFee(uint256 amount) public {
        amount = bound(amount, 0, 5_000_000e6);
        escrowMock.setAmount(amount);
        uint256 id = _closed();
        _appealBy(id, client);
        assertEq(_bal(client), PARTY_START - amount * 1000 / 10000);
        assertEq(_bal(address(court)), amount * 1000 / 10000);
    }

    // ------------------------------------------------------------ finalize (unappealed)

    function test_Finalize_RevertsWithoutAiVerdict() public {
        uint256 id = _open();
        vm.expectRevert(AICourt.NoAiVerdict.selector);
        court.finalize(id);
        _round(id, 0, _b3(50, 50, 50));
        vm.expectRevert(AICourt.NoAiVerdict.selector);
        court.finalize(id);
    }

    function test_Finalize_UnknownCaseReverts() public {
        vm.expectRevert(abi.encodeWithSelector(AICourt.UnknownCase.selector, uint256(3)));
        court.finalize(3);
    }

    function test_Finalize_WindowOpenUpToAndIncludingDeadline() public {
        uint256 id = _closed();
        vm.expectRevert(AICourt.AppealWindowOpen.selector);
        court.finalize(id);
        vm.warp(court.getCase(id).appealDeadline);
        vm.expectRevert(AICourt.AppealWindowOpen.selector);
        court.finalize(id);
    }

    function test_Finalize_AfterWindowSetsAiBand() public {
        uint256 id = _closed();
        vm.warp(uint256(court.getCase(id).appealDeadline) + 1);
        vm.expectEmit(true, false, false, true, address(court));
        emit AICourt.Finalized(id, AI_BAND, false);
        vm.prank(stranger);
        court.finalize(id);
        AICourt.Case memory c = court.getCase(id);
        assertTrue(c.finalized);
        assertEq(c.finalBand, AI_BAND);
        assertFalse(c.byHumans);
        assertEq(_bal(address(court)), 0);
    }

    function test_Finalize_FinalVerdictOnlyAfterFinalize() public {
        uint256 id = _closed();
        (bool f, uint8 b) = court.finalVerdict(id);
        assertFalse(f);
        assertEq(b, 0);
        vm.warp(uint256(court.getCase(id).appealDeadline) + 1);
        (f, b) = court.finalVerdict(id);
        assertFalse(f);
        assertEq(b, 0);
        court.finalize(id);
        (f, b) = court.finalVerdict(id);
        assertTrue(f);
        assertEq(b, AI_BAND);
        (f, b) = court.finalVerdict(id + 1);
        assertFalse(f);
        assertEq(b, 0);
    }

    function test_Finalize_AlreadyFinalizedOnRepeat() public {
        uint256 id = _closed();
        vm.warp(uint256(court.getCase(id).appealDeadline) + 1);
        court.finalize(id);
        vm.expectRevert(AICourt.AlreadyFinalized.selector);
        court.finalize(id);
    }

    function test_Finalize_CannotAppealAfterFinalize() public {
        uint256 id = _closed();
        vm.warp(uint256(court.getCase(id).appealDeadline) + 1);
        court.finalize(id);
        vm.prank(client);
        vm.expectRevert(AICourt.AppealWindowClosed.selector);
        court.appeal(id);
    }

    function test_Finalize_IndependentCases() public {
        uint256 a = _closedWith(_b3(0, 0, 0));
        uint256 b = _closedWith(_b3(100, 100, 100));
        vm.warp(block.timestamp + 1000);
        court.finalize(b);
        (bool fa,) = court.finalVerdict(a);
        (bool fb, uint8 bandB) = court.finalVerdict(b);
        assertFalse(fa);
        assertTrue(fb);
        assertEq(bandB, 100);
    }
}
