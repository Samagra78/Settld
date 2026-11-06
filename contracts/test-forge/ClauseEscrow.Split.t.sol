// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ClauseEscrow} from "../src/ClauseEscrow.sol";
import {MockAICourt} from "../test-helpers/MockAICourt.sol";
import {ClauseEscrowDisputeBase} from "./ClauseEscrow.DisputeBase.t.sol";

/// @dev ClauseSplit event, band splits, invalid bands, caseOf, zero case id, setCourt code check.
contract ClauseEscrowSplitTest is ClauseEscrowDisputeBase {
    uint256 internal constant ODD = 1_000_003;
    uint256 internal constant OTHER = 100e6;

    function _verifiedDisputed(uint256 amount) internal returns (uint256 id, uint256 caseId) {
        id = _two(amount, OTHER, false);
        _verify(id, 0);
        caseId = _dispute(brand, id, 0);
    }

    function _count(Vm.Log[] memory logs, bytes32 sig) internal pure returns (uint256 n) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == sig) n++;
        }
    }

    // ------------------------------------------------------------ ClauseSplit

    function test_Split_EmittedOnResolveDisputeWithExactFields() public {
        (uint256 id, uint256 caseId) = _verifiedDisputed(ODD);
        _decide(caseId, 80);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseSplit(id, 0, 800_002, 200_001);
        escrow.resolveDispute(id, 0);
    }

    function test_Split_EmittedOnResolveStuckDisputeWithExactFields() public {
        (uint256 id,) = _verifiedDisputed(ODD);
        skip(1 days);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseSplit(id, 0, ODD, 0);
        escrow.resolveStuckDispute(id, 0);
    }

    function test_Split_ClauseSplitIndexesDealId() public {
        (uint256 id, uint256 caseId) = _verifiedDisputed(ODD);
        _decide(caseId, 50);
        vm.recordLogs();
        escrow.resolveDispute(id, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == ClauseEscrow.ClauseSplit.selector) {
                assertEq(logs[i].topics.length, 2);
                assertEq(uint256(logs[i].topics[1]), id);
                assertEq(logs[i].emitter, address(escrow));
            }
        }
    }

    function test_Split_ExactlyOneOfEachEventPerResolve() public {
        (uint256 id, uint256 caseId) = _verifiedDisputed(ODD);
        _decide(caseId, 50);
        vm.recordLogs();
        escrow.resolveDispute(id, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_count(logs, ClauseEscrow.ClauseSplit.selector), 1);
        assertEq(_count(logs, ClauseEscrow.ClauseResolved.selector), 1);
        assertEq(_count(logs, ClauseEscrow.ClauseSettled.selector), 1);

        (uint256 id2,) = _verifiedDisputed(ODD);
        skip(1 days);
        vm.recordLogs();
        escrow.resolveStuckDispute(id2, 0);
        logs = vm.getRecordedLogs();
        assertEq(_count(logs, ClauseEscrow.ClauseSplit.selector), 1);
        assertEq(_count(logs, ClauseEscrow.ClauseResolved.selector), 1);
        assertEq(_count(logs, ClauseEscrow.ClauseSettled.selector), 1);
    }

    function test_Split_ForcedBrandRefundEmitsZeroToFreelancer() public {
        uint256 id = _two(ODD, OTHER, true);
        _failReport(id, 0);
        _verify(id, 1);
        _decide(_dispute(creator, id, 1), 100);
        skip(120);
        escrow.refund(id, 0);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseSplit(id, 1, 0, OTHER);
        escrow.resolveDispute(id, 1);
    }

    // ------------------------------------------------------- band splits (odd)

    function _bandSplit(uint8 band, uint256 expFreelancer, uint256 expClient) internal {
        (uint256 id, uint256 caseId) = _verifiedDisputed(ODD);
        _decide(caseId, band);
        uint256 cBefore = _bal(creator);
        uint256 bBefore = _bal(brand);
        uint256 eBefore = _bal(address(escrow));
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseSplit(id, 0, expFreelancer, expClient);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseResolved(id, 0, uint16(band) * 100, expFreelancer, expClient);
        escrow.resolveDispute(id, 0);
        assertEq(expFreelancer + expClient, ODD, "no dust");
        assertEq(_bal(creator) - cBefore, expFreelancer);
        assertEq(_bal(brand) - bBefore, expClient);
        assertEq(eBefore - _bal(address(escrow)), ODD, "conservation");
        assertEq(_status(id, 0), expFreelancer > 0 ? RELEASED : REFUNDED);
    }

    function test_Bands_0_OddAmount() public { _bandSplit(0, 0, 1_000_003); }
    function test_Bands_50_OddAmount() public { _bandSplit(50, 500_001, 500_002); }
    function test_Bands_80_OddAmount() public { _bandSplit(80, 800_002, 200_001); }
    function test_Bands_100_OddAmount() public { _bandSplit(100, 1_000_003, 0); }

    // ---------------------------------------------------------- invalid bands

    function _badBand(uint8 band) internal {
        (uint256 id, uint256 caseId) = _verifiedDisputed(ODD);
        _decide(caseId, band);
        uint256 eBefore = _bal(address(escrow));
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidBand.selector, band));
        escrow.resolveDispute(id, 0);
        assertEq(_status(id, 0), DISPUTED);
        assertEq(_bal(address(escrow)), eBefore);
    }

    function test_InvalidBand_1() public { _badBand(1); }
    function test_InvalidBand_30() public { _badBand(30); }
    function test_InvalidBand_101() public { _badBand(101); }
    function test_InvalidBand_255() public { _badBand(255); }

    function testFuzz_InvalidBand_AnyOtherValueReverts(uint8 band) public {
        vm.assume(band != 0 && band != 50 && band != 80 && band != 100);
        _badBand(band);
    }

    function test_InvalidBand_NonFinalInvalidBandIsCaseNotResolved() public {
        (uint256 id, uint256 caseId) = _verifiedDisputed(ODD);
        court.setVerdict(caseId, false, 30);
        vm.expectRevert(ClauseEscrow.CaseNotResolved.selector);
        escrow.resolveDispute(id, 0);
    }

    // ---------------------------------------------------------------- caseOf

    function test_CaseOf_ReturnsStoredIdPerClause() public {
        uint256 id = _two(ODD, OTHER, false);
        _verify(id, 0);
        _verify(id, 1);
        assertEq(escrow.caseOf(id, 0), 0);
        assertEq(_dispute(brand, id, 1), 1);
        assertEq(_dispute(creator, id, 0), 2);
        assertEq(escrow.caseOf(id, 1), 1);
        assertEq(escrow.caseOf(id, 0), 2);
    }

    function test_CaseOf_UnknownDealAndClauseRevert() public {
        uint256 id = _two(ODD, OTHER, false);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.UnknownDeal.selector, uint256(42)));
        escrow.caseOf(42, 0);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.UnknownClause.selector, id, uint8(9)));
        escrow.caseOf(id, 9);
    }

    // ----------------------------------------------------- zero court case id

    function test_Dispute_ZeroCaseIdRevertsAndLeavesClauseUndisputed() public {
        uint256 id = _two(ODD, OTHER, false);
        _verify(id, 0);
        court.setReturnZeroCaseId(true);
        uint256 eBefore = _bal(address(escrow));
        vm.prank(brand);
        vm.expectRevert(ClauseEscrow.InvalidCaseId.selector);
        escrow.dispute(id, 0, "x");
        assertEq(_status(id, 0), VERIFIED);
        assertEq(escrow.caseOf(id, 0), 0);
        assertEq(court.caseCount(), 0);
        assertEq(_bal(address(escrow)), eBefore);
        // fully reverted: not a Disputed clause, so the escape path is unavailable
        skip(1 days);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidClauseStatus.selector, VERIFIED));
        escrow.resolveStuckDispute(id, 0);
    }

    function test_Dispute_ZeroCaseIdOnFailedClauseLeavesFailed() public {
        uint256 id = _two(ODD, OTHER, false);
        _failReport(id, 0);
        court.setReturnZeroCaseId(true);
        vm.prank(creator);
        vm.expectRevert(ClauseEscrow.InvalidCaseId.selector);
        escrow.dispute(id, 0, "x");
        assertEq(_status(id, 0), FAILED);
        // clause still refundable normally after its window
        skip(120);
        escrow.refund(id, 0);
        assertEq(_status(id, 0), REFUNDED);
    }

    function test_Dispute_AfterZeroCaseIdCanRetryWhenCourtRecovers() public {
        uint256 id = _two(ODD, OTHER, false);
        _verify(id, 0);
        court.setReturnZeroCaseId(true);
        vm.prank(brand);
        vm.expectRevert(ClauseEscrow.InvalidCaseId.selector);
        escrow.dispute(id, 0, "x");
        court.setReturnZeroCaseId(false);
        assertEq(_dispute(brand, id, 0), 1);
        assertEq(_status(id, 0), DISPUTED);
    }

    // ------------------------------------------------------------- setCourt

    function test_SetCourt_EoaReverts() public {
        _freshEscrowNoCourt();
        vm.prank(owner);
        vm.expectRevert(ClauseEscrow.CourtNotContract.selector);
        escrow.setCourt(makeAddr("eoa"));
        assertEq(address(escrow.court()), address(0));
        // failed attempt does not consume the one-shot
        vm.prank(owner);
        escrow.setCourt(address(court));
        assertEq(address(escrow.court()), address(court));
    }

    function test_SetCourt_ZeroStillZeroCourt() public {
        _freshEscrowNoCourt();
        vm.prank(owner);
        vm.expectRevert(ClauseEscrow.ZeroCourt.selector);
        escrow.setCourt(address(0));
    }

    function test_SetCourt_ContractSucceedsAndEmits() public {
        _freshEscrowNoCourt();
        MockAICourt other = new MockAICourt();
        vm.expectEmit(true, false, false, false, address(escrow));
        emit ClauseEscrow.CourtSet(address(other));
        vm.prank(owner);
        escrow.setCourt(address(other));
        assertEq(address(escrow.court()), address(other));
    }

    function test_SetCourt_OnceOnlyStillEnforcedBeforeCodeCheck() public {
        // fixture escrow already has a court
        MockAICourt other = new MockAICourt();
        vm.startPrank(owner);
        vm.expectRevert(ClauseEscrow.CourtAlreadySet.selector);
        escrow.setCourt(address(other));
        vm.expectRevert(ClauseEscrow.CourtAlreadySet.selector);
        escrow.setCourt(makeAddr("eoa"));
        vm.stopPrank();
        assertEq(address(escrow.court()), address(court));
    }

    function test_SetCourt_NonOwnerEoaRevertsOwnableFirst() public {
        _freshEscrowNoCourt();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.setCourt(makeAddr("eoa"));
    }
}
