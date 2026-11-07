// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ClauseEscrow} from "../src/ClauseEscrow.sol";
import {ClauseEscrowDisputeBase} from "./ClauseEscrow.DisputeBase.t.sol";

/// @dev Hardened court-verdict read: malformed data, unusable bands, and the MIN_VERDICT_GAS guard.
contract ClauseEscrowVerdictTest is ClauseEscrowDisputeBase {
    uint256 internal constant ODD = 1_000_003;
    uint256 internal constant OTHER = 100e6;
    uint256 internal constant ESCAPE = 1 days;

    uint256 internal id;
    uint256 internal caseId;

    /// @dev c0 Verified (default band 100) and disputed by the brand.
    function _openVerified() internal {
        id = _two(ODD, OTHER, false);
        _verify(id, 0);
        caseId = _dispute(brand, id, 0);
    }

    /// @dev c0 Failed (default band 0) and disputed by the creator.
    function _openFailed() internal {
        id = _two(ODD, OTHER, false);
        _failReport(id, 0);
        caseId = _dispute(creator, id, 0);
    }

    function _callResolve(uint256 g) internal returns (bool ok, bytes memory ret) {
        (ok, ret) = address(escrow).call{gas: g}(abi.encodeCall(escrow.resolveDispute, (id, uint8(0))));
    }

    function _callStuck(uint256 g) internal returns (bool ok, bytes memory ret) {
        (ok, ret) = address(escrow).call{gas: g}(abi.encodeCall(escrow.resolveStuckDispute, (id, uint8(0))));
    }

    function _assertUntouched() internal view {
        assertEq(_status(id, 0), DISPUTED);
        assertEq(_bal(creator), 0);
        assertEq(_bal(address(escrow)), ODD + OTHER);
    }

    function _sel(bytes memory ret) internal pure returns (bytes4 s) {
        if (ret.length >= 4) {
            assembly {
                s := mload(add(ret, 32))
            }
        }
    }

    /// @dev Malformed return mode: resolveDispute -> CaseNotResolved; escape settles the default after a day.
    function _malformed(uint8 m) internal {
        _openVerified();
        court.setVerdict(caseId, true, 50); // a well-formed verdict is ignored because the raw mode wins
        court.setMode(m);
        vm.expectRevert(ClauseEscrow.CaseNotResolved.selector);
        escrow.resolveDispute(id, 0);
        vm.expectRevert(ClauseEscrow.EscapeNotReached.selector);
        escrow.resolveStuckDispute(id, 0);
        _assertUntouched();
        skip(ESCAPE);
        vm.expectRevert(ClauseEscrow.CaseNotResolved.selector);
        escrow.resolveDispute(id, 0);
        escrow.resolveStuckDispute(id, 0);
        assertEq(_status(id, 0), RELEASED);
        assertEq(_bal(creator), ODD); // Verified -> default band 100
        assertEq(_bal(address(escrow)), OTHER);
    }

    function test_Malformed_EmptyReturndata() public { _malformed(1); }
    function test_Malformed_OnlyOneWord() public { _malformed(2); }
    function test_Malformed_BoolWordIsTwo() public { _malformed(3); }
    function test_Malformed_BandWordIs256() public { _malformed(4); }

    function test_Malformed_FailedDisputeEscapesToBrand() public {
        _openFailed();
        court.setMode(3);
        vm.expectRevert(ClauseEscrow.CaseNotResolved.selector);
        escrow.resolveDispute(id, 0);
        skip(ESCAPE);
        uint256 bBefore = _bal(brand);
        escrow.resolveStuckDispute(id, 0);
        assertEq(_status(id, 0), REFUNDED);
        assertEq(_bal(brand) - bBefore, ODD);
        assertEq(_bal(creator), 0);
    }

    // ------------------------------------------------ final verdict, unusable band

    function test_FinalInvalidBand_ResolveInvalidBand_StuckSettlesDefault() public {
        uint8[4] memory bad = [uint8(1), 30, 101, 255];
        for (uint256 i = 0; i < bad.length; i++) {
            _openVerified();
            _decide(caseId, bad[i]);
            vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidBand.selector, bad[i]));
            escrow.resolveDispute(id, 0);
            vm.expectRevert(ClauseEscrow.EscapeNotReached.selector);
            escrow.resolveStuckDispute(id, 0);
            skip(ESCAPE);
            escrow.resolveStuckDispute(id, 0);
            assertEq(_status(id, 0), RELEASED);
        }
        assertEq(_bal(creator), ODD * 4);
    }

    function test_FinalInvalidBand_FailedDisputeSettlesToBrand() public {
        _openFailed();
        _decide(caseId, 30);
        skip(ESCAPE);
        uint256 bBefore = _bal(brand);
        escrow.resolveStuckDispute(id, 0);
        assertEq(_status(id, 0), REFUNDED);
        assertEq(_bal(brand) - bBefore, ODD);
    }

    function test_FinalValidBand_StuckStillBlocked() public {
        uint8[4] memory good = [uint8(0), 50, 80, 100];
        for (uint256 i = 0; i < good.length; i++) {
            _openVerified();
            _decide(caseId, good[i]);
            skip(ESCAPE);
            vm.expectRevert(ClauseEscrow.CaseAlreadyFinal.selector);
            escrow.resolveStuckDispute(id, 0);
            escrow.resolveDispute(id, 0);
            assertEq(_status(id, 0), good[i] == 0 ? REFUNDED : RELEASED);
        }
    }

    function testFuzz_RawFinalBand(uint256 raw) public {
        _openVerified();
        court.setMode(6);
        court.setRawBand(raw);
        bool valid = raw == 0 || raw == 50 || raw == 80 || raw == 100;
        if (valid) {
            skip(ESCAPE);
            vm.expectRevert(ClauseEscrow.CaseAlreadyFinal.selector);
            escrow.resolveStuckDispute(id, 0);
            uint256 bBefore = _bal(brand);
            escrow.resolveDispute(id, 0);
            assertEq(_bal(creator), ODD * raw / 100);
            assertEq(_bal(brand) - bBefore, ODD - ODD * raw / 100);
        } else {
            if (raw <= 255) vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidBand.selector, uint8(raw)));
            else vm.expectRevert(ClauseEscrow.CaseNotResolved.selector);
            escrow.resolveDispute(id, 0);
            skip(ESCAPE);
            escrow.resolveStuckDispute(id, 0);
            assertEq(_status(id, 0), RELEASED);
            assertEq(_bal(creator), ODD); // default band 100
        }
        assertEq(_bal(address(escrow)), OTHER);
    }

    // ------------------------------------------------ gas guard

    function test_ResolveDispute_InsufficientGasReverts() public {
        _openVerified();
        _decide(caseId, 50);
        (bool ok, bytes memory ret) = _callResolve(250_000);
        assertFalse(ok);
        assertEq(_sel(ret), ClauseEscrow.InsufficientGas.selector);
        (ok, ret) = _callResolve(299_999);
        assertFalse(ok);
        assertEq(_sel(ret), ClauseEscrow.InsufficientGas.selector);
        _assertUntouched();
        (ok,) = _callResolve(2_000_000);
        assertTrue(ok);
        assertEq(_status(id, 0), RELEASED);
        assertEq(_bal(creator), ODD / 2);
    }

    function test_ResolveStuck_InsufficientGasRevertsAndDoesNotSettle() public {
        _openVerified();
        court.setRevertOnVerdict(true); // would otherwise be a legitimate escape
        skip(ESCAPE);
        (bool ok, bytes memory ret) = _callStuck(250_000);
        assertFalse(ok);
        assertEq(_sel(ret), ClauseEscrow.InsufficientGas.selector);
        _assertUntouched();
        (ok,) = _callStuck(2_000_000);
        assertTrue(ok);
        assertEq(_status(id, 0), RELEASED);
        assertEq(_bal(creator), ODD);
    }

    function testFuzz_StarvedCallsNeverSettle(uint256 g, bool stuck) public {
        _openVerified();
        _decide(caseId, 50);
        skip(ESCAPE);
        g = bound(g, 0, 299_999);
        (bool ok, bytes memory ret) = stuck ? _callStuck(g) : _callResolve(g);
        assertFalse(ok);
        assertTrue(_sel(ret) != ClauseEscrow.CaseAlreadyFinal.selector);
        _assertUntouched();
    }

    /// @dev A gas-hungry (not malicious) court that really has a final verdict: no starved call may
    ///      reach the escape and settle the default instead of the court's band.
    function testFuzz_HungryFinalCourt_StarvingCannotTriggerEscape(uint256 g) public {
        _openVerified();
        _decide(caseId, 50);
        court.setBurnGas(200_000);
        skip(ESCAPE);
        g = bound(g, 0, 3_000_000);
        (bool ok, bytes memory ret) = _callStuck(g);
        assertFalse(ok);
        _assertUntouched();
        if (g >= 500_000) assertEq(_sel(ret), ClauseEscrow.CaseAlreadyFinal.selector);
        if (g < 300_000) assertTrue(_sel(ret) != ClauseEscrow.CaseAlreadyFinal.selector);
        // The court's real verdict stays resolvable with ample gas.
        (ok,) = _callResolve(3_000_000);
        assertTrue(ok);
        assertEq(_bal(creator), ODD / 2);
    }

    /// @dev A court that burns all forwarded gas: a starved caller cannot leave enough gas to settle.
    function testFuzz_BurningCourt_StarvedEscapeCannotSettle(uint256 g) public {
        _openVerified();
        court.setMode(5);
        skip(ESCAPE);
        g = bound(g, 0, 1_000_000);
        (bool ok,) = _callStuck(g);
        assertFalse(ok);
        _assertUntouched();
    }

    function test_BurningCourt_ResolveDisputeNotResolved_EscapeSettlesWithEnoughGas() public {
        _openVerified();
        court.setMode(5);
        (bool ok, bytes memory ret) = _callResolve(20_000_000);
        assertFalse(ok);
        assertEq(_sel(ret), ClauseEscrow.CaseNotResolved.selector);
        skip(ESCAPE);
        (ok,) = _callStuck(20_000_000);
        assertTrue(ok);
        assertEq(_status(id, 0), RELEASED);
        assertEq(_bal(creator), ODD);
        assertEq(_bal(address(escrow)), OTHER);
    }
}
