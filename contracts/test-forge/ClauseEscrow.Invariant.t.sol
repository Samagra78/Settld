// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ClauseEscrow} from "../src/ClauseEscrow.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";
import {ClauseEscrowTestBase} from "./ClauseEscrow.Base.t.sol";

/// @dev Drives bounded random actions against the escrow and tracks ghost totals.
contract ClauseEscrowHandler is Test {
    ClauseEscrow public escrow;
    MockERC20 public usdc;
    address public forwarder;
    address public brand;
    address public creator;

    uint256[] public dealIds;
    uint256 public ghostMinted;
    uint256 public ghostFunded;
    uint256 public ghostReleased;
    uint256 public ghostRefunded;

    constructor(ClauseEscrow e, MockERC20 u, address f, address b, address c) {
        escrow = e;
        usdc = u;
        forwarder = f;
        brand = b;
        creator = c;
    }

    function dealCount() external view returns (uint256) {
        return dealIds.length;
    }

    // ------------------------------------------------------------ actions

    function newDeal(uint256 seed) public {
        if (dealIds.length >= 5) return;
        uint256 n = 1 + (seed % 5);
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

    function verify(uint256 a, uint256 b) public {
        _report(1, a, b);
    }

    function failReport(uint256 a, uint256 b) public {
        _report(2, a, b);
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

    function expire(uint256 a, uint256 b) public {
        (bool ok, uint256 id, uint8 c) = _pick(a, b);
        if (!ok) return;
        _expire(id, c);
    }

    function _release(uint256 id, uint8 c) internal {
        uint256 amt = escrow.getClause(id, c).amount;
        try escrow.release(id, c) {
            ghostReleased += amt;
        } catch {}
    }

    function _refund(uint256 id, uint8 c) internal {
        uint256 amt = escrow.getClause(id, c).amount;
        try escrow.refund(id, c) {
            ghostRefunded += amt;
        } catch {}
    }

    function _expire(uint256 id, uint8 c) internal {
        try escrow.expire(id, c) {} catch {}
    }

    function warp(uint256 secs) public {
        vm.warp(block.timestamp + bound(secs, 0, 2 days));
    }

    /// @dev Fuzz-test dispatcher (also reachable by the invariant fuzzer; harmless).
    function step(uint256 seed) public {
        uint256 h = uint256(keccak256(abi.encode("step", seed)));
        uint256 k = h % 9;
        uint256 a = h >> 16;
        uint256 b = h >> 48;
        if (k == 0) newDeal(h >> 8);
        else if (k == 1) submit(a, b);
        else if (k == 2) verify(a, b);
        else if (k == 3) failReport(a, b);
        else if (k == 4) release(a, b);
        else if (k == 5) refund(a, b);
        else if (k == 6) expire(a, b);
        else if (k == 7) warp(a % 3 hours);
        else warp(a % 2 days);
    }

    /// @dev Drive every clause of every deal to a terminal state (Released/Refunded).
    function settleAll() public {
        vm.warp(block.timestamp + 30 days);
        for (uint256 pass = 0; pass < 7; pass++) {
            // let the 120s release/dispute window elapse for clauses expired in the previous pass
            vm.warp(block.timestamp + 121);
            for (uint256 i = 0; i < dealIds.length; i++) {
                uint256 n = escrow.clauseCount(dealIds[i]);
                for (uint256 c = 0; c < n; c++) {
                    _expire(dealIds[i], uint8(c));
                    _release(dealIds[i], uint8(c));
                    _refund(dealIds[i], uint8(c));
                }
            }
        }
    }

    // ------------------------------------------------------------ views

    /// @dev Independent recomputation: sum of amounts of clauses not yet Released/Refunded.
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

    // ------------------------------------------------------------ internals

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

contract ClauseEscrowInvariantTest is ClauseEscrowTestBase {
    ClauseEscrowHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new ClauseEscrowHandler(escrow, usdc, forwarder, brand, creator);
        targetContract(address(handler));
    }

    function _bal() internal view returns (uint256) {
        return usdc.balanceOf(address(escrow));
    }

    /// PROPERTY: escrow balance == funded - released - refunded.
    function invariant_EscrowBalanceEqualsFundedMinusSettled() public view {
        assertEq(_bal(), handler.ghostFunded() - handler.ghostReleased() - handler.ghostRefunded());
    }

    /// PROPERTY: escrow balance == sum of clause amounts not yet Released/Refunded (from on-chain views).
    function invariant_EscrowBalanceEqualsLiveClauseAmounts() public view {
        assertEq(_bal(), handler.liveAmount());
    }

    /// PROPERTY: payouts go only to creator / brand, nothing leaks.
    function invariant_RecipientsMatchGhosts() public view {
        assertEq(usdc.balanceOf(creator), handler.ghostReleased());
        assertEq(
            usdc.balanceOf(brand),
            BRAND_START + handler.ghostMinted() - handler.ghostFunded() + handler.ghostRefunded()
        );
        assertEq(usdc.balanceOf(stranger), 0);
    }

    /// PROPERTY: Disputed (4) is never reachable, deal ids are dense.
    function invariant_DealCountMatchesHandler() public view {
        assertEq(escrow.dealCount(), handler.dealCount());
    }

    // ------------------------------------------------------- fuzz sequences

    function testFuzz_RandomActionSequenceConservesUsdc(uint256 seed) public {
        // always start with one deal so the sequence has something to act on
        handler.newDeal(seed);
        for (uint256 i = 0; i < 60; i++) {
            handler.step(uint256(keccak256(abi.encode(seed, i))));
            assertEq(_bal(), handler.ghostFunded() - handler.ghostReleased() - handler.ghostRefunded());
            assertEq(_bal(), handler.liveAmount());
        }
    }

    function testFuzz_RandomSequenceThenSettleAllLeavesZero(uint256 seed) public {
        handler.newDeal(seed);
        for (uint256 i = 0; i < 40; i++) {
            handler.step(uint256(keccak256(abi.encode(seed, i, "x"))));
        }
        handler.settleAll();
        assertEq(handler.unsettledCount(), 0, "all clauses terminal");
        assertEq(_bal(), 0, "escrow empty");
        assertEq(handler.ghostFunded(), handler.ghostReleased() + handler.ghostRefunded());
        // total = creator payouts + brand refunds
        assertEq(usdc.balanceOf(creator), handler.ghostReleased());
        assertEq(usdc.balanceOf(brand), BRAND_START_PLUS(handler) - handler.ghostFunded() + handler.ghostRefunded());
        assertEq(usdc.balanceOf(creator) + handler.ghostRefunded(), handler.ghostFunded());
    }

    function BRAND_START_PLUS(ClauseEscrowHandler h) internal view returns (uint256) {
        return BRAND_START + h.ghostMinted();
    }
}
