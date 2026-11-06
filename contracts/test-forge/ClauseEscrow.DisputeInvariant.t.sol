// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ClauseEscrow} from "../src/ClauseEscrow.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";
import {MockAICourt} from "../test-helpers/MockAICourt.sol";
import {ClauseEscrowDisputeBase} from "./ClauseEscrow.DisputeBase.t.sol";

/// @dev Random actions including dispute / court decision / resolve. Tracks ghost accounting.
contract DisputeHandler is Test {
    ClauseEscrow public escrow;
    MockERC20 public usdc;
    MockAICourt public court;
    address public forwarder;
    address public brand;
    address public creator;

    uint256[] public dealIds;
    uint256 public ghostMinted;
    uint256 public ghostFunded;
    uint256 public ghostPaidOut; // clause amounts that left escrow (release/refund/resolve)
    uint256 public doubleSettles; // successful settle of an already-terminal clause
    uint256 public frozenViolations; // release/refund that succeeded on a Disputed clause
    uint256 public settleCalls;

    constructor(ClauseEscrow e, MockERC20 u, MockAICourt c, address f, address b, address cr) {
        escrow = e;
        usdc = u;
        court = c;
        forwarder = f;
        brand = b;
        creator = cr;
    }

    function dealCount() external view returns (uint256) {
        return dealIds.length;
    }

    // ------------------------------------------------------------ actions

    function newDeal(uint256 seed) public {
        if (dealIds.length >= 4) return;
        uint256 n = 1 + (seed % 4);
        ClauseEscrow.ClauseTerms[] memory t = new ClauseEscrow.ClauseTerms[](n);
        uint256 total;
        for (uint256 i = 0; i < n; i++) {
            uint256 h = uint256(keccak256(abi.encode(seed, i)));
            uint256 amt = bound(h, 1, 1_000e6);
            uint8 dep = (i > 0 && (h >> 8) % 3 != 0) ? uint8((h >> 16) % i) : 255;
            t[i] = ClauseEscrow.ClauseTerms({
                kind: 0,
                checkType: 0,
                param: "p",
                deadline: uint64(block.timestamp + 1 days + ((h >> 32) % 3 days)),
                amount: amt,
                dependsOn: dep,
                onFail: 0,
                vestDays: 0
            });
            total += amt;
        }
        vm.prank(brand);
        uint256 id = escrow.proposeDeal(creator, total, t);
        bytes32 sh = escrow.getDeal(id).specHash;
        vm.prank(creator);
        escrow.acceptDeal(id);
        vm.prank(forwarder);
        escrow.onReport("", abi.encode(uint8(0), id, uint8(0), uint8(0), sh, uint64(0), uint64(0)));
        usdc.mint(brand, total);
        ghostMinted += total;
        vm.prank(brand);
        escrow.fundDeal(id);
        ghostFunded += total;
        dealIds.push(id);
    }

    function submit(uint256 a, uint256 b) public {
        (bool ok, uint256 id, uint8 c) = _pick(a, b);
        if (!ok) return;
        vm.prank(creator);
        try escrow.submitEvidence(id, c, "v") {} catch {}
    }

    function verify(uint256 a, uint256 b) public { _report(1, a, b); }

    function failReport(uint256 a, uint256 b) public { _report(2, a, b); }

    function expire(uint256 a, uint256 b) public {
        (bool ok, uint256 id, uint8 c) = _pick(a, b);
        if (!ok) return;
        try escrow.expire(id, c) {} catch {}
    }

    function release(uint256 a, uint256 b) public {
        (bool ok, uint256 id, uint8 c) = _pick(a, b);
        if (!ok) return;
        _release(id, c);
    }

    function refund(uint256 a, uint256 b) public {
        (bool ok, uint256 id, uint8 c) = _pick(a, b);
        if (!ok) return;
        _refund(id, c);
    }

    function dispute(uint256 a, uint256 b, uint256 who) public {
        (bool ok, uint256 id, uint8 c) = _pick(a, b);
        if (!ok) return;
        address caller = who % 3 == 0 ? brand : (who % 3 == 1 ? creator : address(0xBEEF));
        vm.prank(caller);
        try escrow.dispute(id, c, "r") {} catch {}
    }

    /// @dev The court rules (sometimes with an invalid band, sometimes non-final).
    function decide(uint256 a, uint256 b, uint256 v) public {
        (bool ok, uint256 id, uint8 c) = _pick(a, b);
        if (!ok) return;
        uint256 caseId = escrow.caseOf(id, c);
        if (caseId == 0) return;
        uint256 m = v % 8;
        uint8[4] memory bands = [uint8(0), 50, 80, 100];
        if (m == 0) court.setVerdict(caseId, false, 50);
        else if (m == 1) court.setVerdict(caseId, true, uint8(1 + (v >> 8) % 49)); // invalid band 1..49
        else court.setVerdict(caseId, true, bands[(v >> 8) % 4]);
    }

    function toggleCourtReverts(uint256 v) public {
        if (v % 4 == 3) {
            // malformed raw returns (empty, one word, bool=2, band=256) or a final raw band
            uint8[5] memory modes = [uint8(1), 2, 3, 4, 6];
            court.setMode(modes[(v >> 8) % 5]);
            court.setRawBand(v >> 16);
        } else {
            court.setMode(0);
            court.setRevertOnVerdict(v % 2 == 0);
        }
    }

    function resolveStuck(uint256 a, uint256 b) public {
        (bool ok, uint256 id, uint8 c) = _pick(a, b);
        if (!ok) return;
        _resolveStuck(id, c);
    }

    function resolve(uint256 a, uint256 b) public {
        (bool ok, uint256 id, uint8 c) = _pick(a, b);
        if (!ok) return;
        _resolve(id, c);
    }

    function warp(uint256 secs) public {
        vm.warp(block.timestamp + bound(secs, 0, 2 days));
    }

    function step(uint256 seed) public {
        uint256 h = uint256(keccak256(abi.encode("step", seed)));
        uint256 k = h % 16;
        uint256 a = h >> 16;
        uint256 b = h >> 48;
        uint256 v = h >> 80;
        if (k == 0) newDeal(h >> 8);
        else if (k == 1) submit(a, b);
        else if (k == 2 || k == 3) verify(a, b);
        else if (k == 4) failReport(a, b);
        else if (k == 5) release(a, b);
        else if (k == 6) refund(a, b);
        else if (k == 7) expire(a, b);
        else if (k == 8 || k == 9) dispute(a, b, v);
        else if (k == 10) decide(a, b, v);
        else if (k == 11) resolve(a, b);
        else if (k == 12) resolveStuck(a, b);
        else if (k == 13) toggleCourtReverts(v);
        else if (k == 14) vm.warp(block.timestamp + 1 days + (a % 1 days)); // pass the escape delay
        else warp(a % 3 hours);
    }

    /// @dev Drive every clause to a terminal state; the court rules for every open case.
    function settleAll() public {
        vm.warp(block.timestamp + 30 days);
        court.setRevertOnVerdict(false);
        court.setMode(0);
        for (uint256 pass = 0; pass < 8; pass++) {
            vm.warp(block.timestamp + 121);
            for (uint256 i = 0; i < dealIds.length; i++) {
                uint256 n = escrow.clauseCount(dealIds[i]);
                for (uint256 c = 0; c < n; c++) {
                    uint256 id = dealIds[i];
                    try escrow.expire(id, uint8(c)) {} catch {}
                    _release(id, uint8(c));
                    _refund(id, uint8(c));
                    uint256 caseId = escrow.caseOf(id, uint8(c));
                    if (caseId != 0 && pass % 2 == 0) _resolveStuck(id, uint8(c)); // escape path (if non-final)
                    if (caseId != 0) {
                        uint8[4] memory bands = [uint8(0), 50, 80, 100];
                        court.setVerdict(caseId, true, bands[caseId % 4]);
                    }
                    _resolve(id, uint8(c));
                }
            }
        }
    }

    // ------------------------------------------------------------ settle wrappers

    function _release(uint256 id, uint8 c) internal {
        ClauseEscrow.Clause memory cl = escrow.getClause(id, c);
        try escrow.release(id, c) {
            if (cl.status == 4) frozenViolations++;
            _afterSettle(cl);
        } catch {}
    }

    function _refund(uint256 id, uint8 c) internal {
        ClauseEscrow.Clause memory cl = escrow.getClause(id, c);
        try escrow.refund(id, c) {
            if (cl.status == 4) frozenViolations++;
            _afterSettle(cl);
        } catch {}
    }

    function _resolve(uint256 id, uint8 c) internal {
        ClauseEscrow.Clause memory cl = escrow.getClause(id, c);
        try escrow.resolveDispute(id, c) {
            if (cl.status != 4) doubleSettles++; // only a Disputed clause may be court-resolved
            _afterSettle(cl);
        } catch {}
    }

    function _resolveStuck(uint256 id, uint8 c) internal {
        ClauseEscrow.Clause memory cl = escrow.getClause(id, c);
        try escrow.resolveStuckDispute(id, c) {
            if (cl.status != 4) doubleSettles++; // only a Disputed clause may be escape-resolved
            _afterSettle(cl);
        } catch {}
    }

    function _afterSettle(ClauseEscrow.Clause memory before_) internal {
        if (before_.status == 5 || before_.status == 6) doubleSettles++;
        settleCalls++;
        ghostPaidOut += before_.amount;
    }

    // ------------------------------------------------------------ views

    function liveAmount() external view returns (uint256 s) {
        for (uint256 i = 0; i < dealIds.length; i++) {
            ClauseEscrow.Clause[] memory cs = escrow.getClauses(dealIds[i]);
            for (uint256 c = 0; c < cs.length; c++) {
                if (cs[c].status != 5 && cs[c].status != 6) s += cs[c].amount;
            }
        }
    }

    function unsettledCount() external view returns (uint256 n) {
        for (uint256 i = 0; i < dealIds.length; i++) {
            ClauseEscrow.Clause[] memory cs = escrow.getClauses(dealIds[i]);
            for (uint256 c = 0; c < cs.length; c++) {
                if (cs[c].status != 5 && cs[c].status != 6) n++;
            }
        }
    }

    function terminalCount() external view returns (uint256 n) {
        for (uint256 i = 0; i < dealIds.length; i++) {
            ClauseEscrow.Clause[] memory cs = escrow.getClauses(dealIds[i]);
            for (uint256 c = 0; c < cs.length; c++) {
                if (cs[c].status == 5 || cs[c].status == 6) n++;
            }
        }
    }

    function _pick(uint256 a, uint256 b) internal view returns (bool, uint256, uint8) {
        if (dealIds.length == 0) return (false, 0, 0);
        uint256 id = dealIds[a % dealIds.length];
        uint256 n = escrow.clauseCount(id);
        return (true, id, uint8(b % n));
    }

    function _report(uint8 kind, uint256 a, uint256 b) internal {
        (bool ok, uint256 id, uint8 c) = _pick(a, b);
        if (!ok) return;
        bytes memory r = abi.encode(kind, id, c, uint8(1), bytes32(0), uint64(0), uint64(0));
        vm.prank(forwarder);
        try escrow.onReport("", r) {} catch {}
    }
}

