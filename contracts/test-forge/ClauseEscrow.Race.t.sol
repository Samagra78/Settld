// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {ClauseEscrow} from "../src/ClauseEscrow.sol";
import {ClauseEscrowDisputeBase} from "./ClauseEscrow.DisputeBase.t.sol";

/// @dev resolveDispute vs resolveStuckDispute race: exactly one settlement per disputed clause.
contract ClauseEscrowRaceTest is ClauseEscrowDisputeBase {
    uint256 internal constant AMT = 1_000_003;
    uint256 internal constant OTHER = 100e6;
    uint256 internal constant ESCAPE = 1 days;
    uint8 internal constant REL = 5;
    uint8 internal constant REF = 6;

    bytes32 internal constant SPLIT_SIG = keccak256("ClauseSplit(uint256,uint8,uint256,uint256)");
    bytes32 internal constant SETTLED_SIG = keccak256("ClauseSettled(uint256,uint8,uint8,uint256)");

    struct Snap {
        uint256 creatorBal;
        uint256 brandBal;
        uint256 escrowBal;
    }

    function _snap() internal view returns (Snap memory s) {
        s = Snap(_bal(creator), _bal(brand), _bal(address(escrow)));
    }

    function _same(Snap memory a, Snap memory b) internal pure returns (bool) {
        return a.creatorBal == b.creatorBal && a.brandBal == b.brandBal && a.escrowBal == b.escrowBal;
    }

    function _expectStatus(uint8 s) internal {
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidClauseStatus.selector, s));
    }

    /// @dev Disputed clause 0 (amount `amt`); Verified (default band 100) or Failed (default band 0).
    function _disputed(uint256 amt, bool verified) internal returns (uint256 id, uint256 caseId) {
        id = _two(amt, OTHER, false);
        if (verified) _verify(id, 0);
        else _failReport(id, 0);
        caseId = _dispute(brand, id, 0);
    }

    function _countLogs() internal returns (uint256 splits, uint256 settled) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(escrow)) continue;
            if (logs[i].topics[0] == SPLIT_SIG) splits++;
            if (logs[i].topics[0] == SETTLED_SIG) settled++;
        }
    }

    /// @dev After settlement: every path attempt reverts and nothing moves.
    function _assertDead(uint256 id, uint8 expectedStatus) internal {
        Snap memory before = _snap();
        _expectStatus(expectedStatus);
        escrow.resolveDispute(id, 0);
        _expectStatus(expectedStatus);
        escrow.resolveStuckDispute(id, 0);
        _expectStatus(expectedStatus);
        escrow.release(id, 0);
        vm.expectRevert(ClauseEscrow.RefundNotAllowed.selector);
        escrow.refund(id, 0);
        assertEq(_status(id, 0), expectedStatus);
        assertTrue(_same(before, _snap()));
    }

    // ------------------------------------------------------- scenario 1: court first

    function test_Race_CourtFirstThenEscapeReverts() public {
        (uint256 id, uint256 caseId) = _disputed(AMT, true);
        _decide(caseId, 50);
        vm.recordLogs();
        _resolve(id, 0);
        assertEq(_status(id, 0), REL);
        assertEq(_bal(creator), AMT * 50 / 100);
        assertEq(_bal(brand), BRAND_START - AMT - OTHER + (AMT - AMT * 50 / 100));
        Snap memory settled = _snap();

        skip(ESCAPE);
        _expectStatus(REL);
        escrow.resolveStuckDispute(id, 0);
        assertTrue(_same(settled, _snap()));
        (uint256 splits, uint256 evts) = _countLogs();
        assertEq(splits, 1);
        assertEq(evts, 1);
    }

    function test_Race_CourtFirstRefundedOutcomeThenEscapeReverts() public {
        (uint256 id, uint256 caseId) = _disputed(AMT, true);
        _decide(caseId, 0); // court overrules default: brand gets everything
        _resolve(id, 0);
        assertEq(_status(id, 0), REF);
        Snap memory settled = _snap();
        assertEq(settled.creatorBal, 0);
        skip(ESCAPE);
        _expectStatus(REF);
        escrow.resolveStuckDispute(id, 0);
        assertTrue(_same(settled, _snap()));
    }

    // ------------------------------------------------------- scenario 2: escape first

    function test_Race_EscapeFirstThenCourtReverts() public {
        (uint256 id, uint256 caseId) = _disputed(AMT, true);
        skip(ESCAPE);
        vm.recordLogs();
        escrow.resolveStuckDispute(id, 0); // no verdict -> default band 100
        assertEq(_status(id, 0), REL);
        assertEq(_bal(creator), AMT);
        Snap memory settled = _snap();

        _decide(caseId, 0); // court later sets a final verdict
        _expectStatus(REL);
        escrow.resolveDispute(id, 0);
        assertTrue(_same(settled, _snap()));
        assertEq(_bal(creator), AMT);
        (uint256 splits, uint256 evts) = _countLogs();
        assertEq(splits, 1);
        assertEq(evts, 1);
    }

    function test_Race_EscapeFirstFailedDefaultThenCourtReverts() public {
        (uint256 id, uint256 caseId) = _disputed(AMT, false);
        skip(ESCAPE);
        escrow.resolveStuckDispute(id, 0); // default band 0
        assertEq(_status(id, 0), REF);
        Snap memory settled = _snap();
        _decide(caseId, 100);
        _expectStatus(REF);
        escrow.resolveDispute(id, 0);
        assertTrue(_same(settled, _snap()));
        assertEq(_bal(creator), 0);
    }

    function test_Race_ResolveDisputeBeforeVerdictRevertsCaseNotResolved() public {
        (uint256 id,) = _disputed(AMT, true);
        skip(ESCAPE);
        vm.expectRevert(ClauseEscrow.CaseNotResolved.selector);
        escrow.resolveDispute(id, 0);
        assertEq(_status(id, 0), DISPUTED);
    }

    // ------------------------------------------------------- scenario 3: same result, repeated calls

    function test_Race_BothOrdersSameResultAndRepeatedCallsRevert() public {
        // court band equals the default band so both orders must produce an identical split
        (uint256 idA, uint256 caseA) = _disputed(AMT, true);
        (uint256 idB, uint256 caseB) = _disputed(AMT, true);
        _decide(caseA, 100);
        skip(ESCAPE);

        uint256 cBefore = _bal(creator);
        uint256 bBefore = _bal(brand);

        // deal A: court path first
        _resolve(idA, 0);
        uint256 cA = _bal(creator) - cBefore;
        uint256 bA = _bal(brand) - bBefore;

        // deal B: escape path first (no verdict yet)
        escrow.resolveStuckDispute(idB, 0);
        uint256 cB = _bal(creator) - cBefore - cA;
        uint256 bB = _bal(brand) - bBefore - bA;
        _decide(caseB, 100);

        assertEq(cA, cB);
        assertEq(bA, bB);
        assertEq(_status(idA, 0), _status(idB, 0));

        // repeated calls on both: all revert, nothing moves
        Snap memory settled = _snap();
        for (uint256 i = 0; i < 3; i++) {
            _expectStatus(REL);
            escrow.resolveDispute(idA, 0);
            _expectStatus(REL);
            escrow.resolveStuckDispute(idA, 0);
            _expectStatus(REL);
            escrow.resolveDispute(idB, 0);
            _expectStatus(REL);
            escrow.resolveStuckDispute(idB, 0);
        }
        assertTrue(_same(settled, _snap()));
    }

    // ------------------------------------------------------- CaseAlreadyFinal

    function test_Race_EscapeRevertsCaseAlreadyFinalWhenUsableVerdictExists() public {
        (uint256 id, uint256 caseId) = _disputed(AMT, true);
        _decide(caseId, 80);
        skip(ESCAPE);
        Snap memory before = _snap();
        vm.expectRevert(ClauseEscrow.CaseAlreadyFinal.selector);
        escrow.resolveStuckDispute(id, 0);
        assertEq(_status(id, 0), DISPUTED);
        assertTrue(_same(before, _snap()));

        // resolveDispute must be used, and settles exactly once by the court band
        vm.recordLogs();
        _resolve(id, 0);
        assertEq(_status(id, 0), REL);
        assertEq(_bal(creator), AMT * 80 / 100);
        assertEq(_bal(brand), BRAND_START - AMT - OTHER + (AMT - AMT * 80 / 100));
        Snap memory settled = _snap();
        _expectStatus(REL);
        escrow.resolveStuckDispute(id, 0);
        _expectStatus(REL);
        escrow.resolveDispute(id, 0);
        assertTrue(_same(settled, _snap()));
        (uint256 splits, uint256 evts) = _countLogs();
        assertEq(splits, 1);
        assertEq(evts, 1);
    }

    function test_Race_NonFinalOrInvalidBandVerdictAllowsEscape() public {
        (uint256 id, uint256 caseId) = _disputed(AMT, true);
        court.setVerdict(caseId, false, 50); // not final -> unusable
        skip(ESCAPE);
        escrow.resolveStuckDispute(id, 0);
        assertEq(_status(id, 0), REL);
        assertEq(_bal(creator), AMT); // default band 100, not the non-final 50

        (uint256 id2, uint256 case2) = _disputed(AMT, true);
        court.setVerdict(case2, true, 33); // final but invalid band
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidBand.selector, uint8(33)));
        escrow.resolveDispute(id2, 0);
        skip(ESCAPE);
        escrow.resolveStuckDispute(id2, 0); // invalid band counts as no usable verdict
        assertEq(_status(id2, 0), REL);
    }

    // ------------------------------------------------------- (b) late court verdict

    function _lateVerdicts(uint256 id, uint256 caseId, uint8 settledStatus) internal {
        uint8[5] memory bands = [uint8(0), 50, 80, 100, 0];
        for (uint256 i = 0; i < bands.length; i++) {
            Snap memory before = _snap();
            _decide(caseId, bands[i]);
            skip(1 days);
            _assertDead(id, settledStatus);
            assertTrue(_same(before, _snap()));
        }
        // non-final verdict update too
        court.setVerdict(caseId, false, 50);
        _assertDead(id, settledStatus);
    }

    function test_Late_AfterDefaultBand100ThenCourtSays0() public {
        (uint256 id, uint256 caseId) = _disputed(AMT, true);
        skip(ESCAPE);
        escrow.resolveStuckDispute(id, 0);
        assertEq(_status(id, 0), REL);
        assertEq(_bal(creator), AMT);
        _decide(caseId, 0);
        _assertDead(id, REL);
        assertEq(_bal(creator), AMT);
        _lateVerdicts(id, caseId, REL);
    }

    function test_Late_AfterDefaultBand0ThenCourtSays100() public {
        (uint256 id, uint256 caseId) = _disputed(AMT, false);
        skip(ESCAPE);
        escrow.resolveStuckDispute(id, 0);
        assertEq(_status(id, 0), REF);
        assertEq(_bal(creator), 0);
        _decide(caseId, 100);
        _assertDead(id, REF);
        assertEq(_bal(creator), 0);
        _lateVerdicts(id, caseId, REF);
    }

    function test_Late_AfterCourtReleasedThenCourtChanges() public {
        (uint256 id, uint256 caseId) = _disputed(AMT, false);
        _decide(caseId, 100);
        _resolve(id, 0);
        assertEq(_status(id, 0), REL);
        assertEq(_bal(creator), AMT);
        _decide(caseId, 0);
        _assertDead(id, REL);
        _lateVerdicts(id, caseId, REL);
    }

    function test_Late_AfterCourtRefundedThenCourtChanges() public {
        (uint256 id, uint256 caseId) = _disputed(AMT, true);
        _decide(caseId, 0);
        _resolve(id, 0);
        assertEq(_status(id, 0), REF);
        assertEq(_bal(creator), 0);
        _decide(caseId, 100);
        _assertDead(id, REF);
        _lateVerdicts(id, caseId, REF);
    }

    function test_Late_AfterCourtSplitThenCourtChanges() public {
        (uint256 id, uint256 caseId) = _disputed(AMT, true);
        _decide(caseId, 50);
        _resolve(id, 0);
        assertEq(_status(id, 0), REL);
        _decide(caseId, 100);
        _assertDead(id, REL);
        _lateVerdicts(id, caseId, REL);
    }

    // ------------------------------------------------------- fuzz

    function testFuzz_Race_SingleSettlementAndConservation(
        bool courtFirst,
        uint8 bandSel,
        bool defaultVerified,
        uint256 amt
    ) public {
        // brand is funded with BRAND_START (1e12) and also escrows OTHER (1e8): keep amt well inside that.
        amt = bound(amt, 1, 1e9);
        uint8[4] memory bands = [uint8(0), 50, 80, 100];
        uint8 courtBand = bands[bandSel % 4];
        uint8 defBand = defaultVerified ? 100 : 0;

        (uint256 id, uint256 caseId) = _disputed(amt, defaultVerified);
        uint256 totalBefore = _bal(creator) + _bal(brand) + _bal(address(escrow));
        assertEq(_bal(address(escrow)), amt + OTHER);

        uint8 usedBand;
        vm.recordLogs();
        if (courtFirst) {
            _decide(caseId, courtBand);
            _resolve(id, 0);
            usedBand = courtBand;
        } else {
            skip(ESCAPE);
            escrow.resolveStuckDispute(id, 0);
            usedBand = defBand;
            _decide(caseId, courtBand); // late verdict
        }
        uint256 toCreator = amt * usedBand / 100;
        uint8 expectStatus = toCreator > 0 ? REL : REF;
        assertEq(_status(id, 0), expectStatus);
        assertEq(_bal(creator), toCreator);
        assertEq(_bal(brand), BRAND_START - amt - OTHER + (amt - toCreator));
        assertEq(_bal(address(escrow)), OTHER);
        assertEq(_bal(creator) + _bal(brand) + _bal(address(escrow)), totalBefore);

        skip(ESCAPE);
        Snap memory settled = _snap();
        _expectStatus(expectStatus);
        escrow.resolveDispute(id, 0);
        _expectStatus(expectStatus);
        escrow.resolveStuckDispute(id, 0);
        assertTrue(_same(settled, _snap()));

        (uint256 splits, uint256 evts) = _countLogs();
        assertEq(splits, 1);
        assertEq(evts, 1);
    }
}
