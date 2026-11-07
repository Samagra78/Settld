// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ClauseEscrow} from "../src/ClauseEscrow.sol";
import {ClauseEscrowDisputeBase} from "./ClauseEscrow.DisputeBase.t.sol";

/// @dev resolveStuckDispute: escape delay, default band, final-verdict guard, dependencies, isolation.
contract ClauseEscrowStuckTest is ClauseEscrowDisputeBase {
    uint256 internal constant ODD = 1_000_003;
    uint256 internal constant OTHER = 100e6;
    uint256 internal constant ESCAPE = 1 days;

    function _expectStatus(uint8 s) internal {
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidClauseStatus.selector, s));
    }

    /// @dev Two-clause deal; c0 (ODD) Verified and disputed. Returns id, case id and disputedAt.
    function _vDisputed() internal returns (uint256 id, uint256 caseId, uint256 at) {
        id = _two(ODD, OTHER, false);
        _verify(id, 0);
        caseId = _dispute(brand, id, 0);
        at = block.timestamp;
    }

    /// @dev Same but c0 Failed before dispute.
    function _fDisputed() internal returns (uint256 id, uint256 caseId, uint256 at) {
        id = _two(ODD, OTHER, false);
        _failReport(id, 0);
        caseId = _dispute(creator, id, 0);
        at = block.timestamp;
    }

    // ------------------------------------------------------------------ timing

    function test_Stuck_RevertsBeforeEscapeDelay() public {
        (uint256 id,, uint256 at) = _vDisputed();
        vm.expectRevert(ClauseEscrow.EscapeNotReached.selector);
        escrow.resolveStuckDispute(id, 0); // same block as dispute
        vm.warp(at + ESCAPE - 1);
        vm.expectRevert(ClauseEscrow.EscapeNotReached.selector);
        escrow.resolveStuckDispute(id, 0);
        assertEq(_status(id, 0), DISPUTED);
        assertEq(_bal(creator), 0);
    }

    function test_Stuck_WorksAtExactlyEscapeDelay() public {
        (uint256 id,, uint256 at) = _vDisputed();
        vm.warp(at + ESCAPE);
        escrow.resolveStuckDispute(id, 0);
        assertEq(_status(id, 0), RELEASED);
    }

    function test_Stuck_DelayMeasuredFromDisputeNotVerdict() public {
        uint256 id = _two(ODD, OTHER, false);
        _verify(id, 0);
        uint256 verdictAt = block.timestamp;
        skip(100); // still inside the 120s window
        _dispute(brand, id, 0);
        vm.warp(verdictAt + ESCAPE);
        vm.expectRevert(ClauseEscrow.EscapeNotReached.selector);
        escrow.resolveStuckDispute(id, 0);
        vm.warp(verdictAt + 100 + ESCAPE);
        escrow.resolveStuckDispute(id, 0);
        assertEq(_status(id, 0), RELEASED);
    }

    function testFuzz_Stuck_TimingGate(uint256 dt) public {
        dt = bound(dt, 0, 5 days);
        (uint256 id,, uint256 at) = _vDisputed();
        vm.warp(at + dt);
        if (dt < ESCAPE) vm.expectRevert(ClauseEscrow.EscapeNotReached.selector);
        escrow.resolveStuckDispute(id, 0);
        assertEq(_status(id, 0), dt < ESCAPE ? DISPUTED : RELEASED);
    }

    // ------------------------------------------------------------ default band

    function test_Stuck_VerifiedDisputeCreatorGetsEverything() public {
        (uint256 id,,) = _vDisputed();
        skip(ESCAPE);
        uint256 eBefore = _bal(address(escrow));
        uint256 bBefore = _bal(brand);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseSplit(id, 0, ODD, 0);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseResolved(id, 0, 10000, ODD, 0);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseSettled(id, 0, RELEASED, ODD);
        escrow.resolveStuckDispute(id, 0);
        assertEq(_status(id, 0), RELEASED);
        assertEq(_bal(creator), ODD);
        assertEq(_bal(brand), bBefore);
        assertEq(eBefore - _bal(address(escrow)), ODD);
    }

    function test_Stuck_FailedDisputeBrandGetsEverything() public {
        (uint256 id,,) = _fDisputed();
        skip(ESCAPE);
        uint256 bBefore = _bal(brand);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseSplit(id, 0, 0, ODD);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseResolved(id, 0, 0, 0, ODD);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseSettled(id, 0, REFUNDED, ODD);
        escrow.resolveStuckDispute(id, 0);
        assertEq(_status(id, 0), REFUNDED);
        assertEq(_bal(brand) - bBefore, ODD);
        assertEq(_bal(creator), 0);
    }

    function test_Stuck_ExpiredClauseDisputeDefaultsToBrand() public {
        uint256 id = _two(ODD, OTHER, false);
        vm.warp(block.timestamp + 8 days);
        escrow.expire(id, 0);
        _dispute(creator, id, 0);
        skip(ESCAPE);
        escrow.resolveStuckDispute(id, 0);
        assertEq(_status(id, 0), REFUNDED);
        assertEq(_bal(creator), 0);
    }

    function test_Stuck_IgnoresNonFinalCourtBand() public {
        (uint256 id, uint256 caseId,) = _vDisputed();
        court.setVerdict(caseId, false, 0); // not final: stored default (100) applies
        skip(ESCAPE);
        escrow.resolveStuckDispute(id, 0);
        assertEq(_bal(creator), ODD);
    }

    function test_Stuck_InvalidNonFinalBandIsIgnored() public {
        (uint256 id, uint256 caseId,) = _vDisputed();
        court.setVerdict(caseId, false, 30);
        skip(ESCAPE);
        escrow.resolveStuckDispute(id, 0);
        assertEq(_bal(creator), ODD);
    }

    // --------------------------------------------------- court verdict states

    function test_Stuck_BlockedWhenCourtVerdictFinalThenResolveDisputeWorks() public {
        (uint256 id, uint256 caseId,) = _vDisputed();
        _decide(caseId, 50);
        skip(ESCAPE);
        vm.expectRevert(ClauseEscrow.CaseAlreadyFinal.selector);
        escrow.resolveStuckDispute(id, 0);
        assertEq(_status(id, 0), DISPUTED);
        assertEq(_bal(creator), 0);
        escrow.resolveDispute(id, 0);
        assertEq(_bal(creator), 500_001);
        assertEq(_status(id, 0), RELEASED);
    }

    /// @dev CHANGED: a FINAL verdict with an unusable band no longer blocks the escape hatch.
    function test_Stuck_FinalVerdictWithInvalidBandLetsEscapeSettleDefault() public {
        (uint256 id, uint256 caseId,) = _vDisputed();
        _decide(caseId, 7);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidBand.selector, uint8(7)));
        escrow.resolveDispute(id, 0);
        skip(ESCAPE);
        escrow.resolveStuckDispute(id, 0);
        assertEq(_status(id, 0), RELEASED);
        assertEq(_bal(creator), ODD); // Verified default band 100
    }

    function test_Stuck_WorksWhenCourtFinalVerdictReverts() public {
        (uint256 id, uint256 caseId,) = _vDisputed();
        _decide(caseId, 0); // would be final, but court now reverts
        court.setRevertOnVerdict(true);
        vm.expectRevert(ClauseEscrow.CaseNotResolved.selector); // court revert = no usable verdict
        escrow.resolveDispute(id, 0);
        skip(ESCAPE);
        escrow.resolveStuckDispute(id, 0);
        assertEq(_status(id, 0), RELEASED);
        assertEq(_bal(creator), ODD);
    }

    function test_Stuck_WorksWhenCourtNeverSetVerdict() public {
        (uint256 id,,) = _vDisputed();
        (bool isFinal,) = court.finalVerdict(escrow.caseOf(id, 0));
        assertFalse(isFinal);
        skip(ESCAPE);
        escrow.resolveStuckDispute(id, 0);
        assertEq(_status(id, 0), RELEASED);
    }

    function test_Stuck_LateFinalVerdictCannotResettle() public {
        (uint256 id, uint256 caseId,) = _vDisputed();
        skip(ESCAPE);
        escrow.resolveStuckDispute(id, 0);
        uint256 c = _bal(creator);
        uint256 b = _bal(brand);
        uint256 e = _bal(address(escrow));
        _decide(caseId, 0); // court finally rules for the brand
        _expectStatus(RELEASED);
        escrow.resolveDispute(id, 0);
        assertEq(_bal(creator), c);
        assertEq(_bal(brand), b);
        assertEq(_bal(address(escrow)), e);
        assertEq(_status(id, 0), RELEASED);
    }

    function test_Stuck_CannotBeCalledTwice() public {
        (uint256 id,,) = _vDisputed();
        skip(ESCAPE);
        escrow.resolveStuckDispute(id, 0);
        uint256 c = _bal(creator);
        _expectStatus(RELEASED);
        escrow.resolveStuckDispute(id, 0);
        assertEq(_bal(creator), c);

        (uint256 id2,,) = _fDisputed();
        skip(ESCAPE);
        escrow.resolveStuckDispute(id2, 0);
        _expectStatus(REFUNDED);
        escrow.resolveStuckDispute(id2, 0);
    }

    // ------------------------------------------------------------ access / state

    function test_Stuck_AnyoneCanCall() public {
        (uint256 id,,) = _vDisputed();
        skip(ESCAPE);
        vm.prank(stranger);
        escrow.resolveStuckDispute(id, 0);
        assertEq(_status(id, 0), RELEASED);
        assertEq(_bal(stranger), 0);
        assertEq(_bal(creator), ODD);

        address[3] memory others = [forwarder, owner, address(0xBEEF)];
        for (uint256 i = 0; i < 3; i++) {
            (uint256 idN,,) = _fDisputed();
            skip(ESCAPE);
            vm.prank(others[i]);
            escrow.resolveStuckDispute(idN, 0);
            assertEq(_status(idN, 0), REFUNDED);
        }
    }

    function test_Stuck_RevertsOnNonDisputedStatuses() public {
        uint256 id = _two(ODD, OTHER, false);
        skip(ESCAPE);
        _expectStatus(PENDING);
        escrow.resolveStuckDispute(id, 0);
        _submit(id, 0);
        _expectStatus(SUBMITTED);
        escrow.resolveStuckDispute(id, 0);
        _report(1, id, 0, bytes32(0));
        _expectStatus(VERIFIED);
        escrow.resolveStuckDispute(id, 0);
        _failReport(id, 1);
        _expectStatus(FAILED);
        escrow.resolveStuckDispute(id, 1);
        skip(120);
        escrow.release(id, 0);
        _expectStatus(RELEASED);
        escrow.resolveStuckDispute(id, 0);
        escrow.refund(id, 1);
        _expectStatus(REFUNDED);
        escrow.resolveStuckDispute(id, 1);
    }

    function test_Stuck_RevertsOnUnfundedAndUnknown() public {
        uint256 id2 = _propose(_mk(1));
        vm.expectRevert(ClauseEscrow.NotFunded.selector);
        escrow.resolveStuckDispute(id2, 0);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.UnknownDeal.selector, uint256(99)));
        escrow.resolveStuckDispute(99, 0);
        uint256 id = _two(ODD, OTHER, false);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.UnknownClause.selector, id, uint8(7)));
        escrow.resolveStuckDispute(id, 7);
    }

    // ------------------------------------------------------------ dependencies

    /// @dev c1 (dep c0) Verified and disputed; c0 driven to `mode`:
    ///      0 Pending, 1 Submitted, 2 Verified, 3 Disputed, 4 Failed.
    function _unsettledDependency(uint8 mode) internal {
        uint256 id = _two(ODD, OTHER, true);
        _verify(id, 1);
        _dispute(brand, id, 1);
        if (mode == 1) _submit(id, 0);
        if (mode == 2) _verify(id, 0);
        if (mode == 3) {
            _verify(id, 0);
            _dispute(creator, id, 0);
        }
        if (mode == 4) _failReport(id, 0);
        skip(ESCAPE);
        vm.expectRevert(ClauseEscrow.DependencyNotSettled.selector);
        escrow.resolveStuckDispute(id, 1);
        assertEq(_status(id, 1), DISPUTED);
        assertEq(_bal(creator), 0);
    }

    function test_Stuck_DependencyPendingReverts() public { _unsettledDependency(0); }
    function test_Stuck_DependencySubmittedReverts() public { _unsettledDependency(1); }
    function test_Stuck_DependencyVerifiedReverts() public { _unsettledDependency(2); }
    function test_Stuck_DependencyDisputedReverts() public { _unsettledDependency(3); }
    function test_Stuck_DependencyFailedReverts() public { _unsettledDependency(4); }

    function test_Stuck_DependencyReleasedUsesDefaultBand() public {
        uint256 id = _two(ODD, OTHER, true);
        _verify(id, 0);
        _verify(id, 1);
        _dispute(brand, id, 1); // Verified -> default 100
        skip(ESCAPE);
        escrow.release(id, 0);
        assertEq(_status(id, 0), RELEASED);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseSplit(id, 1, OTHER, 0);
        escrow.resolveStuckDispute(id, 1);
        assertEq(_status(id, 1), RELEASED);
        assertEq(_bal(creator), ODD + OTHER);
        assertEq(_bal(address(escrow)), 0);
    }

    function test_Stuck_DependencyReleasedFailedDefaultStillBrand() public {
        uint256 id = _two(ODD, OTHER, true);
        _verify(id, 0);
        _failReport(id, 1);
        _dispute(creator, id, 1); // Failed -> default 0
        skip(ESCAPE);
        escrow.release(id, 0);
        escrow.resolveStuckDispute(id, 1);
        assertEq(_status(id, 1), REFUNDED);
        assertEq(_bal(creator), ODD);
    }

    function test_Stuck_DependencyRefundedForcesBandZeroEvenForVerifiedDefault() public {
        uint256 id = _two(ODD, OTHER, true);
        _failReport(id, 0);
        _verify(id, 1);
        _dispute(creator, id, 1); // Verified -> default 100
        skip(ESCAPE);
        escrow.refund(id, 0);
        assertEq(_status(id, 0), REFUNDED);
        uint256 bBefore = _bal(brand);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseSplit(id, 1, 0, OTHER);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseResolved(id, 1, 0, 0, OTHER);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseSettled(id, 1, REFUNDED, OTHER);
        escrow.resolveStuckDispute(id, 1);
        assertEq(_status(id, 1), REFUNDED);
        assertEq(_bal(brand) - bBefore, OTHER);
        assertEq(_bal(creator), 0);
        assertEq(_bal(address(escrow)), 0);
    }

    function test_Stuck_DisputedDependencySettledUnblocksDependent() public {
        uint256 id = _two(ODD, OTHER, true);
        _verify(id, 0);
        _verify(id, 1);
        _dispute(creator, id, 0);
        _dispute(brand, id, 1);
        skip(ESCAPE);
        vm.expectRevert(ClauseEscrow.DependencyNotSettled.selector);
        escrow.resolveStuckDispute(id, 1);
        escrow.resolveStuckDispute(id, 0);
        escrow.resolveStuckDispute(id, 1);
        assertEq(_bal(creator), ODD + OTHER);
        assertEq(_bal(address(escrow)), 0);
    }

    // --------------------------------------------------------------- isolation

    function test_Stuck_OtherClausesUnaffected() public {
        uint256 id = _funded(_mk(3)); // 100e6, 200e6, 300e6 independent
        _verify(id, 0);
        _verify(id, 1);
        _failReport(id, 2);
        _dispute(brand, id, 0);
        _dispute(creator, id, 2);
        skip(ESCAPE);
        escrow.resolveStuckDispute(id, 0);
        assertEq(_status(id, 0), RELEASED);
        assertEq(_status(id, 1), VERIFIED);
        assertEq(_status(id, 2), DISPUTED);
        assertEq(_bal(creator), 100e6);
        assertEq(_bal(address(escrow)), 500e6);
        // unaffected clause settles normally; disputed one still pending a court/escape path
        escrow.release(id, 1);
        assertEq(_bal(creator), 300e6);
        escrow.resolveStuckDispute(id, 2);
        assertEq(_status(id, 2), REFUNDED);
        assertEq(_bal(address(escrow)), 0);
    }

    // -------------------------------------------------------------- fuzz

    function testFuzz_Stuck_ConservesAmount(uint256 amountSeed, bool verified) public {
        uint256 amount = bound(amountSeed, 1, 100_000e6);
        uint256 id = _two(amount, OTHER, false);
        if (verified) _verify(id, 0);
        else _failReport(id, 0);
        _dispute(brand, id, 0);
        skip(ESCAPE);
        uint256 cBefore = _bal(creator);
        uint256 bBefore = _bal(brand);
        escrow.resolveStuckDispute(id, 0);
        assertEq(_bal(creator) - cBefore, verified ? amount : 0);
        assertEq(_bal(brand) - bBefore, verified ? 0 : amount);
        assertEq(_bal(address(escrow)), OTHER);
    }
}