/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 200
contract ClauseEscrowDisputeInvariantTest is ClauseEscrowDisputeBase {
    DisputeHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new DisputeHandler(escrow, usdc, court, forwarder, brand, creator);
        targetContract(address(handler));
    }

    function _bal() internal view returns (uint256) {
        return usdc.balanceOf(address(escrow));
    }

    function _checkAll() internal view {
        assertEq(_bal(), handler.ghostFunded() - handler.ghostPaidOut(), "escrow == funded - paid out");
        assertEq(_bal(), handler.liveAmount(), "escrow == unsettled clause amounts");
        assertEq(
            usdc.balanceOf(creator) + usdc.balanceOf(brand) + _bal(),
            BRAND_START + handler.ghostMinted(),
            "supply conserved between parties"
        );
        assertEq(usdc.balanceOf(stranger), 0);
        assertEq(handler.doubleSettles(), 0, "a clause settled twice");
        assertEq(handler.frozenViolations(), 0);
    }

    /// PROPERTY: escrow balance == funded - paid out == live clause amounts; no clause settles twice.
    function invariant_EscrowConservationAndSingleSettlement() public view {
        _checkAll();
    }

    /// PROPERTY: number of terminal clauses never exceeds successful settle calls (one payout each).
    function invariant_TerminalClausesMatchSettleCalls() public view {
        assertEq(handler.terminalCount(), handler.settleCalls());
    }

    /// Non-vacuity: the handler's dispute -> decide -> resolve path really settles a clause.
    function test_Handler_ReachesDisputeDecideResolve() public {
        handler.newDeal(0);
        handler.submit(0, 0);
        handler.verify(0, 0);
        handler.dispute(0, 0, 0);
        uint256 id = handler.dealIds(0);
        assertEq(_status(id, 0), DISPUTED);
        handler.decide(0, 0, 2 + (1 << 8)); // final verdict, band 50
        handler.resolve(0, 0);
        uint8 s = _status(id, 0);
        assertTrue(s == RELEASED || s == REFUNDED);
        assertEq(handler.settleCalls(), 1);
        assertEq(handler.ghostPaidOut(), escrow.getClause(id, 0).amount);
        _checkAll();
    }

    /// Non-vacuity: the handler's dispute -> warp -> resolveStuck path really settles a clause,
    /// even when the court's finalVerdict reverts, and the accounting stays consistent.
    function test_Handler_ReachesDisputeWarpResolveStuck() public {
        handler.newDeal(0);
        handler.submit(0, 0);
        handler.verify(0, 0);
        handler.dispute(0, 0, 0);
        uint256 id = handler.dealIds(0);
        assertEq(_status(id, 0), DISPUTED);
        handler.toggleCourtReverts(0);
        handler.resolveStuck(0, 0); // too early
        assertEq(_status(id, 0), DISPUTED);
        skip(1 days);
        handler.resolveStuck(0, 0);
        assertEq(_status(id, 0), RELEASED); // Verified default band 100
        assertEq(handler.settleCalls(), 1);
        assertEq(handler.doubleSettles(), 0);
        assertEq(handler.ghostPaidOut(), escrow.getClause(id, 0).amount);
        _checkAll();
    }

    function testFuzz_RandomSequenceWithDisputes(uint256 seed) public {
        handler.newDeal(seed);
        for (uint256 i = 0; i < 80; i++) {
            handler.step(uint256(keccak256(abi.encode(seed, i))));
            _checkAll();
        }
    }

    function testFuzz_RandomSequenceThenSettleAll(uint256 seed) public {
        handler.newDeal(seed);
        for (uint256 i = 0; i < 60; i++) {
            handler.step(uint256(keccak256(abi.encode(seed, i, "y"))));
        }
        handler.settleAll();
        assertEq(handler.unsettledCount(), 0, "every clause terminal");
        assertEq(_bal(), 0, "escrow empty");
        assertEq(handler.ghostPaidOut(), handler.ghostFunded());
        assertEq(handler.doubleSettles(), 0);
        assertEq(handler.terminalCount(), handler.settleCalls(), "each clause settled exactly once");
        assertEq(usdc.balanceOf(creator) + usdc.balanceOf(brand), BRAND_START + handler.ghostMinted());
    }
}
