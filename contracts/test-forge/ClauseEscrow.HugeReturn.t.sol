// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ClauseEscrow} from "../src/ClauseEscrow.sol";
import {MockHugeCourt} from "../test-helpers/MockHugeCourt.sol";
import {ClauseEscrowDisputeBase} from "./ClauseEscrow.DisputeBase.t.sol";

/// @dev A court returning an enormous payload must not burn the escrow's gas: only the first 64 bytes
///      are read. Also covers the boundary of the EIP-150-aware MIN_VERDICT_GAS guard.
contract ClauseEscrowHugeReturnTest is ClauseEscrowDisputeBase {
    uint256 internal constant ODD = 1_000_003;
    uint256 internal constant OTHER = 100e6;
    uint256 internal constant ESCAPE = 1 days;
    uint256 internal constant HUGE = 5_000_000;
    // Memory expansion for ~5 MB costs the COURT ~48M gas, so the 5 MB tests give the tx a bigger budget.
    uint256 internal constant GAS_30M = 30_000_000;
    uint256 internal constant GAS_100M = 100_000_000;
    uint256 internal constant GUARD = 314_761; // floor(300_000 * 64 / 63) + 10_000

    MockHugeCourt internal huge;
    uint256 internal id;
    uint256 internal caseId;

    // ------------------------------------------------ helpers

    /// @dev Swap in a fresh escrow whose court is the huge-payload court; c0 Verified/Failed and disputed.
    function _openHuge(bool verified, uint256 size, bool garbage, uint256 band) internal {
        _freshEscrowNoCourt();
        huge = new MockHugeCourt();
        huge.setSize(size);
        huge.setGarbage(garbage);
        huge.setBand(band);
        vm.prank(owner);
        escrow.setCourt(address(huge));
        id = _two(ODD, OTHER, false);
        if (verified) {
            _verify(id, 0);
            caseId = _dispute(brand, id, 0);
        } else {
            _failReport(id, 0);
            caseId = _dispute(creator, id, 0);
        }
    }

    /// @dev Burning (not huge) court with a valid final verdict for the boundary tests.
    function _openBurning(uint8 band, uint256 burn) internal {
        id = _two(ODD, OTHER, false);
        _verify(id, 0);
        caseId = _dispute(brand, id, 0);
        _decide(caseId, band);
        court.setBurnGas(burn);
    }

    function _callResolve(uint256 g) internal returns (bool ok, bytes memory ret) {
        (ok, ret) = address(escrow).call{gas: g}(abi.encodeCall(escrow.resolveDispute, (id, uint8(0))));
    }

    function _callStuck(uint256 g) internal returns (bool ok, bytes memory ret) {
        (ok, ret) = address(escrow).call{gas: g}(abi.encodeCall(escrow.resolveStuckDispute, (id, uint8(0))));
    }

    function _sel(bytes memory ret) internal pure returns (bytes4 s) {
        if (ret.length >= 4) {
            assembly {
                s := mload(add(ret, 32))
            }
        }
    }

    function _assertUntouched() internal view {
        assertEq(_status(id, 0), DISPUTED);
        assertEq(_bal(creator), 0);
        assertEq(_bal(address(escrow)), ODD + OTHER);
    }

    function _assertSplit(uint8 band, uint256 brandBefore) internal view {
        uint256 toCreator = ODD * band / 100;
        assertEq(_bal(creator), toCreator);
        assertEq(_bal(brand) - brandBefore, ODD - toCreator);
        assertEq(_bal(address(escrow)), OTHER);
        assertEq(_status(id, 0), band == 0 ? REFUNDED : RELEASED);
    }

    /// @dev Gas the court itself spends producing its huge payload (no return data copied by us).
    function _courtCost() internal view returns (uint256 cost) {
        address c = address(huge);
        bytes memory cd = abi.encodeWithSignature("finalVerdict(uint256)", caseId);
        uint256 before_ = gasleft();
        assembly {
            pop(staticcall(gas(), c, add(cd, 0x20), mload(cd), 0, 0))
        }
        cost = before_ - gasleft();
    }

    // ------------------------------------------------ (1a) huge payload, valid first 64 bytes

    function test_Huge_ValidBand_ResolveDisputeSettlesAt30M() public {
        _openHuge(true, 3_000_000, false, 50);
        uint256 bBefore = _bal(brand);
        (bool ok,) = _callResolve(GAS_30M);
        assertTrue(ok);
        _assertSplit(50, bBefore);
    }

    function test_Huge5MB_ValidBand_ResolveDisputeSettles() public {
        _openHuge(true, HUGE, false, 80);
        uint256 bBefore = _bal(brand);
        (bool ok,) = _callResolve(GAS_100M);
        assertTrue(ok);
        _assertSplit(80, bBefore);
    }

    function testFuzz_Huge_ValidBand_ResolveDisputeSettles(uint256 size, uint8 pick) public {
        size = bound(size, 64, 2_000_000);
        uint8[4] memory bands = [uint8(0), 50, 80, 100];
        uint8 band = bands[pick % 4];
        _openHuge(true, size, false, band);
        uint256 bBefore = _bal(brand);
        (bool ok,) = _callResolve(GAS_30M);
        assertTrue(ok);
        _assertSplit(band, bBefore);
    }

    function test_Huge_ValidBand_StuckAfterEscapeIsCaseAlreadyFinal() public {
        _openHuge(true, 3_000_000, false, 50);
        skip(ESCAPE);
        (bool ok, bytes memory ret) = _callStuck(GAS_30M);
        assertFalse(ok);
        assertEq(_sel(ret), ClauseEscrow.CaseAlreadyFinal.selector);
        _assertUntouched();
        uint256 bBefore = _bal(brand);
        (ok,) = _callResolve(GAS_30M);
        assertTrue(ok);
        _assertSplit(50, bBefore);
    }

    /// @dev Escrow-side overhead must be small and independent of the payload: total gas ~ court cost + settlement.
    function test_Huge_EscrowOverheadIndependentOfPayload() public {
        _openHuge(true, 3_000_000, false, 50);
        uint256 courtCost = _courtCost();
        assertGt(courtCost, 10_000_000); // sanity: the court really pays for the big return
        uint256 before_ = gasleft();
        (bool ok,) = _callResolve(GAS_30M);
        uint256 used = before_ - gasleft();
        assertTrue(ok);
        assertLt(used - courtCost, 500_000);
    }

    // ------------------------------------------------ (1b) huge payload, garbage first words

    function test_Huge_Garbage_ResolveNotResolved_StuckSettlesDefaultAfterOneDay() public {
        _openHuge(true, 3_000_000, true, 0);
        (bool ok, bytes memory ret) = _callResolve(GAS_30M);
        assertFalse(ok);
        assertEq(_sel(ret), ClauseEscrow.CaseNotResolved.selector);
        (ok, ret) = _callStuck(GAS_30M);
        assertFalse(ok);
        assertEq(_sel(ret), ClauseEscrow.EscapeNotReached.selector);
        _assertUntouched();
        skip(ESCAPE);
        (ok,) = _callStuck(GAS_30M);
        assertTrue(ok);
        assertEq(_status(id, 0), RELEASED); // Verified -> default band 100
        assertEq(_bal(creator), ODD);
        assertEq(_bal(address(escrow)), OTHER);
    }

    function test_Huge5MB_Garbage_StuckSettlesDefault() public {
        _openHuge(true, HUGE, true, 0);
        (bool ok, bytes memory ret) = _callResolve(GAS_100M);
        assertFalse(ok);
        assertEq(_sel(ret), ClauseEscrow.CaseNotResolved.selector);
        skip(ESCAPE);
        (ok,) = _callStuck(GAS_100M);
        assertTrue(ok);
        assertEq(_status(id, 0), RELEASED);
        assertEq(_bal(creator), ODD);
    }

    function test_Huge_Garbage_FailedDisputeEscapesToBrand() public {
        _openHuge(false, 3_000_000, true, 0);
        skip(ESCAPE);
        uint256 bBefore = _bal(brand);
        (bool ok,) = _callStuck(GAS_30M);
        assertTrue(ok);
        assertEq(_status(id, 0), REFUNDED);
        assertEq(_bal(brand) - bBefore, ODD);
        assertEq(_bal(creator), 0);
    }

    function testFuzz_Huge_Garbage_StuckSettlesDefault(uint256 size) public {
        size = bound(size, 64, 2_000_000);
        _openHuge(true, size, true, 0);
        skip(ESCAPE);
        (bool ok,) = _callStuck(GAS_30M);
        assertTrue(ok);
        assertEq(_bal(creator), ODD);
        assertEq(_bal(address(escrow)), OTHER);
    }

    // ------------------------------------------------ (2) gas-guard boundary with a ~250k-gas court

    /// @dev Any gas limit that passes the guard lets resolveDispute succeed with the court's band, and
    ///      resolveStuckDispute can only report CaseAlreadyFinal; it never settles the default.
    function testFuzz_Boundary_HungryFinalCourt(uint256 g) public {
        _openBurning(50, 250_000);
        skip(ESCAPE);
        g = bound(g, 200_000, 2_000_000);

        uint256 snap = vm.snapshotState();
        (bool ok, bytes memory ret) = _callStuck(g);
        assertFalse(ok);
        bytes4 s = _sel(ret);
        assertTrue(s == ClauseEscrow.InsufficientGas.selector || s == ClauseEscrow.CaseAlreadyFinal.selector);
        if (g < GUARD) assertEq(s, ClauseEscrow.InsufficientGas.selector);
        if (g >= 345_000) assertEq(s, ClauseEscrow.CaseAlreadyFinal.selector);
        _assertUntouched();
        vm.revertToState(snap);

        uint256 bBefore = _bal(brand);
        (ok, ret) = _callResolve(g);
        if (ok) {
            assertGe(g, GUARD);
            _assertSplit(50, bBefore);
        } else {
            // the only acceptable failure is the guard itself
            assertEq(_sel(ret), ClauseEscrow.InsufficientGas.selector);
            assertLt(g, 345_000);
            _assertUntouched();
        }
    }

    /// @dev Walk the boundary: below GUARD always InsufficientGas; the first limit that passes the guard
    ///      already settles with the court's band (no OOG window between guard and success).
    function test_Boundary_ScanFindsNoOogWindowAfterGuard() public {
        _openBurning(50, 250_000);
        skip(ESCAPE);
        bool passed;
        for (uint256 g = 300_000; g <= 360_000; g += 250) {
            uint256 snap = vm.snapshotState();
            (bool ok, bytes memory ret) = _callStuck(g);
            assertFalse(ok);
            bytes4 s = _sel(ret);
            assertTrue(s == ClauseEscrow.InsufficientGas.selector || s == ClauseEscrow.CaseAlreadyFinal.selector);
            _assertUntouched();
            vm.revertToState(snap);

            snap = vm.snapshotState();
            uint256 bBefore = _bal(brand);
            (ok, ret) = _callResolve(g);
            if (ok) {
                passed = true;
                assertGe(g, GUARD);
                _assertSplit(50, bBefore);
            } else {
                // once any limit passed, every higher limit must too
                assertFalse(passed);
                assertEq(_sel(ret), ClauseEscrow.InsufficientGas.selector);
            }
            vm.revertToState(snap);
        }
        assertTrue(passed);
    }

    function test_Boundary_BelowOldAndNewGuardStillReverts() public {
        _openBurning(50, 250_000);
        uint256[4] memory gs = [uint256(250_000), 299_999, 300_000, 314_000];
        for (uint256 i = 0; i < gs.length; i++) {
            (bool ok, bytes memory ret) = _callResolve(gs[i]);
            assertFalse(ok);
            assertEq(_sel(ret), ClauseEscrow.InsufficientGas.selector);
        }
        _assertUntouched();
    }
}
