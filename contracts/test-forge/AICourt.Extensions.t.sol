// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {AICourtTestBase} from "./AICourt.Base.t.sol";
import {AICourt} from "../src/AICourt.sol";

/// @dev Extension voting, round limits, hard cap and the real WF3 replay.
contract AICourtExtensionsTest is AICourtTestBase {
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        id = _open();
    }

    function _countTopic(Vm.Log[] memory logs, bytes32 topic) internal pure returns (uint256 n) {
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic) ++n;
        }
    }

    function _expectRoundLimit(uint8 round) internal {
        bytes memory r = _enc(id, round, _b3(50, 50, 50), _w3(10, 10, 10), _f3(false, false, false), _f3(false, false, false));
        vm.prank(forwarder);
        vm.expectRevert(AICourt.RoundLimitReached.selector);
        court.onReport("", r);
    }

    // ------------------------------------------------------------ granting

    function test_Ext_TwoVotesGrantsOne() public {
        vm.expectEmit(true, false, false, true, address(court));
        emit AICourt.ExtensionGranted(id, 300, uint64(T0 + 240));
        _roundExt(id, 0, 2);
        AICourt.Case memory c = court.getCase(id);
        assertEq(c.extensions, 1);
        assertEq(c.wordBudget, 300);
        assertEq(c.deadline, T0 + 240);
        assertEq(c.openedAt, T0);
    }

    function test_Ext_ThreeVotesGrantsOne() public {
        vm.expectEmit(true, false, false, true, address(court));
        emit AICourt.ExtensionGranted(id, 300, uint64(T0 + 240));
        _roundExt(id, 0, 3);
        AICourt.Case memory c = court.getCase(id);
        assertEq(c.extensions, 1);
        assertEq(c.wordBudget, 300);
        assertEq(c.deadline, T0 + 240);
    }

    function test_Ext_AnyTwoJudgesCount() public {
        _send(_enc(id, 0, _b3(50, 50, 50), _w3(1, 1, 1), _f3(false, true, true), _f3(false, false, false)));
        assertEq(court.getCase(id).extensions, 1);
        uint256 id2 = _open();
        _send(_enc(id2, 0, _b3(50, 50, 50), _w3(1, 1, 1), _f3(true, false, true), _f3(false, false, false)));
        assertEq(court.getCase(id2).extensions, 1);
    }

    function test_Ext_SingleVoteGrantsNothing() public {
        vm.recordLogs();
        _roundExt(id, 0, 1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countTopic(logs, AICourt.ExtensionGranted.selector), 0);
        AICourt.Case memory c = court.getCase(id);
        assertEq(c.extensions, 0);
        assertEq(c.wordBudget, 200);
        assertEq(c.deadline, T0 + 180);
        // the vote is still recorded on the judge
        assertTrue(court.judgeLatest(id, 0).wantsExtend);
    }

    function test_Ext_ZeroVotesGrantsNothing() public {
        _roundExt(id, 0, 0);
        assertEq(court.getCase(id).extensions, 0);
        assertEq(court.getCase(id).deadline, T0 + 180);
    }

    function test_Ext_VotesAcrossRoundsDoNotAccumulate() public {
        // one vote in round 0 and one in round 1: never two in the same report
        _send(_enc(id, 0, _b3(50, 50, 50), _w3(1, 1, 1), _f3(true, false, false), _f3(false, false, false)));
        _send(_enc(id, 1, _b3(50, 50, 50), _w3(1, 1, 1), _f3(false, true, false), _f3(false, false, false)));
        assertEq(court.getCase(id).extensions, 0);
    }

    function test_Ext_TwoExtensionsReachBudget400AndHardCap() public {
        _roundExt(id, 0, 2);
        vm.expectEmit(true, false, false, true, address(court));
        emit AICourt.ExtensionGranted(id, 400, uint64(T0 + 300));
        _roundExt(id, 1, 3);
        AICourt.Case memory c = court.getCase(id);
        assertEq(c.extensions, 2);
        assertEq(c.wordBudget, 400);
        assertEq(c.deadline, T0 + 300);
        assertLe(c.deadline, uint256(c.openedAt) + court.HARD_CAP_SECS());
    }

    function test_Ext_ThirdRequestIgnored() public {
        _roundExt(id, 0, 2);
        _roundExt(id, 1, 2);
        vm.recordLogs();
        _roundExt(id, 2, 3);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countTopic(logs, AICourt.ExtensionGranted.selector), 0);
        AICourt.Case memory c = court.getCase(id);
        assertEq(c.extensions, 2);
        assertEq(c.wordBudget, 400);
        assertEq(c.deadline, T0 + 300);
        assertEq(c.nextRound, 3);
    }

    function test_Ext_HardCapNeverExceededEvenWhenOpenedLater() public {
        vm.warp(T0 + 5000);
        uint256 other = _open();
        _roundExt(other, 0, 2);
        _roundExt(other, 1, 2);
        _roundExt(other, 2, 2);
        AICourt.Case memory c = court.getCase(other);
        assertEq(c.deadline, T0 + 5000 + 300);
        // reports allowed at hard cap, not after
        vm.warp(T0 + 5000 + 300);
        _roundExt(other, 3, 0);
        vm.warp(T0 + 5000 + 301);
        bytes memory r = _enc(other, 4, _b3(50, 50, 50), _w3(1, 1, 1), _f3(false, false, false), _f3(false, false, false));
        vm.prank(forwarder);
        vm.expectRevert(AICourt.DeadlinePassed.selector);
        court.onReport("", r);
    }

    // ------------------------------------------------------------ round limit

    function test_Rounds_ThreeWithoutExtension() public {
        for (uint8 r = 0; r < 3; ++r) {
            _roundExt(id, r, 1);
        }
        assertEq(court.getCase(id).nextRound, 3);
        _expectRoundLimit(3);
    }

    function test_Rounds_FourWithOneExtension() public {
        _roundExt(id, 0, 2);
        for (uint8 r = 1; r < 4; ++r) {
            _roundExt(id, r, 0);
        }
        assertEq(court.getCase(id).nextRound, 4);
        _expectRoundLimit(4);
    }

    function test_Rounds_FiveWithTwoExtensions() public {
        _roundExt(id, 0, 2);
        _roundExt(id, 1, 2);
        for (uint8 r = 2; r < 5; ++r) {
            _roundExt(id, r, 0);
        }
        assertEq(court.getCase(id).nextRound, 5);
        _expectRoundLimit(5);
    }

    function test_Rounds_ExtensionGrantedInLastBaseRoundAllowsFourth() public {
        // limit uses extensions as they were BEFORE the report: round 2 is still allowed
        // under the base limit, and its own extension then allows round 3.
        _roundExt(id, 0, 0);
        _roundExt(id, 1, 0);
        _roundExt(id, 2, 2);
        _roundExt(id, 3, 0);
        _expectRoundLimit(4);
    }

    function test_Rounds_RoundLimitCheckedBeforeFieldValidation() public {
        for (uint8 r = 0; r < 3; ++r) {
            _roundExt(id, r, 0);
        }
        // invalid band in a round beyond the limit still reports the round limit
        bytes memory rep = _enc(id, 3, _b3(1, 1, 1), _w3(1, 1, 1), _f3(false, false, false), _f3(false, false, false));
        vm.prank(forwarder);
        vm.expectRevert(AICourt.RoundLimitReached.selector);
        court.onReport("", rep);
    }

    // ------------------------------------------------------------ WF3 replay

    function test_WF3_Replay() public {
        // round 0: two of three want more time -> extension granted
        vm.expectEmit(true, false, false, true, address(court));
        emit AICourt.ExtensionGranted(id, 300, uint64(T0 + 240));
        _send(_enc(id, 0, _b3(50, 100, 80), _w3(150, 170, 160), _f3(true, true, false), _f3(false, false, false)));
        AICourt.Case memory c = court.getCase(id);
        assertEq(c.wordBudget, 300);
        assertEq(c.deadline, T0 + 240);
        assertEq(c.extensions, 1);

        // not closable yet: nobody final, before the deadline
        vm.expectRevert(AICourt.CannotCloseYet.selector);
        court.closeCase(id);

        // round 1: 190/210/200 words only valid because the budget is now 300; all final
        vm.warp(T0 + 100);
        _send(_enc(id, 1, _b3(50, 100, 80), _w3(190, 210, 200), _f3(false, false, false), _f3(true, true, true)));
        assertEq(court.judgeLatest(id, 1).wordsUsed, 210);

        // all final => closes immediately, well before the deadline; three different bands -> middle
        vm.expectEmit(true, false, false, true, address(court));
        emit AICourt.AIVerdict(id, 80, uint64(T0 + 100 + 120));
        court.closeCase(id);
        c = court.getCase(id);
        assertTrue(c.aiSet);
        assertEq(c.aiBand, 80);
        assertEq(c.appealDeadline, T0 + 220);
    }

    function test_WF3_Round1WordsInvalidWithoutExtension() public {
        // same round-1 words with NO extension granted in round 0 must be rejected
        _send(_enc(id, 0, _b3(50, 100, 80), _w3(150, 170, 160), _f3(true, false, false), _f3(false, false, false)));
        bytes memory r = _enc(id, 1, _b3(50, 100, 80), _w3(190, 210, 200), _f3(false, false, false), _f3(true, true, true));
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(AICourt.WordsOverBudget.selector, uint8(1), uint16(210), uint16(200)));
        court.onReport("", r);
    }
}
