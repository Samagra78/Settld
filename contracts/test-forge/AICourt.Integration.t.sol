// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AICourt} from "../src/AICourt.sol";
import {ClauseEscrow} from "../src/ClauseEscrow.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";
import {MockJurorRegistry} from "../test-helpers/MockJurorRegistry.sol";

/// @dev End-to-end: real ClauseEscrow using the real AICourt as its court.
contract AICourtIntegrationTest is Test {
    ClauseEscrow internal escrow;
    AICourt internal court;
    MockERC20 internal usdc;
    MockJurorRegistry internal jury;

    address internal forwarder = makeAddr("forwarder");
    address internal owner = makeAddr("owner");
    address internal brand = makeAddr("brand");
    address internal creator = makeAddr("creator");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant T0 = 1_700_000_000;
    uint256 internal constant START = 10_000e6;
    uint256 internal constant A0 = 1_000e6;
    uint256 internal constant A1 = 500e6;

    function setUp() public {
        vm.warp(T0);
        usdc = new MockERC20("Mock USDC", "mUSDC", 6);
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

    // ------------------------------------------------------------ helpers

    function _terms() internal view returns (ClauseEscrow.ClauseTerms[] memory t) {
        t = new ClauseEscrow.ClauseTerms[](2);
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
    }

    function _escrowReport(uint8 kind, uint256 dealId, uint8 clauseId, bytes32 data) internal {
        bytes memory r = abi.encode(kind, dealId, clauseId, uint8(1), data, uint64(0), uint64(block.timestamp));
        vm.prank(forwarder);
        escrow.onReport("", r);
    }

    /// @dev propose/accept/certify/fund a 2-clause deal, submit + verify both clauses (kind 1 reports).
    function _verifiedDeal() internal returns (uint256 dealId) {
        ClauseEscrow.ClauseTerms[] memory t = _terms();
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

    function _courtReport(uint256 caseId, uint8 round, uint8[3] memory bands, uint16[3] memory words, bool[3] memory ext, bool[3] memory fin)
        internal
    {
        bytes memory r = abi.encode(
            uint8(6), caseId, round, bands, words, ext, fin, [uint8(1), 2, 4], keccak256(abi.encode("t", caseId, round))
        );
        vm.prank(forwarder);
        court.onReport("", r);
    }

    /// @dev WF3-shaped transcript for a case; ends with the AI verdict set (band 80).
    function _runWf3AndClose(uint256 caseId) internal {
        _courtReport(
            caseId, 0, [uint8(50), 100, 80], [uint16(150), 170, 160], [true, true, false], [false, false, false]
        );
        _courtReport(
            caseId, 1, [uint8(50), 100, 80], [uint16(190), 210, 200], [false, false, false], [true, true, true]
        );
        court.closeCase(caseId);
    }

    // ------------------------------------------------------------ tests

    function test_Dispute_EscrowOpensCaseWithIdOne() public {
        uint256 dealId = _verifiedDeal();
        vm.expectEmit(true, false, false, true, address(court));
        emit AICourt.CaseOpened(1, dealId, 0, "not as agreed", uint64(block.timestamp + 180));
        vm.prank(brand);
        escrow.dispute(dealId, 0, "not as agreed");

        assertEq(escrow.caseOf(dealId, 0), 1);
        assertEq(court.caseCount(), 1);
        AICourt.Case memory c = court.getCase(1);
        assertEq(c.dealId, dealId);
        assertEq(c.clauseId, 0);
        assertEq(c.client, brand);
        assertEq(c.freelancer, creator);
        assertEq(escrow.getClause(dealId, 0).status, escrow.Disputed());
        // the court reads the real clause amount through IClauseEscrowView
        assertEq(court.appealFee(1), A0 / 10);
    }

    function test_Dispute_CannotOpenCaseDirectly() public {
        vm.prank(brand);
        vm.expectRevert(AICourt.NotEscrow.selector);
        court.openCase(1, 0, brand, creator, "x");
    }

    function test_E2E_UnappealedBand80PaysCreator80Brand20() public {
        uint256 dealId = _verifiedDeal();
        vm.prank(brand);
        escrow.dispute(dealId, 0, "reason");
        uint256 disputedAt = block.timestamp;
        _runWf3AndClose(1);
        assertEq(court.getCase(1).aiBand, 80);

        // not resolvable yet: the court verdict is not final
        vm.expectRevert(ClauseEscrow.CaseNotResolved.selector);
        escrow.resolveDispute(dealId, 0);

        // appeal window still open
        vm.expectRevert(AICourt.AppealWindowOpen.selector);
        court.finalize(1);
        vm.warp(uint256(court.getCase(1).appealDeadline) + 1);
        court.finalize(1);
        (bool f, uint8 b) = court.finalVerdict(1);
        assertTrue(f);
        assertEq(b, 80);

        // escape hatch is shut once the court verdict is final
        vm.warp(disputedAt + 1 days);
        vm.expectRevert(ClauseEscrow.CaseAlreadyFinal.selector);
        escrow.resolveStuckDispute(dealId, 0);

        uint256 brandBefore = usdc.balanceOf(brand);
        uint256 creatorBefore = usdc.balanceOf(creator);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.ClauseSplit(dealId, 0, 800e6, 200e6);
        vm.prank(stranger);
        escrow.resolveDispute(dealId, 0);

        assertEq(usdc.balanceOf(creator), creatorBefore + 800e6);
        assertEq(usdc.balanceOf(brand), brandBefore + 200e6);
        assertEq(escrow.getClause(dealId, 0).status, escrow.Released());
        assertEq(usdc.balanceOf(address(escrow)), A1); // clause 1 still held
        assertEq(usdc.balanceOf(address(court)), 0);

        // already settled
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidClauseStatus.selector, escrow.Released()));
        escrow.resolveDispute(dealId, 0);
    }

    function test_E2E_AppealedJuryOverridesAiAndPaysJurors() public {
        uint256 dealId = _verifiedDeal();
        vm.prank(brand);
        escrow.dispute(dealId, 0, "r0");
        vm.prank(creator);
        escrow.dispute(dealId, 1, "r1");
        assertEq(escrow.caseOf(dealId, 1), 2);
        _runWf3AndClose(2); // AI band 80 for the 500e6 clause

        uint256 fee = A1 / 10; // 50e6
        uint256 brandBefore = usdc.balanceOf(brand);
        uint256 creatorBefore = usdc.balanceOf(creator);
        vm.expectEmit(true, false, false, true, address(court));
        emit AICourt.Appealed(2, brand, fee);
        vm.prank(brand);
        court.appeal(2);
        assertEq(usdc.balanceOf(brand), brandBefore - fee);
        assertEq(usdc.balanceOf(address(court)), fee);
        MockJurorRegistry.PanelCall memory p = jury.panelCall(0);
        assertEq(p.caseId, 2);
        assertEq(p.client, brand);
        assertEq(p.freelancer, creator);

        // jury not decided -> court cannot finalize, escrow cannot resolve
        vm.expectRevert(AICourt.JuryNotDecided.selector);
        court.finalize(2);
        vm.expectRevert(ClauseEscrow.CaseNotResolved.selector);
        escrow.resolveDispute(dealId, 1);

        address j1 = makeAddr("juror1");
        address j2 = makeAddr("juror2");
        address[] memory maj = new address[](2);
        maj[0] = j1;
        maj[1] = j2;
        jury.setDecision(2, true, 0, maj);
        court.finalize(2);
        assertEq(usdc.balanceOf(j1), fee / 2);
        assertEq(usdc.balanceOf(j2), fee / 2);
        assertEq(usdc.balanceOf(address(court)), 0);
        (bool f, uint8 b) = court.finalVerdict(2);
        assertTrue(f);
        assertEq(b, 0);

        // jury said 0% -> brand gets the whole clause back (clause amount 500e6)
        escrow.resolveDispute(dealId, 1);
        assertEq(usdc.balanceOf(brand), brandBefore - fee + A1);
        assertEq(usdc.balanceOf(creator), creatorBefore);
        assertEq(escrow.getClause(dealId, 1).status, escrow.Refunded());

        // case 1 is independent and still open/unfinal
        (bool f1,) = court.finalVerdict(1);
        assertFalse(f1);
        assertEq(escrow.getClause(dealId, 0).status, escrow.Disputed());
    }

    function test_E2E_AppealedBand50Split() public {
        uint256 dealId = _verifiedDeal();
        vm.prank(brand);
        escrow.dispute(dealId, 0, "r0");
        _runWf3AndClose(1);
        vm.prank(creator);
        court.appeal(1);
        address[] memory maj = new address[](3);
        for (uint256 i = 0; i < 3; ++i) {
            maj[i] = address(uint160(0xBEE0 + i));
        }
        jury.setDecision(1, true, 50, maj);
        uint256 creatorBefore = usdc.balanceOf(creator);
        court.finalize(1);
        // fee 100e6 over 3 jurors: 33_333_333, 33_333_333, 33_333_334
        assertEq(usdc.balanceOf(maj[0]), 33_333_333);
        assertEq(usdc.balanceOf(maj[2]), 33_333_334);
        assertEq(creatorBefore, START - 100e6);

        uint256 brandBefore = usdc.balanceOf(brand);
        escrow.resolveDispute(dealId, 0);
        assertEq(usdc.balanceOf(creator), creatorBefore + 500e6);
        assertEq(usdc.balanceOf(brand), brandBefore + 500e6);
    }

    function test_E2E_NoCourtReportsEscapeStillWorksAfterOneDay() public {
        uint256 dealId = _verifiedDeal();
        vm.prank(brand);
        escrow.dispute(dealId, 0, "r");
        uint256 disputedAt = block.timestamp;
        // no round is ever reported: the court cannot close or finalize
        vm.warp(disputedAt + 1 hours);
        vm.expectRevert(AICourt.NoRoundReported.selector);
        court.closeCase(1);
        vm.expectRevert(AICourt.NoAiVerdict.selector);
        court.finalize(1);
        vm.expectRevert(ClauseEscrow.EscapeNotReached.selector);
        escrow.resolveStuckDispute(dealId, 0);

        vm.warp(disputedAt + 1 days);
        uint256 creatorBefore = usdc.balanceOf(creator);
        escrow.resolveStuckDispute(dealId, 0); // original verdict of a Verified clause = 100%
        assertEq(usdc.balanceOf(creator), creatorBefore + A0);
    }
}
