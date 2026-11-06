// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Vm} from "forge-std/Vm.sol";
import {AICourtTestBase} from "./AICourt.Base.t.sol";
import {AICourt} from "../src/AICourt.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";
import {MockFlakyERC20} from "../test-helpers/MockFlakyERC20.sol";

/// @dev Fee credits (_payOrCredit) and claimFee. Token can revert (`blocked`) or return false (`soft`).
contract AICourtCreditTest is AICourtTestBase {
    MockFlakyERC20 internal tok;

    function _deployUsdc() internal override returns (MockERC20) {
        tok = new MockFlakyERC20("Mock USDC", "mUSDC", 6);
        return tok;
    }

    /// @dev closed case appealed by `by`, jury decided `band` with `maj`.
    function _appealedDecided(address by, uint8 band, address[] memory maj) internal returns (uint256 id) {
        id = _closed();
        _appealBy(id, by);
        _decide(id, band, maj);
    }

    function _sumClaimable(address[] memory a) internal view returns (uint256 s) {
        for (uint256 i = 0; i < a.length; ++i) {
            s += court.claimable(a[i]);
        }
    }

    // ------------------------------------------------------------ juror credits

    function test_FalseReturningTransferIsCreditedNotReverted() public {
        address[] memory js = _jurors(3);
        uint256 id = _appealedDecided(client, 50, js);
        tok.setSoft(js[0], true);
        uint256 share = DEFAULT_FEE / 3;
        vm.expectEmit(true, false, false, true, address(court));
        emit AICourt.FeeCredited(js[0], share);
        court.finalize(id);
        assertEq(court.getCase(id).finalBand, 50);
        assertEq(court.claimable(js[0]), share);
        assertEq(_bal(js[0]), 0);
        assertEq(_bal(js[1]), share);
        assertEq(_bal(js[2]), DEFAULT_FEE - 2 * share);
        assertEq(_bal(address(court)), court.totalClaimable());

        // soft failure on claim reverts (safeTransfer) and keeps the credit
        vm.prank(js[0]);
        vm.expectRevert();
        court.claimFee();
        assertEq(court.claimable(js[0]), share);
        assertEq(court.totalClaimable(), share);

        tok.setSoft(js[0], false);
        vm.prank(js[0]);
        court.claimFee();
        assertEq(_bal(js[0]), share);
        assertEq(_bal(address(court)), 0);
    }

    function test_RemainderMemberBlocked_CreditedWithRemainderOthersUnaffected() public {
        address[] memory js = _jurors(3);
        uint256 id = _appealedDecided(client, 80, js);
        tok.setBlocked(js[2], true);
        uint256 share = DEFAULT_FEE / 3;
        uint256 rem = DEFAULT_FEE - 2 * share; // 33_333_334
        vm.expectEmit(true, false, false, true, address(court));
        emit AICourt.FeeCredited(js[2], rem);
        court.finalize(id);
        assertEq(_bal(js[0]), share);
        assertEq(_bal(js[1]), share);
        assertEq(court.claimable(js[2]), rem);
        assertEq(court.totalClaimable(), rem);
        assertEq(_bal(address(court)), rem);
    }

    function test_AllMembersBlocked_FinalizeStillSucceeds() public {
        address[] memory js = _jurors(3);
        uint256 id = _appealedDecided(freelancer, 100, js);
        for (uint256 i = 0; i < 3; ++i) {
            tok.setBlocked(js[i], true);
        }
        court.finalize(id);
        (bool f, uint8 b) = court.finalVerdict(id);
        assertTrue(f);
        assertEq(b, 100);
        assertEq(court.totalClaimable(), DEFAULT_FEE);
        assertEq(_sumClaimable(js), DEFAULT_FEE);
        assertEq(_bal(address(court)), DEFAULT_FEE);
    }

    function test_BlockedJurorDoesNotAffectOthersPayments() public {
        address[] memory js = _jurors(5);
        uint256 id = _appealedDecided(client, 50, js);
        tok.setBlocked(js[0], true);
        tok.setBlocked(js[3], true);
        court.finalize(id);
        uint256 share = DEFAULT_FEE / 5;
        assertEq(_bal(js[1]), share);
        assertEq(_bal(js[2]), share);
        assertEq(_bal(js[4]), share); // remainder is 0 for 100e6 / 5
        assertEq(court.claimable(js[0]), share);
        assertEq(court.claimable(js[3]), share);
        assertEq(court.totalClaimable(), 2 * share);
        assertEq(_bal(address(court)), 2 * share);
    }

    // ------------------------------------------------------------ claimFee

    function test_ClaimFee_OnlyPaysCallersOwnCredit() public {
        address[] memory js = _jurors(3);
        uint256 id = _appealedDecided(client, 50, js);
        tok.setBlocked(js[1], true);
        tok.setBlocked(js[2], true);
        court.finalize(id);
        uint256 c1 = court.claimable(js[1]);
        uint256 c2 = court.claimable(js[2]);
        tok.setBlocked(js[1], false);
        tok.setBlocked(js[2], false);

        // callers without a credit cannot take anyone else's
        vm.prank(stranger);
        vm.expectRevert(AICourt.NothingToClaim.selector);
        court.claimFee();
        vm.prank(js[0]); // already paid directly, no credit
        vm.expectRevert(AICourt.NothingToClaim.selector);
        court.claimFee();

        vm.prank(js[1]);
        court.claimFee();
        assertEq(_bal(js[1]), c1);
        assertEq(_bal(js[2]), 0);
        assertEq(court.claimable(js[2]), c2);
        assertEq(court.totalClaimable(), c2);
        assertEq(_bal(address(court)), c2);
    }

    function test_ClaimFee_DoubleClaimReverts() public {
        address[] memory js = _jurors(2);
        uint256 id = _appealedDecided(client, 50, js);
        tok.setBlocked(js[0], true);
        court.finalize(id);
        tok.setBlocked(js[0], false);
        vm.startPrank(js[0]);
        court.claimFee();
        vm.expectRevert(AICourt.NothingToClaim.selector);
        court.claimFee();
        vm.stopPrank();
        assertEq(_bal(js[0]), DEFAULT_FEE / 2);
    }

    function test_ClaimFee_NoCreditReverts() public {
        vm.expectRevert(AICourt.NothingToClaim.selector);
        court.claimFee();
    }

    function test_ClaimFee_CreditsAccumulateAcrossCasesAndPayInOneClaim() public {
        address[] memory js = _jurors(2);
        tok.setBlocked(js[0], true);
        uint256 a = _appealedDecided(client, 50, js);
        court.finalize(a);
        uint256 b = _appealedDecided(freelancer, 80, js);
        court.finalize(b);
        assertEq(court.claimable(js[0]), DEFAULT_FEE); // 50e6 + 50e6
        assertEq(court.totalClaimable(), DEFAULT_FEE);
        tok.setBlocked(js[0], false);
        vm.expectEmit(true, false, false, true, address(court));
        emit AICourt.FeeClaimed(js[0], DEFAULT_FEE);
        vm.prank(js[0]);
        court.claimFee();
        assertEq(_bal(js[0]), DEFAULT_FEE);
        assertEq(court.totalClaimable(), 0);
    }

    function test_Credits_SurviveUntilClaimed() public {
        address[] memory js = _jurors(2);
        tok.setBlocked(js[0], true);
        uint256 a = _appealedDecided(client, 50, js);
        court.finalize(a);
        vm.warp(block.timestamp + 365 days);
        // unrelated settlement activity does not touch the credit
        address[] memory other = new address[](1);
        other[0] = makeAddr("other");
        uint256 b = _appealedDecided(client, 80, other);
        court.finalize(b);
        assertEq(court.claimable(js[0]), DEFAULT_FEE / 2);
        assertEq(court.totalClaimable(), DEFAULT_FEE / 2);
        assertEq(_bal(address(court)), DEFAULT_FEE / 2);
        tok.setBlocked(js[0], false);
        vm.prank(js[0]);
        court.claimFee();
        assertEq(_bal(js[0]), DEFAULT_FEE / 2);
    }

    function test_TotalClaimableEqualsSumOfCredits() public {
        address[] memory js = _jurors(3);
        address[] memory all = new address[](5);
        for (uint256 i = 0; i < 3; ++i) {
            all[i] = js[i];
        }
        all[3] = client;
        all[4] = freelancer;
        tok.setBlocked(js[0], true);
        tok.setBlocked(js[2], true);
        tok.setBlocked(client, true);
        uint256 a = _appealedDecided(client, 50, js);
        court.finalize(a);
        assertEq(court.totalClaimable(), _sumClaimable(all));
        uint256 b = _appealedDecided(client, 255, new address[](0)); // refund to blocked client
        court.finalize(b);
        assertEq(court.totalClaimable(), _sumClaimable(all));
        assertEq(court.claimable(client), DEFAULT_FEE);
        assertEq(_bal(address(court)), court.totalClaimable());

        tok.setBlocked(js[0], false);
        vm.prank(js[0]);
        court.claimFee();
        assertEq(court.totalClaimable(), _sumClaimable(all));
        assertEq(_bal(address(court)), court.totalClaimable());
    }

    // ------------------------------------------------------------ blocked appellant

    function test_BlockedAppellant_EmptyMajorityRefundCredited() public {
        uint256 id = _appealedDecided(client, 80, new address[](0)); // band 80, nobody in majority
        tok.setBlocked(client, true);
        vm.expectEmit(true, false, false, true, address(court));
        emit AICourt.FeeCredited(client, DEFAULT_FEE);
        court.finalize(id);
        assertTrue(court.getCase(id).finalized);
        assertEq(court.getCase(id).finalBand, 80);
        assertEq(court.claimable(client), DEFAULT_FEE);
        assertEq(_bal(client), PARTY_START - DEFAULT_FEE);
        assertEq(_bal(address(court)), DEFAULT_FEE);

        tok.setBlocked(client, false);
        vm.prank(client);
        court.claimFee();
        assertEq(_bal(client), PARTY_START);
        assertEq(_bal(address(court)), 0);
    }

    function test_BlockedAppellant_Band255RefundCredited() public {
        address[] memory js = _jurors(3); // majority ignored for 255
        uint256 id = _appealedDecided(freelancer, 255, js);
        tok.setBlocked(freelancer, true);
        court.finalize(id);
        AICourt.Case memory c = court.getCase(id);
        assertTrue(c.finalized);
        assertEq(c.finalBand, AI_BAND);
        assertFalse(c.byHumans);
        assertEq(court.claimable(freelancer), DEFAULT_FEE);
        assertEq(_sumBal(js), 0);
        assertEq(court.totalClaimable(), DEFAULT_FEE);
        assertEq(_bal(address(court)), DEFAULT_FEE);

        tok.setBlocked(freelancer, false);
        vm.prank(freelancer);
        court.claimFee();
        assertEq(_bal(freelancer), PARTY_START);
    }

    function test_BlockedAppellant_RescueSucceedsWithCredit() public {
        uint256 id = _closed();
        _appealBy(id, client);
        tok.setBlocked(client, true);
        vm.warp(block.timestamp + 1 days + 1);
        vm.expectEmit(true, false, false, true, address(court));
        emit AICourt.FeeCredited(client, DEFAULT_FEE);
        vm.expectEmit(true, true, false, true, address(court));
        emit AICourt.FeeRescued(id, client, DEFAULT_FEE);
        court.rescueFee(id);
        assertTrue(court.getCase(id).feeSettled);
        assertFalse(court.getCase(id).finalized);
        assertEq(court.claimable(client), DEFAULT_FEE);
        assertEq(_bal(address(court)), DEFAULT_FEE);
        vm.expectRevert(AICourt.FeeAlreadySettled.selector);
        court.rescueFee(id);

        tok.setBlocked(client, false);
        vm.prank(client);
        court.claimFee();
        assertEq(_bal(client), PARTY_START);
        assertEq(_bal(address(court)), 0);
    }

    // ------------------------------------------------------------ finalize after rescue

    function test_FinalizeAfterRescue_SetsBandAndCreditsNothing() public {
        address[] memory js = _jurors(3);
        uint256 id = _appealedDecided(client, 50, js);
        tok.setBlocked(client, true);
        for (uint256 i = 0; i < 3; ++i) {
            tok.setBlocked(js[i], true);
        }
        vm.warp(block.timestamp + 1 days + 1);
        court.rescueFee(id); // credit to blocked client
        uint256 total = court.totalClaimable();
        assertEq(total, DEFAULT_FEE);

        vm.recordLogs();
        court.finalize(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != AICourt.FeeCredited.selector);
        }
        AICourt.Case memory c = court.getCase(id);
        assertTrue(c.finalized);
        assertEq(c.finalBand, 50);
        assertTrue(c.byHumans);
        assertEq(court.totalClaimable(), total);
        assertEq(court.claimable(client), DEFAULT_FEE);
        assertEq(_sumClaimable(js), 0);
        assertEq(_bal(address(court)), DEFAULT_FEE);
    }

    // ------------------------------------------------------------ fuzz

    /// @dev For any panel size, fee and blocked subset: every member is paid or credited its
    ///      share (last gets the remainder), shares sum to the fee, and the court holds the credits.
    function testFuzz_SharesRemainderAndConservation(uint256 n, uint256 fee, uint256 mask) public {
        n = bound(n, 1, 12);
        fee = bound(fee, 1, 1e9);
        _setFee(fee);
        address[] memory js = _jurors(n);
        for (uint256 i = 0; i < n; ++i) {
            if ((mask >> i) & 1 == 1) {
                if (i % 2 == 0) tok.setBlocked(js[i], true);
                else tok.setSoft(js[i], true);
            }
        }
        uint256 id = _appealedDecided(client, 100, js);
        assertEq(court.getCase(id).feePaid, fee);
        court.finalize(id);

        uint256 share = fee / n;
        uint256 credited;
        for (uint256 i = 0; i < n; ++i) {
            uint256 expected = i == n - 1 ? fee - share * (n - 1) : share;
            if ((mask >> i) & 1 == 1) {
                assertEq(court.claimable(js[i]), expected);
                assertEq(_bal(js[i]), 0);
                credited += expected;
            } else {
                assertEq(_bal(js[i]), expected);
                assertEq(court.claimable(js[i]), 0);
            }
        }
        assertEq(court.totalClaimable(), credited);
        assertEq(_bal(address(court)), credited);
        assertEq(court.getCase(id).finalBand, 100);
    }
}
