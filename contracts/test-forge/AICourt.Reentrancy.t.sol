// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {AICourtTestBase} from "./AICourt.Base.t.sol";
import {AICourt} from "../src/AICourt.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";
import {MockFlakyERC20} from "../test-helpers/MockFlakyERC20.sol";
import {ReentrantRecipient} from "../test-helpers/ReentrantRecipient.sol";

/// @dev A recipient that re-enters claimFee from the token's transfer hook cannot double-claim
///      and cannot block the verdict.
contract AICourtReentrancyTest is AICourtTestBase {
    MockFlakyERC20 internal tok;
    ReentrantRecipient internal atk;

    function _deployUsdc() internal override returns (MockERC20) {
        tok = new MockFlakyERC20("Mock USDC", "mUSDC", 6);
        return tok;
    }

    function setUp() public override {
        super.setUp();
        atk = new ReentrantRecipient(address(court));
    }

    function _members() internal returns (address[] memory m) {
        m = new address[](2);
        m[0] = address(atk);
        m[1] = makeAddr("honest");
    }

    function _appealedDecided(address[] memory maj) internal returns (uint256 id) {
        id = _closed();
        _appealBy(id, client);
        _decide(id, 50, maj);
    }

    /// @dev Give the attacker a credit of DEFAULT_FEE/2 via a soft-failing transfer.
    function _creditAttacker() internal returns (uint256 credit) {
        address[] memory m = _members();
        uint256 id = _appealedDecided(m);
        tok.setSoft(address(atk), true);
        court.finalize(id);
        tok.setSoft(address(atk), false);
        credit = court.claimable(address(atk));
        assertEq(credit, DEFAULT_FEE / 2);
    }

    function test_ReentrantClaim_SwallowedPaysExactlyOnce() public {
        uint256 credit = _creditAttacker();
        tok.setHooks(true);
        atk.setMode(1);
        atk.claim();
        assertEq(_bal(address(atk)), credit);
        assertEq(atk.attempts(), 1);
        assertFalse(atk.reentrySucceeded());
        assertEq(atk.lastError(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(court.claimable(address(atk)), 0);
        assertEq(court.totalClaimable(), 0);
        assertEq(_bal(address(court)), 0);
    }

    function test_ReentrantClaim_BubbledRevertKeepsCredit() public {
        uint256 credit = _creditAttacker();
        tok.setHooks(true);
        atk.setMode(2);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        atk.claim();
        assertEq(court.claimable(address(atk)), credit);
        assertEq(court.totalClaimable(), credit);
        assertEq(_bal(address(atk)), 0);

        atk.setMode(0);
        atk.claim();
        assertEq(_bal(address(atk)), credit);
        assertEq(court.totalClaimable(), 0);
    }

    function test_ReentrantRecipientInFinalize_SwallowedPaidOnce() public {
        address[] memory m = _members();
        uint256 id = _appealedDecided(m);
        tok.setHooks(true);
        atk.setMode(1);
        court.finalize(id);
        assertEq(_bal(address(atk)), DEFAULT_FEE / 2);
        assertEq(atk.attempts(), 1);
        assertFalse(atk.reentrySucceeded());
        assertEq(atk.lastError(), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        assertEq(court.claimable(address(atk)), 0);
        assertEq(_bal(m[1]), DEFAULT_FEE / 2);
        assertEq(_bal(address(court)), 0);
    }

    function test_ReentrantRecipientInFinalize_BubbledIsCreditedAndVerdictStands() public {
        address[] memory m = _members();
        uint256 id = _appealedDecided(m);
        tok.setHooks(true);
        atk.setMode(2); // hook reverts -> the whole token transfer reverts -> credit
        court.finalize(id);
        (bool f, uint8 b) = court.finalVerdict(id);
        assertTrue(f);
        assertEq(b, 50);
        assertEq(_bal(address(atk)), 0);
        assertEq(court.claimable(address(atk)), DEFAULT_FEE / 2);
        assertEq(_bal(m[1]), DEFAULT_FEE / 2);
        assertEq(_bal(address(court)), DEFAULT_FEE / 2);
    }

    function test_ReentrantInFinalizeCannotClaimExistingCredit() public {
        uint256 credit = _creditAttacker();
        // second case pays the attacker directly; its hook tries to claim the old credit
        address[] memory m = _members();
        uint256 id2 = _appealedDecided(m);
        tok.setHooks(true);
        atk.setMode(1);
        court.finalize(id2);
        assertEq(atk.attempts(), 1);
        assertFalse(atk.reentrySucceeded());
        assertEq(_bal(address(atk)), DEFAULT_FEE / 2); // only the direct payment
        assertEq(court.claimable(address(atk)), credit); // credit intact

        atk.setMode(0);
        atk.claim();
        assertEq(_bal(address(atk)), DEFAULT_FEE / 2 + credit);
        assertEq(court.totalClaimable(), 0);
        assertEq(_bal(address(court)), 0);
    }
}
