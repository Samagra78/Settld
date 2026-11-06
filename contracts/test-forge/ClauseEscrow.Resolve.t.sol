// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ClauseEscrow} from "../src/ClauseEscrow.sol";
import {ClauseEscrowDisputeBase} from "./ClauseEscrow.DisputeBase.t.sol";

/// @dev resolveDispute: guards, exact splits, conservation, dependency rule, isolation.
contract ClauseEscrowResolveTest is ClauseEscrowDisputeBase {
    uint256 internal constant ODD = 1_000_003;
    uint256 internal constant OTHER = 100e6;

    function _expectStatus(uint8 s) internal {
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidClauseStatus.selector, s));
    }

    /// @dev Verified c0 of `amount` disputed by brand and decided with `band`. Returns deal id.
    function _disputed(uint256 amount, uint8 band) internal returns (uint256 id) {
        id = _two(amount, OTHER, false);
        _verify(id, 0);
        _decide(_dispute(brand, id, 0), band);
    }

    function _checkSplit(uint256 amount, uint8 band) internal {
        uint256 id = _disputed(amount, band);
        uint256 ca = amount * band / 100;
        uint256 ba = amount - ca;
        uint8 outcome = ca > 0 ? RELEASED : REFUNDED;
        uint256 cBefore = _bal(creator);
        uint256 bBefore = _bal(brand);
        uint256 eBefore = _bal(address(escrow));

        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseSplit(id, 0, ca, ba);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseResolved(id, 0, uint16(band) * 100, ca, ba);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseSettled(id, 0, outcome, ca > 0 ? ca : ba);
        vm.prank(stranger); // permissionless
        escrow.resolveDispute(id, 0);

        assertEq(_bal(creator) - cBefore, ca, "creator payout");
        assertEq(_bal(brand) - bBefore, ba, "brand payout");
        assertEq(_bal(stranger), 0);
        assertEq(eBefore - _bal(address(escrow)), amount, "escrow drained by exactly the clause");
        assertEq(_bal(address(escrow)), amount + OTHER - amount, "escrow == total - settled");
        assertEq(ca + ba, amount, "no dust");
        assertEq(_status(id, 0), outcome);
    }

    // ----------------------------------------------------------------- guards

    function test_Resolve_RevertsWhileCaseUnresolved() public {
        uint256 id = _two(ODD, OTHER, false);
        _verify(id, 0);
        uint256 caseId = _dispute(brand, id, 0);
        vm.expectRevert(ClauseEscrow.CaseNotResolved.selector);
        escrow.resolveDispute(id, 0);
        court.setVerdict(caseId, false, 50); // band set but not final
        vm.expectRevert(ClauseEscrow.CaseNotResolved.selector);
        escrow.resolveDispute(id, 0);
        assertEq(_status(id, 0), DISPUTED);
        _decide(caseId, 50);
        escrow.resolveDispute(id, 0);
        assertEq(_status(id, 0), RELEASED);
    }

    function test_Resolve_RevertsOnNonDisputedStatuses() public {
        uint256 id = _two(ODD, OTHER, false);
        _expectStatus(PENDING);
        escrow.resolveDispute(id, 0);
        _submit(id, 0);
        _expectStatus(SUBMITTED);
        escrow.resolveDispute(id, 0);
        _report(1, id, 0, bytes32(0));
        _expectStatus(VERIFIED);
        escrow.resolveDispute(id, 0);
        _failReport(id, 1);
        _expectStatus(FAILED);
        escrow.resolveDispute(id, 1);
        skip(120);
        escrow.release(id, 0);
        _expectStatus(RELEASED);
        escrow.resolveDispute(id, 0);
        escrow.refund(id, 1);
        _expectStatus(REFUNDED);
        escrow.resolveDispute(id, 1);
    }

    function test_Resolve_RevertsOnUnfundedAndUnknown() public {
        uint256 id2 = _propose(_mk(1));
        vm.expectRevert(ClauseEscrow.NotFunded.selector);
        escrow.resolveDispute(id2, 0);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.UnknownDeal.selector, uint256(99)));
        escrow.resolveDispute(99, 0);
        uint256 id = _two(ODD, OTHER, false);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.UnknownClause.selector, id, uint8(7)));
        escrow.resolveDispute(id, 7);
    }

    function test_Resolve_InvalidBandReverts() public {
        uint8[6] memory bad = [uint8(1), 30, 49, 101, 200, 255];
        for (uint256 i = 0; i < bad.length; i++) {
            uint256 id = _disputed(ODD, bad[i]);
            vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidBand.selector, bad[i]));
            escrow.resolveDispute(id, 0);
            assertEq(_status(id, 0), DISPUTED);
        }
    }

    function test_Resolve_SecondResolveReverts() public {
        uint256 id = _disputed(ODD, 50);
        escrow.resolveDispute(id, 0);
        uint256 c = _bal(creator);
        uint256 b = _bal(brand);
        _expectStatus(RELEASED);
        escrow.resolveDispute(id, 0);
        assertEq(_bal(creator), c);
        assertEq(_bal(brand), b);
        // also after a full-refund outcome
        uint256 id2 = _disputed(ODD, 0);
        escrow.resolveDispute(id2, 0);
        _expectStatus(REFUNDED);
        escrow.resolveDispute(id2, 0);
    }

    function test_Resolve_ReleaseAndRefundBlockedAfterResolution() public {
        uint256 id = _disputed(ODD, 50);
        escrow.resolveDispute(id, 0);
        skip(1 days);
        _expectStatus(RELEASED);
        escrow.release(id, 0);
        vm.expectRevert(ClauseEscrow.RefundNotAllowed.selector);
        escrow.refund(id, 0);
    }

    // ----------------------------------------------------------------- splits

    function test_Resolve_Split0() public { _checkSplit(ODD, 0); }
    function test_Resolve_Split50() public { _checkSplit(ODD, 50); }
    function test_Resolve_Split80() public { _checkSplit(ODD, 80); }
    function test_Resolve_Split100() public { _checkSplit(ODD, 100); }

    function test_Resolve_OddAmountBrandGetsRemainder() public {
        uint256 id = _disputed(ODD, 80);
        escrow.resolveDispute(id, 0);
        assertEq(_bal(creator), 800_002); // floor(1_000_003 * 0.8)
        assertEq(_bal(brand), BRAND_START - (ODD + OTHER) + 200_001);
    }

    function test_Resolve_TinyAmountRoundsCreatorToZeroIsRefunded() public {
        uint256 id = _two(1, OTHER, false);
        _verify(id, 0);
        _decide(_dispute(creator, id, 0), 50);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseSplit(id, 0, 0, 1);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseResolved(id, 0, 5000, 0, 1);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseSettled(id, 0, REFUNDED, 1);
        escrow.resolveDispute(id, 0);
        assertEq(_status(id, 0), REFUNDED);
        assertEq(_bal(creator), 0);
    }

    function test_Resolve_FailedClauseCanPayCreator() public {
        uint256 id = _two(ODD, OTHER, false);
        _failReport(id, 0);
        _decide(_dispute(creator, id, 0), 100);
        escrow.resolveDispute(id, 0);
        assertEq(_status(id, 0), RELEASED);
        assertEq(_bal(creator), ODD);
    }

    function test_Resolve_CourtResultIgnoresDefaultBandAndDisputer() public {
        uint256 id = _two(ODD, OTHER, false);
        _verify(id, 0);
        _decide(_dispute(creator, id, 0), 0); // verified (band 100) but court rules for brand
        escrow.resolveDispute(id, 0);
        assertEq(_status(id, 0), REFUNDED);
        assertEq(_bal(creator), 0);
    }

    function testFuzz_Resolve_ConservesAndPaysOnce(uint256 amountSeed, uint256 bandSeed) public {
        uint256 amount = bound(amountSeed, 1, 100_000e6);
        uint8[4] memory bands = [uint8(0), 50, 80, 100];
        uint8 band = bands[bound(bandSeed, 0, 3)];
        uint256 id = _disputed(amount, band);
        uint256 total = amount + OTHER;
        uint256 ca = amount * band / 100;
        uint256 cBefore = _bal(creator);
        uint256 bBefore = _bal(brand);

        escrow.resolveDispute(id, 0);

        assertEq(_bal(creator) - cBefore, ca);
        assertEq(_bal(brand) - bBefore, amount - ca);
        assertEq(_bal(address(escrow)), total - amount);
        assertEq(_status(id, 0), ca > 0 ? RELEASED : REFUNDED);
        // single payout
        vm.expectRevert();
        escrow.resolveDispute(id, 0);
        assertEq(_bal(creator) - cBefore, ca);
        assertEq(_bal(brand) - bBefore, amount - ca);
    }

    // ------------------------------------------------------------ dependencies

    /// @dev c1 (dep c0) disputed + decided 10000 while c0 is put into `mode` state:
    ///      0 Pending, 1 Submitted, 2 Verified, 3 Disputed, 4 Failed.
    function _unsettledDependency(uint8 mode) internal {
        uint256 id = _two(ODD, OTHER, true);
        _verify(id, 1);
        _decide(_dispute(brand, id, 1), 100);
        if (mode == 1) _submit(id, 0);
        if (mode == 2) _verify(id, 0);
        if (mode == 3) {
            _verify(id, 0);
            _decide(_dispute(creator, id, 0), 100);
        }
        if (mode == 4) _failReport(id, 0);
        vm.expectRevert(ClauseEscrow.DependencyNotSettled.selector);
        escrow.resolveDispute(id, 1);
        assertEq(_status(id, 1), DISPUTED);
        assertEq(_bal(creator), 0);
    }

    function test_Resolve_DependencyPendingReverts() public { _unsettledDependency(0); }
    function test_Resolve_DependencySubmittedReverts() public { _unsettledDependency(1); }
    function test_Resolve_DependencyVerifiedReverts() public { _unsettledDependency(2); }
    function test_Resolve_DependencyDisputedReverts() public { _unsettledDependency(3); }
    function test_Resolve_DependencyFailedReverts() public { _unsettledDependency(4); }

    function test_Resolve_DependencyReleasedUsesCourtBps() public {
        uint256 id = _two(ODD, OTHER, true);
        _verify(id, 0);
        _verify(id, 1);
        _decide(_dispute(brand, id, 1), 80);
        skip(120);
        escrow.release(id, 0);
        assertEq(_status(id, 0), RELEASED);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseResolved(id, 1, 8000, OTHER * 80 / 100, OTHER - OTHER * 80 / 100);
        escrow.resolveDispute(id, 1);
        assertEq(_bal(creator), ODD + OTHER * 80 / 100);
        assertEq(_status(id, 1), RELEASED);
    }

    function test_Resolve_DependencyRefundedForcesFullBrandRefund() public {
        uint256 id = _two(ODD, OTHER, true);
        _failReport(id, 0);
        _verify(id, 1);
        _decide(_dispute(creator, id, 1), 100); // court says pay creator in full
        skip(120);
        escrow.refund(id, 0);
        assertEq(_status(id, 0), REFUNDED);
        uint256 bBefore = _bal(brand);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseResolved(id, 1, 0, 0, OTHER);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseSettled(id, 1, REFUNDED, OTHER);
        escrow.resolveDispute(id, 1);
        assertEq(_status(id, 1), REFUNDED);
        assertEq(_bal(brand) - bBefore, OTHER);
        assertEq(_bal(creator), 0);
        assertEq(_bal(address(escrow)), 0);
    }

    function test_Resolve_DisputedDependencyThenSettledUnblocksDependent() public {
        uint256 id = _two(ODD, OTHER, true);
        _verify(id, 0);
        _verify(id, 1);
        uint256 c0 = _dispute(creator, id, 0);
        uint256 c1 = _dispute(brand, id, 1);
        _decide(c0, 100);
        _decide(c1, 100);
        vm.expectRevert(ClauseEscrow.DependencyNotSettled.selector);
        escrow.resolveDispute(id, 1);
        escrow.resolveDispute(id, 0); // Released
        escrow.resolveDispute(id, 1);
        assertEq(_bal(creator), ODD + OTHER);
        assertEq(_bal(address(escrow)), 0);
    }

    function test_Resolve_DependencyResolvedToRefundForcesBrandRefund() public {
        uint256 id = _two(ODD, OTHER, true);
        _verify(id, 0);
        _verify(id, 1);
        uint256 c0 = _dispute(creator, id, 0);
        uint256 c1 = _dispute(brand, id, 1);
        _decide(c0, 0); // dependency fully refunded by court
        _decide(c1, 100);
        escrow.resolveDispute(id, 0);
        assertEq(_status(id, 0), REFUNDED);
        escrow.resolveDispute(id, 1);
        assertEq(_status(id, 1), REFUNDED);
        assertEq(_bal(creator), 0);
        assertEq(_bal(brand), BRAND_START);
    }

    function test_Cascade_StillWorksForNonDisputedDependents() public {
        ClauseEscrow.ClauseTerms[] memory t = _mk(3);
        t[1].dependsOn = 0;
        uint256 id = _funded(t); // c0=100, c1=200 (dep c0), c2=300 independent
        _failReport(id, 0);
        _verify(id, 2);
        _decide(_dispute(creator, id, 2), 100);
        skip(120);
        escrow.refund(id, 0);
        escrow.refund(id, 1); // cascade, non-disputed
        assertEq(_status(id, 1), REFUNDED);
        assertEq(_status(id, 2), DISPUTED);
        assertEq(_bal(address(escrow)), 300e6);
        escrow.resolveDispute(id, 2);
        assertEq(_bal(creator), 300e6);
        assertEq(_bal(address(escrow)), 0);
    }

    // --------------------------------------------------------------- isolation

    function test_Isolation_FrozenClauseDoesNotBlockOthers() public {
        uint256 id = _funded(_mk(3)); // 100, 200, 300; all independent
        _verify(id, 0);
        _verify(id, 1);
        uint256 caseId = _dispute(brand, id, 0);
        skip(120);
        escrow.release(id, 1);
        assertEq(_bal(creator), 200e6);
        assertEq(_status(id, 0), DISPUTED);
        // pending c2 expires and refunds independently
        vm.warp(block.timestamp + 8 days);
        escrow.expire(id, 2);
        skip(120);
        escrow.refund(id, 2);
        assertEq(_bal(brand), BRAND_START - 600e6 + 300e6);
        assertEq(_bal(address(escrow)), 100e6, "only the frozen clause remains");
        _decide(caseId, 50);
        escrow.resolveDispute(id, 0);
        assertEq(_bal(creator), 250e6);
        assertEq(_bal(address(escrow)), 0);
    }
}
