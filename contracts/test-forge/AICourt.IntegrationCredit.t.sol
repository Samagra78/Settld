// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AICourt} from "../src/AICourt.sol";
import {ClauseEscrow} from "../src/ClauseEscrow.sol";
import {MockBlacklistERC20} from "../test-helpers/MockBlacklistERC20.sol";
import {MockJurorRegistry} from "../test-helpers/MockJurorRegistry.sol";

/// @dev Real ClauseEscrow + real AICourt: a blocked juror/appellant no longer stops the
///      court verdict from reaching ClauseEscrow.resolveDispute.
contract AICourtIntegrationCreditTest is Test {
    ClauseEscrow internal escrow;
    AICourt internal court;
    MockBlacklistERC20 internal usdc;
    MockJurorRegistry internal jury;

    address internal forwarder = makeAddr("forwarder");
    address internal owner = makeAddr("owner");
    address internal brand = makeAddr("brand");
    address internal creator = makeAddr("creator");

    uint256 internal constant START = 10_000e6;
    uint256 internal constant A0 = 1_000e6;
    uint256 internal constant A1 = 500e6;
    uint256 internal constant FEE = 100e6;

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockBlacklistERC20("Mock USDC", "mUSDC", 6);
        escrow = new ClauseEscrow(forwarder, address(usdc), owner);
        court = new AICourt(forwarder, address(usdc), address(escrow), owner);
        jury = new MockJurorRegistry();
        vm.startPrank(owner);
        escrow.setCourt(address(court));
        court.setJury(address(jury));
        vm.stopPrank();

        usdc.mint(brand, START);
        usdc.mint(creator, START);
        vm.prank(brand);
        usdc.approve(address(escrow), type(uint256).max);
        vm.prank(brand);
        usdc.approve(address(court), type(uint256).max);
        vm.prank(creator);
        usdc.approve(address(court), type(uint256).max);
    }

    function _escrowReport(uint8 kind, uint256 dealId, uint8 clauseId, bytes32 data) internal {
        bytes memory r = abi.encode(kind, dealId, clauseId, uint8(1), data, uint64(0), uint64(block.timestamp));
        vm.prank(forwarder);
        escrow.onReport("", r);
    }

    function _verifiedDeal() internal returns (uint256 dealId) {
        ClauseEscrow.ClauseTerms[] memory t = new ClauseEscrow.ClauseTerms[](2);
        uint256[2] memory amts = [A0, A1];
        for (uint256 i = 0; i < 2; ++i) {
            t[i] = ClauseEscrow.ClauseTerms({
                kind: 0,
                checkType: 1,
                param: "p",
                deadline: uint64(block.timestamp + 7 days),
                amount: amts[i],
                dependsOn: 255,
                onFail: 0,
                vestDays: 0
            });
        }
        vm.prank(brand);
        dealId = escrow.proposeDeal(creator, A0 + A1, t);
        vm.prank(creator);
        escrow.acceptDeal(dealId);
        _escrowReport(0, dealId, 0, escrow.getDeal(dealId).specHash);
        vm.prank(brand);
        escrow.fundDeal(dealId);
        for (uint8 c = 0; c < 2; ++c) {
            vm.prank(creator);
            escrow.submitEvidence(dealId, c, "video");
            _escrowReport(1, dealId, c, bytes32(0));
        }
    }

    function _courtReport(uint8 round, uint16[3] memory words, bool[3] memory ext, bool[3] memory fin) internal {
        bytes memory r = abi.encode(
            uint8(6), uint256(1), round, [uint8(50), 100, 80], words, ext, fin, [uint8(1), 2, 4], keccak256(abi.encode("t", round))
        );
        vm.prank(forwarder);
        court.onReport("", r);
    }

    /// @dev dispute clause 0 and close case 1 with AI band 80.
    function _disputedAndClosed() internal returns (uint256 dealId) {
        dealId = _verifiedDeal();
        vm.prank(brand);
        escrow.dispute(dealId, 0, "reason");
        _courtReport(0, [uint16(150), 170, 160], [true, true, false], [false, false, false]);
        _courtReport(1, [uint16(190), 210, 200], [false, false, false], [true, true, true]);
        court.closeCase(1);
        assertEq(court.getCase(1).aiBand, 80);
    }

    function _members(uint256 n) internal pure returns (address[] memory m) {
        m = new address[](n);
        for (uint256 i = 0; i < n; ++i) {
            m[i] = address(uint160(0xBEE0 + i));
        }
    }

    function test_BlockedJuror_VerdictStillReachesEscrow_Band50() public {
        uint256 dealId = _disputedAndClosed();
        vm.prank(creator);
        court.appeal(1);
        address[] memory maj = _members(3);
        jury.setDecision(1, true, 50, maj);
        usdc.setBlacklisted(maj[1], true);

        court.finalize(1); // previously reverted with Blacklisted
        (bool f, uint8 b) = court.finalVerdict(1);
        assertTrue(f);
        assertEq(b, 50);
        assertEq(court.claimable(maj[1]), 33_333_333);

        uint256 brandBefore = usdc.balanceOf(brand);
        uint256 creatorBefore = usdc.balanceOf(creator);
        escrow.resolveDispute(dealId, 0);
        assertEq(usdc.balanceOf(creator), creatorBefore + 500e6);
        assertEq(usdc.balanceOf(brand), brandBefore + 500e6);
        assertEq(escrow.getClause(dealId, 0).status, escrow.Released());
        assertEq(usdc.balanceOf(address(escrow)), A1);

        // court holds only the blocked juror's credit; it is claimable after unblocking
        assertEq(usdc.balanceOf(address(court)), court.totalClaimable());
        usdc.setBlacklisted(maj[1], false);
        vm.prank(maj[1]);
        court.claimFee();
        assertEq(usdc.balanceOf(maj[1]), 33_333_333);
        assertEq(usdc.balanceOf(address(court)), 0);
    }

    function test_BlockedAppellant_Band255_EscrowPaysByAiBand() public {
        uint256 dealId = _disputedAndClosed();
        vm.prank(brand);
        court.appeal(1);
        jury.setDecision(1, true, 255, new address[](0));
        usdc.setBlacklisted(brand, true);

        court.finalize(1);
        (bool f, uint8 b) = court.finalVerdict(1);
        assertTrue(f);
        assertEq(b, 80);
        assertEq(court.claimable(brand), FEE);

        // the verdict was not blocked; unblock the brand so escrow can push its 20% share
        usdc.setBlacklisted(brand, false);
        uint256 brandBefore = usdc.balanceOf(brand);
        uint256 creatorBefore = usdc.balanceOf(creator);
        escrow.resolveDispute(dealId, 0);
        assertEq(usdc.balanceOf(creator), creatorBefore + 800e6);
        assertEq(usdc.balanceOf(brand), brandBefore + 200e6);

        vm.prank(brand);
        court.claimFee();
        assertEq(usdc.balanceOf(brand), brandBefore + 200e6 + FEE);
        assertEq(usdc.balanceOf(address(court)), 0);
    }

    function test_BlockedRescuedAppellant_FinalizeSetsBandAndEscrowResolves() public {
        uint256 dealId = _disputedAndClosed();
        vm.prank(creator);
        court.appeal(1);
        address[] memory maj = _members(2);
        jury.setDecision(1, true, 100, maj);
        usdc.setBlacklisted(creator, true);
        vm.warp(block.timestamp + 1 days + 1);
        court.rescueFee(1); // credit to blocked creator
        assertEq(court.claimable(creator), FEE);

        court.finalize(1);
        (bool f, uint8 b) = court.finalVerdict(1);
        assertTrue(f);
        assertEq(b, 100);
        assertEq(usdc.balanceOf(maj[0]) + usdc.balanceOf(maj[1]), 0); // fee already rescued

        uint256 brandBefore = usdc.balanceOf(brand);
        usdc.setBlacklisted(creator, false);
        uint256 creatorBefore = usdc.balanceOf(creator);
        escrow.resolveDispute(dealId, 0);
        assertEq(usdc.balanceOf(creator), creatorBefore + A0);
        assertEq(usdc.balanceOf(brand), brandBefore);
    }
}
