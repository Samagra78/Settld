// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AICourtTestBase} from "./AICourt.Base.t.sol";
import {AICourt} from "../src/AICourt.sol";

/// @dev closeCase and the AI band rules.
contract AICourtCloseTest is AICourtTestBase {
    uint256 internal id;

    function setUp() public override {
        super.setUp();
        id = _open();
    }

    function _expected(uint8 a, uint8 b, uint8 c) internal pure returns (uint8) {
        if (a == b || a == c) return a;
        if (b == c) return b;
        // all different: the middle value
        if ((a > b && a < c) || (a < b && a > c)) return a;
        if ((b > a && b < c) || (b < a && b > c)) return b;
        return c;
    }

    // ------------------------------------------------------------ revert paths

    function test_Close_RevertsUnknownCase() public {
        vm.expectRevert(abi.encodeWithSelector(AICourt.UnknownCase.selector, uint256(0)));
        court.closeCase(0);
        vm.expectRevert(abi.encodeWithSelector(AICourt.UnknownCase.selector, uint256(2)));
        court.closeCase(2);
    }

    function test_Close_NoRoundReportedRevertsBeforeAndAfterDeadline() public {
        vm.expectRevert(AICourt.NoRoundReported.selector);
        court.closeCase(id);
        vm.warp(_deadline(id) + 1);
        vm.expectRevert(AICourt.NoRoundReported.selector);
        court.closeCase(id);
        vm.warp(_deadline(id) + 10 days);
        vm.expectRevert(AICourt.NoRoundReported.selector);
        court.closeCase(id);
        assertFalse(court.getCase(id).aiSet);
    }

    function test_Close_CannotCloseBeforeDeadline() public {
        _round(id, 0, _b3(50, 50, 50));
        vm.expectRevert(AICourt.CannotCloseYet.selector);
        court.closeCase(id);
    }

    function test_Close_CannotCloseAtExactDeadline() public {
        _round(id, 0, _b3(50, 50, 50));
        vm.warp(_deadline(id));
        vm.expectRevert(AICourt.CannotCloseYet.selector);
        court.closeCase(id);
    }

    function test_Close_TwoFinalOfThreeIsNotEnough() public {
        _send(_enc(id, 0, _b3(50, 50, 50), _w3(1, 1, 1), _f3(false, false, false), _f3(true, true, false)));
        vm.expectRevert(AICourt.CannotCloseYet.selector);
        court.closeCase(id);
    }

    function test_Close_FinalityIsFromLatestReport() public {
        _roundFinal(id, 0, _b3(50, 50, 50));
        // round 1 un-finalizes everyone
        _round(id, 1, _b3(50, 50, 50));
        vm.expectRevert(AICourt.CannotCloseYet.selector);
        court.closeCase(id);
    }

    function test_Close_AllFinalClosesBeforeDeadline() public {
        _roundFinal(id, 0, _b3(100, 100, 100));
        assertLt(block.timestamp, _deadline(id));
        court.closeCase(id);
        AICourt.Case memory c = court.getCase(id);
        assertTrue(c.aiSet);
        assertEq(c.aiBand, 100);
    }

    function test_Close_WorksAfterDeadlineByAnyone() public {
        _round(id, 0, _b3(0, 0, 50));
        vm.warp(_deadline(id) + 1);
        vm.prank(stranger);
        court.closeCase(id);
        assertTrue(court.getCase(id).aiSet);
        assertEq(court.getCase(id).aiBand, 0);
    }

    function test_Close_AlreadyClosedOnRepeat() public {
        _roundFinal(id, 0, _b3(50, 50, 50));
        court.closeCase(id);
        vm.expectRevert(AICourt.AlreadyClosed.selector);
        court.closeCase(id);
        vm.warp(block.timestamp + 1 days);
        vm.expectRevert(AICourt.AlreadyClosed.selector);
        court.closeCase(id);
    }

    function test_Close_ReportsAfterClosingRevert() public {
        _roundFinal(id, 0, _b3(50, 50, 50));
        court.closeCase(id);
        bytes memory r = _enc(id, 1, _b3(50, 50, 50), _w3(1, 1, 1), _f3(false, false, false), _f3(false, false, false));
        vm.prank(forwarder);
        vm.expectRevert(AICourt.AiVerdictAlreadySet.selector);
        court.onReport("", r);
        // also with the wrong round number: the closed check comes first
        r = _enc(id, 0, _b3(50, 50, 50), _w3(1, 1, 1), _f3(false, false, false), _f3(false, false, false));
        vm.prank(forwarder);
        vm.expectRevert(AICourt.AiVerdictAlreadySet.selector);
        court.onReport("", r);
    }

    // ------------------------------------------------------------ AI band

    function test_Close_EmitsAIVerdictWithAppealDeadline() public {
        _round(id, 0, _b3(50, 80, 80));
        vm.warp(_deadline(id) + 7);
        vm.expectEmit(true, false, false, true, address(court));
        emit AICourt.AIVerdict(id, 80, uint64(block.timestamp + 120));
        court.closeCase(id);
        AICourt.Case memory c = court.getCase(id);
        assertEq(c.appealDeadline, block.timestamp + 120);
        assertFalse(c.finalized);
        assertFalse(c.appealed);
    }

    function test_Close_ExplicitBandCases() public {
        assertEq(court.getCase(_closedWith(_b3(0, 50, 100))).aiBand, 50);
        assertEq(court.getCase(_closedWith(_b3(100, 0, 0))).aiBand, 0);
        assertEq(court.getCase(_closedWith(_b3(0, 100, 100))).aiBand, 100);
        assertEq(court.getCase(_closedWith(_b3(80, 50, 80))).aiBand, 80);
        assertEq(court.getCase(_closedWith(_b3(50, 50, 50))).aiBand, 50);
        assertEq(court.getCase(_closedWith(_b3(100, 50, 0))).aiBand, 50);
        assertEq(court.getCase(_closedWith(_b3(50, 100, 80))).aiBand, 80);
        assertEq(court.getCase(_closedWith(_b3(100, 80, 0))).aiBand, 80);
    }

    function test_Close_AllPermutationsOfBands() public {
        uint8[4] memory vals = [0, 50, 80, 100];
        for (uint256 i = 0; i < 4; ++i) {
            for (uint256 j = 0; j < 4; ++j) {
                for (uint256 k = 0; k < 4; ++k) {
                    uint256 cid = _closedWith(_b3(vals[i], vals[j], vals[k]));
                    assertEq(court.getCase(cid).aiBand, _expected(vals[i], vals[j], vals[k]));
                }
            }
        }
    }

    function test_Close_UsesLatestRoundBandsNotFirst() public {
        _round(id, 0, _b3(0, 0, 0));
        _round(id, 1, _b3(100, 100, 50));
        vm.warp(_deadline(id) + 1);
        court.closeCase(id);
        assertEq(court.getCase(id).aiBand, 100);
    }

    function test_Close_DoesNotTouchOtherCases() public {
        uint256 other = _open();
        _roundFinal(id, 0, _b3(50, 50, 50));
        court.closeCase(id);
        assertFalse(court.getCase(other).aiSet);
        vm.expectRevert(AICourt.NoRoundReported.selector);
        court.closeCase(other);
    }
}
