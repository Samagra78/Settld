// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ClauseEscrow} from "../src/ClauseEscrow.sol";
import {ClauseEscrowDisputeBase} from "./ClauseEscrow.DisputeBase.t.sol";

/// @dev evidenceOf: stores/returns the exact submitted videoId and never leaks across clauses/deals.
contract ClauseEscrowEvidenceTest is ClauseEscrowDisputeBase {
    function _sub(uint256 id, uint8 c, string memory v) internal {
        vm.prank(creator);
        escrow.submitEvidence(id, c, v);
    }

    function _ev(uint256 id, uint8 c) internal view returns (string memory) {
        return escrow.evidenceOf(id, c);
    }

    function _longUnicode() internal pure returns (string memory) {
        bytes memory acc;
        for (uint256 i = 0; i < 100; i++) {
            acc = abi.encodePacked(acc, unicode"héllo 世界🎬-");
        }
        return string(acc);
    }

    // ------------------------------------------------------------- (1) exact + event

    function test_Evidence_ReturnsExactStringSubmitted() public {
        uint256 id = _funded(_mk(2));
        _sub(id, 0, "dQw4w9WgXcQ");
        assertEq(_ev(id, 0), "dQw4w9WgXcQ");
    }

    function test_Evidence_ClauseSubmittedStillEmittedWithVideoId() public {
        uint256 id = _funded(_mk(2));
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseSubmitted(id, 1, "abc-XYZ_123");
        _sub(id, 1, "abc-XYZ_123");
        assertEq(_ev(id, 1), "abc-XYZ_123");
        assertEq(_status(id, 1), SUBMITTED);
    }

    // ------------------------------------------------------------- (2) empty before submit

    function test_Evidence_EmptyBeforeSubmission() public {
        uint256 id = _funded(_mk(3));
        assertEq(_ev(id, 0), "");
        assertEq(_ev(id, 2), "");
    }

    function test_Evidence_EmptyOnUnfundedDeal() public {
        uint256 id = _propose(_mk(2));
        assertEq(_ev(id, 0), "");
        assertEq(_ev(id, 1), "");
    }

    function test_Evidence_EmptyForClausesNeverSubmitted() public {
        uint256 id = _funded(_mk(3));
        _sub(id, 1, "only-one");
        assertEq(_ev(id, 0), "");
        assertEq(_ev(id, 2), "");
        assertEq(_ev(id, 1), "only-one");
    }

    // ------------------------------------------------------------- (3) empty videoId

    function test_Evidence_EmptyVideoIdStoredAndReturnedEmpty() public {
        uint256 id = _funded(_mk(2));
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseSubmitted(id, 0, "");
        _sub(id, 0, "");
        assertEq(_ev(id, 0), "");
        assertEq(_status(id, 0), SUBMITTED);
    }

    function test_Evidence_EmptyVideoIdFlowStillVerifiesAndReleases() public {
        uint256 id = _funded(_mk(2));
        _sub(id, 0, "");
        _report(1, id, 0, bytes32(0));
        assertEq(_status(id, 0), VERIFIED);
        skip(WINDOW);
        uint256 before = _bal(creator);
        escrow.release(id, 0);
        assertEq(_status(id, 0), RELEASED);
        assertEq(_bal(creator) - before, 100e6);
        assertEq(_ev(id, 0), "");
    }

    function test_Evidence_EmptyVideoIdCannotBeResubmitted() public {
        uint256 id = _funded(_mk(1));
        _sub(id, 0, "");
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidClauseStatus.selector, SUBMITTED));
        escrow.submitEvidence(id, 0, "real");
        assertEq(_ev(id, 0), "");
    }

    // ------------------------------------------------------------- (4) unknown ids

    function test_Evidence_UnknownDealZeroReverts() public {
        _funded(_mk(1));
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.UnknownDeal.selector, 0));
        escrow.evidenceOf(0, 0);
    }

    function test_Evidence_UnknownDealTooLargeReverts() public {
        uint256 id = _funded(_mk(1));
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.UnknownDeal.selector, id + 1));
        escrow.evidenceOf(id + 1, 0);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.UnknownDeal.selector, type(uint256).max));
        escrow.evidenceOf(type(uint256).max, 0);
    }

    function test_Evidence_UnknownClauseReverts() public {
        uint256 id = _funded(_mk(2));
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.UnknownClause.selector, id, uint8(2)));
        escrow.evidenceOf(id, 2);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.UnknownClause.selector, id, uint8(255)));
        escrow.evidenceOf(id, 255);
    }

    function testFuzz_Evidence_UnknownClauseAlwaysReverts(uint8 c) public {
        uint256 id = _funded(_mk(2));
        c = uint8(bound(c, 2, 255));
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.UnknownClause.selector, id, c));
        escrow.evidenceOf(id, c);
    }

    // ------------------------------------------------------------- (5) isolation

    function test_Evidence_DoesNotLeakAcrossClauses() public {
        uint256 id = _funded(_mk(3));
        _sub(id, 0, "zero");
        assertEq(_ev(id, 0), "zero");
        assertEq(_ev(id, 1), "");
        assertEq(_ev(id, 2), "");
        _sub(id, 2, "two");
        assertEq(_ev(id, 0), "zero");
        assertEq(_ev(id, 1), "");
        assertEq(_ev(id, 2), "two");
    }

    function test_Evidence_DoesNotLeakAcrossDeals() public {
        uint256 a = _funded(_mk(2));
        uint256 b = _funded(_mk(2));
        _sub(a, 0, "deal-a");
        assertEq(_ev(a, 0), "deal-a");
        assertEq(_ev(b, 0), "");
        assertEq(_ev(b, 1), "");
        _sub(b, 0, "deal-b");
        assertEq(_ev(a, 0), "deal-a");
        assertEq(_ev(b, 0), "deal-b");
        assertEq(_ev(a, 1), "");
        assertEq(_ev(b, 1), "");
    }

    function testFuzz_Evidence_IsolationBetweenClauses(string calldata s0, string calldata s2) public {
        uint256 id = _funded(_mk(3));
        _sub(id, 0, s0);
        _sub(id, 2, s2);
        assertEq(_ev(id, 0), s0);
        assertEq(_ev(id, 1), "");
        assertEq(_ev(id, 2), s2);
    }

    // ------------------------------------------------------------- (6) long strings

    function test_Evidence_LongAsciiRoundTrips() public {
        uint256 id = _funded(_mk(1));
        string memory s = _str(1500);
        _sub(id, 0, s);
        assertEq(bytes(_ev(id, 0)).length, 1500);
        assertEq(_ev(id, 0), s);
    }

    function test_Evidence_LongUnicodeRoundTrips() public {
        uint256 id = _funded(_mk(1));
        string memory s = _longUnicode();
        assertGt(bytes(s).length, 1000);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseSubmitted(id, 0, s);
        _sub(id, 0, s);
        assertEq(_ev(id, 0), s);
    }

    function test_Evidence_Exactly31_32_33BytesRoundTrip() public {
        uint256 id = _funded(_mk(3));
        _sub(id, 0, _str(31));
        _sub(id, 1, _str(32));
        _sub(id, 2, _str(33));
        assertEq(_ev(id, 0), _str(31));
        assertEq(_ev(id, 1), _str(32));
        assertEq(_ev(id, 2), _str(33));
    }

    // ------------------------------------------------------------- (7) persistence

    function test_Evidence_PersistsAfterVerification() public {
        uint256 id = _funded(_mk(1));
        _sub(id, 0, "persist-v");
        _report(1, id, 0, bytes32(0));
        assertEq(_ev(id, 0), "persist-v");
    }

    function test_Evidence_PersistsAfterFailureReport() public {
        uint256 id = _funded(_mk(1));
        _sub(id, 0, "persist-f");
        _report(2, id, 0, bytes32(0));
        assertEq(_ev(id, 0), "persist-f");
    }

    function test_Evidence_PersistsAfterReleaseRefundDisputeResolve() public {
        uint256 id = _funded(_mk(3));
        _sub(id, 0, "e0");
        _sub(id, 1, "e1");
        _sub(id, 2, "e2");
        _report(1, id, 0, bytes32(0));
        _report(2, id, 1, bytes32(0));
        _report(1, id, 2, bytes32(0));
        assertEq(_ev(id, 0), "e0");
        assertEq(_ev(id, 1), "e1");
        assertEq(_ev(id, 2), "e2");

        // dispute c2 inside its window
        uint256 caseId = _dispute(brand, id, 2);
        assertEq(_status(id, 2), DISPUTED);
        assertEq(_ev(id, 2), "e2");

        // release c0, refund c1 after the window
        skip(WINDOW);
        escrow.release(id, 0);
        assertEq(_status(id, 0), RELEASED);
        assertEq(_ev(id, 0), "e0");
        escrow.refund(id, 1);
        assertEq(_status(id, 1), REFUNDED);
        assertEq(_ev(id, 1), "e1");

        // resolve c2
        _decide(caseId, 80);
        _resolve(id, 2);
        assertEq(_status(id, 2), RELEASED);
        assertEq(_ev(id, 0), "e0");
        assertEq(_ev(id, 1), "e1");
        assertEq(_ev(id, 2), "e2");
    }

    function test_Evidence_PersistsAfterStuckResolve() public {
        uint256 id = _funded(_mk(1));
        _sub(id, 0, "stuck-ev");
        _report(2, id, 0, bytes32(0));
        _dispute(creator, id, 0);
        skip(1 days);
        escrow.resolveStuckDispute(id, 0);
        assertEq(_status(id, 0), REFUNDED);
        assertEq(_ev(id, 0), "stuck-ev");
    }

    function test_Evidence_PersistsAfterExpire() public {
        uint256 id = _funded(_mk(1));
        _sub(id, 0, "will-expire");
        skip(1 days);
        escrow.expire(id, 0);
        assertEq(_status(id, 0), FAILED);
        assertEq(_ev(id, 0), "will-expire");
    }
}
