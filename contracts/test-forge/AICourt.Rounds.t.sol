// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {AICourtTestBase} from "./AICourt.Base.t.sol";
import {AICourt} from "../src/AICourt.sol";
import {ReceiverTemplate} from "../src/cre/ReceiverTemplate.sol";

/// @dev Round report validation, storage and events.
contract AICourtRoundsTest is AICourtTestBase {
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        id = _open();
    }

    function _plain(uint8 round) internal view returns (bytes memory) {
        return _enc(id, round, _b3(50, 50, 50), _w3(10, 10, 10), _f3(false, false, false), _f3(false, false, false));
    }

    // ------------------------------------------------------------ authorization

    function test_Report_NonForwarderRejected() public {
        bytes memory r = _plain(0);
        address[3] memory callers = [stranger, owner, address(escrowMock)];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidSender.selector, callers[i], forwarder));
            court.onReport("", r);
        }
        assertEq(court.getCase(id).nextRound, 0);
    }

    function test_Report_ForwarderZeroedRejectsEveryone() public {
        vm.prank(owner);
        court.setForwarderAddress(address(0));
        bytes memory r = _plain(0);
        address[3] memory callers = [forwarder, stranger, owner];
        for (uint256 i = 0; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(AICourt.UnauthorizedReportForwarder.selector);
            court.onReport("", r);
        }
        assertEq(court.getCase(id).nextRound, 0);
    }

    function test_Report_RotatedForwarderWorksOldRejected() public {
        address nf = makeAddr("newForwarder");
        vm.prank(owner);
        court.setForwarderAddress(nf);
        bytes memory r = _plain(0);
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidSender.selector, forwarder, nf));
        court.onReport("", r);
        vm.prank(nf);
        court.onReport("", r);
        assertEq(court.getCase(id).nextRound, 1);
    }

    // ------------------------------------------------------------ kind / case / round / deadline

    function test_Report_WrongKindReverts() public {
        uint8[5] memory kinds = [0, 1, 5, 7, 255];
        for (uint256 i = 0; i < kinds.length; ++i) {
            bytes memory r = _encFull(
                kinds[i], id, 0, _b3(50, 50, 50), _w3(1, 1, 1), _f3(false, false, false), _f3(false, false, false),
                _b3(0, 0, 0), bytes32(0)
            );
            vm.prank(forwarder);
            vm.expectRevert(abi.encodeWithSelector(AICourt.InvalidReportKind.selector, kinds[i]));
            court.onReport("", r);
        }
    }

    function test_Report_UnknownCaseReverts() public {
        uint256[3] memory ids = [uint256(0), 2, 99];
        for (uint256 i = 0; i < ids.length; ++i) {
            bytes memory r = _enc(ids[i], 0, _b3(50, 50, 50), _w3(1, 1, 1), _f3(false, false, false), _f3(false, false, false));
            vm.prank(forwarder);
            vm.expectRevert(abi.encodeWithSelector(AICourt.UnknownCase.selector, ids[i]));
            court.onReport("", r);
        }
    }

    function test_Report_RoundsMustBeInOrder() public {
        // cannot start at 1 or 2
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(AICourt.WrongRound.selector, uint8(0), uint8(1)));
        court.onReport("", _plain(1));

        _send(_plain(0));
        // repeat
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(AICourt.WrongRound.selector, uint8(1), uint8(0)));
        court.onReport("", _plain(0));
        // skip
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(AICourt.WrongRound.selector, uint8(1), uint8(2)));
        court.onReport("", _plain(2));

        _send(_plain(1));
        _send(_plain(2));
        assertEq(court.getCase(id).nextRound, 3);
    }

    function test_Report_WorksAtExactDeadline() public {
        vm.warp(_deadline(id));
        _send(_plain(0));
        assertEq(court.getCase(id).nextRound, 1);
    }

    function test_Report_RevertsAfterDeadline() public {
        vm.warp(_deadline(id) + 1);
        bytes memory r = _plain(0);
        vm.prank(forwarder);
        vm.expectRevert(AICourt.DeadlinePassed.selector);
        court.onReport("", r);
    }

    function test_Report_DeadlineAfterExtensionIs240() public {
        _roundExt(id, 0, 2);
        assertEq(_deadline(id), T0 + 240);
        vm.warp(T0 + 240);
        _send(_plain(1));
        vm.warp(T0 + 241);
        bytes memory r = _plain(2);
        vm.prank(forwarder);
        vm.expectRevert(AICourt.DeadlinePassed.selector);
        court.onReport("", r);
    }

    // ------------------------------------------------------------ field validation

    function test_Report_WordsAtBudgetOk() public {
        _send(_enc(id, 0, _b3(50, 50, 50), _w3(200, 200, 200), _f3(false, false, false), _f3(false, false, false)));
        assertEq(court.judgeLatest(id, 2).wordsUsed, 200);
    }

    function test_Report_WordsOverBudgetReverts() public {
        for (uint8 j = 0; j < 3; ++j) {
            uint16[3] memory w = _w3(10, 10, 10);
            w[j] = 201;
            bytes memory r = _enc(id, 0, _b3(50, 50, 50), w, _f3(false, false, false), _f3(false, false, false));
            vm.prank(forwarder);
            vm.expectRevert(abi.encodeWithSelector(AICourt.WordsOverBudget.selector, j, uint16(201), uint16(200)));
            court.onReport("", r);
        }
        assertEq(court.getCase(id).nextRound, 0);
    }

    function test_Report_ExtensionVotesDoNotRaiseCurrentBudget() public {
        // budget is evaluated before this report's extension decision
        bytes memory r = _enc(id, 0, _b3(50, 50, 50), _w3(300, 10, 10), _f3(true, true, true), _f3(false, false, false));
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(AICourt.WordsOverBudget.selector, uint8(0), uint16(300), uint16(200)));
        court.onReport("", r);
    }

    function test_Report_BudgetRaisedAfterExtension() public {
        _roundExt(id, 0, 2);
        _send(_enc(id, 1, _b3(50, 50, 50), _w3(300, 300, 300), _f3(false, false, false), _f3(false, false, false)));
        bytes memory r = _enc(id, 2, _b3(50, 50, 50), _w3(10, 301, 10), _f3(false, false, false), _f3(false, false, false));
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(AICourt.WordsOverBudget.selector, uint8(1), uint16(301), uint16(300)));
        court.onReport("", r);
    }

    function test_Report_BadBandsRevert() public {
        uint8[5] memory bad = [1, 30, 101, 255, 79];
        for (uint256 k = 0; k < bad.length; ++k) {
            for (uint8 j = 0; j < 3; ++j) {
                uint8[3] memory b = _b3(0, 50, 100);
                b[j] = bad[k];
                bytes memory r = _enc(id, 0, b, _w3(10, 10, 10), _f3(false, false, false), _f3(false, false, false));
                vm.prank(forwarder);
                vm.expectRevert(abi.encodeWithSelector(AICourt.InvalidBand.selector, bad[k]));
                court.onReport("", r);
            }
        }
        assertEq(court.getCase(id).nextRound, 0);
    }

    function test_Report_AllValidBandsAccepted() public {
        _send(_enc(id, 0, _b3(0, 50, 80), _w3(1, 2, 3), _f3(false, false, false), _f3(false, false, false)));
        _send(_enc(id, 1, _b3(100, 0, 50), _w3(1, 2, 3), _f3(false, false, false), _f3(false, false, false)));
        assertEq(court.judgeLatest(id, 0).band, 100);
    }

    function test_Report_BadCitedMaskRevert() public {
        uint8[5] memory bad = [8, 0x10, 0x0F, 0x80, 255];
        for (uint256 k = 0; k < bad.length; ++k) {
            for (uint8 j = 0; j < 3; ++j) {
                uint8[3] memory m = _b3(0, 0, 0);
                m[j] = bad[k];
                bytes memory r = _encFull(
                    6, id, 0, _b3(50, 50, 50), _w3(10, 10, 10), _f3(false, false, false), _f3(false, false, false), m, bytes32(0)
                );
                vm.prank(forwarder);
                vm.expectRevert(abi.encodeWithSelector(AICourt.InvalidCitedMask.selector, j, bad[k]));
                court.onReport("", r);
            }
        }
    }

    function test_Report_ValidCitedMasksAccepted() public {
        for (uint8 m = 0; m < 8; ++m) {
            uint256 cid = _open();
            _send(
                _encFull(
                    6, cid, 0, _b3(50, 50, 50), _w3(10, 10, 10), _f3(false, false, false), _f3(false, false, false),
                    _b3(m, m, m), bytes32(0)
                )
            );
            assertEq(court.judgeLatest(cid, 1).citedMask, m);
        }
    }

    // ------------------------------------------------------------ events + storage

    function test_Report_EmitsJudgeUpdatedAndRoundCompleted() public {
        bytes32 th = keccak256("transcript");
        bytes memory r = _encFull(
            6, id, 0, _b3(0, 50, 100), _w3(1, 200, 150), _f3(false, true, false), _f3(true, false, true), _b3(1, 7, 4), th
        );
        vm.expectEmit(true, false, false, true, address(court));
        emit AICourt.JudgeUpdated(id, 0, 0, 0, 1, false, true, 1);
        vm.expectEmit(true, false, false, true, address(court));
        emit AICourt.JudgeUpdated(id, 0, 1, 50, 200, true, false, 7);
        vm.expectEmit(true, false, false, true, address(court));
        emit AICourt.JudgeUpdated(id, 0, 2, 100, 150, false, true, 4);
        vm.expectEmit(true, false, false, true, address(court));
        emit AICourt.RoundCompleted(id, 0, th);
        _send(r);
        assertEq(court.getCase(id).nextRound, 1);
    }

    function test_Report_StoresLatestJudgeValues() public {
        _send(_encFull(
            6, id, 0, _b3(0, 50, 100), _w3(1, 200, 150), _f3(false, true, false), _f3(true, false, true), _b3(1, 7, 4), bytes32(0)
        ));
        AICourt.Judge memory j1 = court.judgeLatest(id, 1);
        assertEq(j1.band, 50);
        assertEq(j1.wordsUsed, 200);
        assertTrue(j1.wantsExtend);
        assertFalse(j1.isFinal);
        assertEq(j1.citedMask, 7);

        // second round overwrites ("latest")
        _send(_encFull(
            6, id, 1, _b3(80, 80, 0), _w3(5, 6, 7), _f3(false, false, false), _f3(false, true, false), _b3(2, 3, 5), bytes32(0)
        ));
        AICourt.Judge memory a = court.judgeLatest(id, 0);
        AICourt.Judge memory b = court.judgeLatest(id, 1);
        AICourt.Judge memory c = court.judgeLatest(id, 2);
        assertEq(a.band, 80);
        assertEq(a.wordsUsed, 5);
        assertFalse(a.isFinal);
        assertEq(a.citedMask, 2);
        assertEq(b.band, 80);
        assertEq(b.wordsUsed, 6);
        assertTrue(b.isFinal);
        assertFalse(b.wantsExtend);
        assertEq(b.citedMask, 3);
        assertEq(c.band, 0);
        assertEq(c.wordsUsed, 7);
        assertEq(c.citedMask, 5);
    }

    function test_Report_FinalJudgeMayRepeatSameValues() public {
        _send(_enc(id, 0, _b3(50, 100, 80), _w3(40, 50, 60), _f3(false, false, false), _f3(true, false, false)));
        // judge 0 is final and repeats its band + wordsUsed; the others move
        _send(_enc(id, 1, _b3(50, 0, 0), _w3(40, 70, 80), _f3(false, false, false), _f3(true, false, true)));
        AICourt.Judge memory j0 = court.judgeLatest(id, 0);
        assertEq(j0.band, 50);
        assertEq(j0.wordsUsed, 40);
        assertTrue(j0.isFinal);
        assertEq(court.judgeLatest(id, 1).band, 0);
        assertTrue(court.judgeLatest(id, 2).isFinal);
        assertEq(court.getCase(id).nextRound, 2);
    }

    function test_Report_RejectedReportLeavesNoState() public {
        _send(_plain(0));
        bytes memory r = _enc(id, 1, _b3(50, 77, 50), _w3(99, 99, 99), _f3(true, true, true), _f3(true, true, true));
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(AICourt.InvalidBand.selector, uint8(77)));
        court.onReport("", r);
        AICourt.Case memory c = court.getCase(id);
        assertEq(c.nextRound, 1);
        assertEq(c.extensions, 0);
        assertEq(court.judgeLatest(id, 0).wordsUsed, 10);
        assertFalse(court.judgeLatest(id, 0).isFinal);
    }

    function test_Report_ReportsOnOneCaseDoNotAffectAnother() public {
        uint256 other = _open();
        _roundExt(id, 0, 3);
        assertEq(court.getCase(other).wordBudget, 200);
        assertEq(court.getCase(other).nextRound, 0);
        assertEq(court.judgeLatest(other, 0).wordsUsed, 0);
    }
}
