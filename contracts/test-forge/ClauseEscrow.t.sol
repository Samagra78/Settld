// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ClauseEscrow} from "../src/ClauseEscrow.sol";
import {ReceiverTemplate} from "../src/cre/ReceiverTemplate.sol";
import {ClauseEscrowTestBase} from "./ClauseEscrow.Base.t.sol";

/// @dev Deployment, propose, accept, fund, certification, report auth, evidence, views.
contract ClauseEscrowTest is ClauseEscrowTestBase {
    // ------------------------------------------------------------ constructor

    function test_Constructor_SetsState() public view {
        assertEq(escrow.usdc(), address(usdc));
        assertEq(escrow.getForwarderAddress(), forwarder);
        assertEq(escrow.owner(), owner);
        assertEq(escrow.dealCount(), 0);
    }

    function test_Constructor_RejectsZeroForwarder() public {
        vm.expectRevert(ReceiverTemplate.InvalidForwarderAddress.selector);
        new ClauseEscrow(address(0), address(usdc), owner);
    }

    function test_Constructor_RejectsZeroUsdc() public {
        vm.expectRevert(ClauseEscrow.ZeroUSDC.selector);
        new ClauseEscrow(forwarder, address(0), owner);
    }

    // ------------------------------------------------------------ proposeDeal

    function test_Propose_SpecHashAndGetDeal() public {
        ClauseEscrow.ClauseTerms[] memory t = _mk(3);
        uint256 id = _propose(t);
        assertEq(id, 1);
        ClauseEscrow.Deal memory d = escrow.getDeal(id);
        assertEq(d.specHash, keccak256(abi.encode(t)));
        assertEq(d.brand, brand);
        assertEq(d.creator, creator);
        assertEq(d.token, address(usdc));
        assertEq(d.total, 600e6);
        assertFalse(d.accepted);
        assertFalse(d.funded);
        assertFalse(escrow.certified(id));
    }

    function test_Propose_IdsStartAtOneAndDealCountIncrements() public {
        assertEq(escrow.dealCount(), 0);
        assertEq(_propose(_mk(1)), 1);
        assertEq(escrow.dealCount(), 1);
        assertEq(_propose(_mk(2)), 2);
        assertEq(_propose(_mk(5)), 3);
        assertEq(escrow.dealCount(), 3);
    }

    function test_Propose_DifferentTermsDifferentHash() public {
        uint256 a = _propose(_mk(2));
        ClauseEscrow.ClauseTerms[] memory t = _mk(2);
        t[0].param = "other";
        uint256 b = _propose(t);
        assertNotEq(_specHash(a), _specHash(b));
        assertEq(_specHash(b), keccak256(abi.encode(t)));
    }

    function test_Propose_EmitsDealProposed() public {
        ClauseEscrow.ClauseTerms[] memory t = _mk(2);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit ClauseEscrow.DealProposed(1, brand, creator, keccak256(abi.encode(t)));
        _propose(t);
    }

    function test_Propose_StoresClausesInitialState() public {
        ClauseEscrow.ClauseTerms[] memory t = _mk(3);
        t[1].dependsOn = 0;
        t[2].dependsOn = 1;
        t[2].vestDays = 30;
        t[2].onFail = 2;
        uint256 id = _propose(t);
        assertEq(escrow.clauseCount(id), 3);
        ClauseEscrow.Clause[] memory cs = escrow.getClauses(id);
        assertEq(cs.length, 3);
        for (uint256 i = 0; i < 3; i++) {
            assertEq(cs[i].kind, t[i].kind);
            assertEq(cs[i].checkType, t[i].checkType);
            assertEq(cs[i].param, t[i].param);
            assertEq(cs[i].deadline, t[i].deadline);
            assertEq(cs[i].amount, t[i].amount);
            assertEq(cs[i].dependsOn, t[i].dependsOn);
            assertEq(cs[i].onFail, t[i].onFail);
            assertEq(cs[i].vestDays, t[i].vestDays);
            assertEq(cs[i].daysVested, 0);
            assertEq(cs[i].status, PENDING);
            assertEq(cs[i].verifiedAt, 0);
            ClauseEscrow.Clause memory one = escrow.getClause(id, uint8(i));
            assertEq(one.amount, cs[i].amount);
            assertEq(one.dependsOn, cs[i].dependsOn);
        }
    }

    function test_Propose_NoFundsMove() public {
        _propose(_mk(2));
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(usdc.balanceOf(brand), BRAND_START);
    }

    function test_Propose_RevertsCreatorZero() public {
        ClauseEscrow.ClauseTerms[] memory t = _mk(1);
        vm.prank(brand);
        vm.expectRevert(ClauseEscrow.InvalidCreator.selector);
        escrow.proposeDeal(address(0), 100e6, t);
    }

    function test_Propose_RevertsCreatorIsSelf() public {
        ClauseEscrow.ClauseTerms[] memory t = _mk(1);
        vm.prank(brand);
        vm.expectRevert(ClauseEscrow.InvalidCreator.selector);
        escrow.proposeDeal(brand, 100e6, t);
    }

    function test_Propose_RevertsZeroClauses() public {
        ClauseEscrow.ClauseTerms[] memory t = new ClauseEscrow.ClauseTerms[](0);
        vm.prank(brand);
        vm.expectRevert(ClauseEscrow.InvalidClauseCount.selector);
        escrow.proposeDeal(creator, 0, t);
    }

    function test_Propose_RevertsSixClauses() public {
        ClauseEscrow.ClauseTerms[] memory t = _mk(6);
        vm.prank(brand);
        vm.expectRevert(ClauseEscrow.InvalidClauseCount.selector);
        escrow.proposeDeal(creator, _total(t), t);
    }

    function test_Propose_FiveClausesAllowed() public {
        assertEq(escrow.clauseCount(_propose(_mk(5))), 5);
    }

    function test_Propose_RevertsZeroAmount() public {
        ClauseEscrow.ClauseTerms[] memory t = _mk(3);
        t[2].amount = 0;
        vm.prank(brand);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.ZeroClauseAmount.selector, uint8(2)));
        escrow.proposeDeal(creator, _total(t), t);
    }

    function test_Propose_RevertsTotalMismatch() public {
        ClauseEscrow.ClauseTerms[] memory t = _mk(2);
        vm.startPrank(brand);
        vm.expectRevert(ClauseEscrow.TotalMismatch.selector);
        escrow.proposeDeal(creator, _total(t) + 1, t);
        vm.expectRevert(ClauseEscrow.TotalMismatch.selector);
        escrow.proposeDeal(creator, _total(t) - 1, t);
        vm.stopPrank();
    }

    function test_Propose_RevertsSelfDependency() public {
        ClauseEscrow.ClauseTerms[] memory t = _mk(3);
        t[1].dependsOn = 1;
        vm.prank(brand);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidDependency.selector, uint8(1), uint8(1)));
        escrow.proposeDeal(creator, _total(t), t);
    }

    function test_Propose_RevertsForwardDependency() public {
        ClauseEscrow.ClauseTerms[] memory t = _mk(3);
        t[0].dependsOn = 2;
        vm.prank(brand);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidDependency.selector, uint8(0), uint8(2)));
        escrow.proposeDeal(creator, _total(t), t);
    }

    function test_Propose_RevertsFirstClauseDependsOnZero() public {
        ClauseEscrow.ClauseTerms[] memory t = _mk(2);
        t[0].dependsOn = 0;
        vm.prank(brand);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidDependency.selector, uint8(0), uint8(0)));
        escrow.proposeDeal(creator, _total(t), t);
    }

    function test_Propose_RevertsDependencyOutOfRange() public {
        ClauseEscrow.ClauseTerms[] memory t = _mk(2);
        t[1].dependsOn = 7;
        vm.prank(brand);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.InvalidDependency.selector, uint8(1), uint8(7)));
        escrow.proposeDeal(creator, _total(t), t);
    }

    function test_Propose_BackwardDependencyAccepted() public {
        ClauseEscrow.ClauseTerms[] memory t = _mk(3);
        t[1].dependsOn = 0;
        t[2].dependsOn = 0;
        assertEq(escrow.getClause(_propose(t), 2).dependsOn, 0);
    }

    // ------------------------------------------------------------------ views

    function test_Views_UnknownDealReverts() public {
        _propose(_mk(1));
        uint256[2] memory bad = [uint256(0), 2];
        for (uint256 i = 0; i < 2; i++) {
            bytes memory err = abi.encodeWithSelector(ClauseEscrow.UnknownDeal.selector, bad[i]);
            vm.expectRevert(err);
            escrow.getDeal(bad[i]);
            vm.expectRevert(err);
            escrow.getClause(bad[i], 0);
            vm.expectRevert(err);
            escrow.getClauses(bad[i]);
            vm.expectRevert(err);
            escrow.clauseCount(bad[i]);
        }
    }

    function test_Views_UnknownClauseReverts() public {
        uint256 id = _propose(_mk(2));
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.UnknownClause.selector, id, uint8(2)));
        escrow.getClause(id, 2);
    }

    // ------------------------------------------------------------- acceptDeal

    function test_Accept_ByCreator() public {
        uint256 id = _propose(_mk(1));
        vm.expectEmit(true, false, false, false, address(escrow));
        emit ClauseEscrow.DealAccepted(id);
        _accept(id);
        assertTrue(escrow.getDeal(id).accepted);
    }

    function test_Accept_RevertsNonCreator() public {
        uint256 id = _propose(_mk(1));
        vm.prank(brand);
        vm.expectRevert(ClauseEscrow.NotCreator.selector);
        escrow.acceptDeal(id);
        vm.prank(stranger);
        vm.expectRevert(ClauseEscrow.NotCreator.selector);
        escrow.acceptDeal(id);
    }

    function test_Accept_RevertsTwice() public {
        uint256 id = _propose(_mk(1));
        _accept(id);
        vm.prank(creator);
        vm.expectRevert(ClauseEscrow.AlreadyAccepted.selector);
        escrow.acceptDeal(id);
    }

    function test_Accept_RevertsAfterFunded() public {
        uint256 id = _funded(_mk(1));
        vm.prank(creator);
        vm.expectRevert(ClauseEscrow.AlreadyFunded.selector);
        escrow.acceptDeal(id);
    }

    function test_Accept_RevertsUnknownDeal() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.UnknownDeal.selector, uint256(1)));
        escrow.acceptDeal(1);
    }

    // --------------------------------------------------------------- fundDeal

    function test_Fund_RevertsBeforeAccepted() public {
        uint256 id = _propose(_mk(1));
        _certify(id); // certified but not accepted
        vm.prank(brand);
        vm.expectRevert(ClauseEscrow.NotAccepted.selector);
        escrow.fundDeal(id);
    }

    function test_Fund_RevertsBeforeCertified() public {
        uint256 id = _propose(_mk(1));
        _accept(id); // accepted but not certified
        vm.prank(brand);
        vm.expectRevert(ClauseEscrow.NotCertified.selector);
        escrow.fundDeal(id);
    }

    function test_Fund_RevertsNonBrand() public {
        uint256 id = _propose(_mk(1));
        _accept(id);
        _certify(id);
        vm.prank(creator);
        vm.expectRevert(ClauseEscrow.NotBrand.selector);
        escrow.fundDeal(id);
        vm.prank(stranger);
        vm.expectRevert(ClauseEscrow.NotBrand.selector);
        escrow.fundDeal(id);
    }

    function test_Fund_NonBrandRefusedEvenWhenNotReady() public {
        uint256 id = _propose(_mk(1));
        vm.prank(stranger);
        vm.expectRevert(ClauseEscrow.NotBrand.selector);
        escrow.fundDeal(id);
    }

    function test_Fund_RevertsTwice() public {
        uint256 id = _funded(_mk(1));
        vm.prank(brand);
        vm.expectRevert(ClauseEscrow.AlreadyFunded.selector);
        escrow.fundDeal(id);
    }

    function test_Fund_HappyPathMovesTotalAndEmits() public {
        ClauseEscrow.ClauseTerms[] memory t = _mk(3);
        uint256 id = _propose(t);
        _accept(id);
        _certify(id);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit ClauseEscrow.DealFunded(id, 600e6);
        _fund(id);
        assertTrue(escrow.getDeal(id).funded);
        assertEq(usdc.balanceOf(address(escrow)), 600e6);
        assertEq(usdc.balanceOf(brand), BRAND_START - 600e6);
    }

    function test_Fund_RevertsWithoutAllowance() public {
        uint256 id = _propose(_mk(1));
        _accept(id);
        _certify(id);
        vm.prank(brand);
        usdc.approve(address(escrow), 0);
        vm.prank(brand);
        vm.expectRevert();
        escrow.fundDeal(id);
        assertFalse(escrow.getDeal(id).funded);
    }

    function test_Fund_CertifyAndAcceptOrderIrrelevant() public {
        uint256 id = _propose(_mk(1));
        _certify(id);
        _accept(id);
        _fund(id);
        assertTrue(escrow.getDeal(id).funded);
    }

    // ---------------------------------------------------------- certification

    function test_Certify_Happy() public {
        uint256 id = _propose(_mk(2));
        vm.expectEmit(true, false, false, false, address(escrow));
        emit ClauseEscrow.DealCertified(id);
        _certify(id);
        assertTrue(escrow.certified(id));
    }

    function test_Certify_WrongSpecHashRejected() public {
        uint256 id = _propose(_mk(2));
        bytes memory r = _reportBytes(0, id, 0, bytes32(uint256(1234)));
        vm.prank(forwarder);
        vm.expectRevert(ClauseEscrow.SpecHashMismatch.selector);
        escrow.onReport("", r);
        assertFalse(escrow.certified(id));
    }

    function test_Certify_HashOfOtherDealRejected() public {
        ClauseEscrow.ClauseTerms[] memory t = _mk(2);
        uint256 a = _propose(t);
        t[0].param = "different";
        uint256 b = _propose(t);
        bytes memory r = _reportBytes(0, a, 0, _specHash(b));
        vm.prank(forwarder);
        vm.expectRevert(ClauseEscrow.SpecHashMismatch.selector);
        escrow.onReport("", r);
    }

    function test_Certify_TwiceRejected() public {
        uint256 id = _propose(_mk(1));
        _certify(id);
        bytes memory r = _reportBytes(0, id, 0, _specHash(id));
        vm.prank(forwarder);
        vm.expectRevert(ClauseEscrow.AlreadyCertified.selector);
        escrow.onReport("", r);
    }

    function test_Certify_AfterFundingRejected() public {
        uint256 id = _funded(_mk(1));
        bytes memory r = _reportBytes(0, id, 0, _specHash(id));
        vm.prank(forwarder);
        vm.expectRevert(ClauseEscrow.AlreadyFunded.selector);
        escrow.onReport("", r);
    }

    function test_Report_UnknownDealRejected() public {
        bytes memory r = _reportBytes(0, 99, 0, bytes32(0));
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(ClauseEscrow.UnknownDeal.selector, uint256(99)));
        escrow.onReport("", r);
    }

    // ----------------------------------------------------- report authorization

    function testFuzz_Report_NonForwarderRejected(address caller) public {
        vm.assume(caller != forwarder);
        uint256 id = _propose(_mk(1));
        bytes memory r = _reportBytes(0, id, 0, _specHash(id));
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidSender.selector, caller, forwarder));
        escrow.onReport("", r);
        assertFalse(escrow.certified(id));
    }

    function test_Report_OwnerAndBrandAreNotForwarders() public {
        uint256 id = _propose(_mk(1));
        bytes memory r = _reportBytes(0, id, 0, _specHash(id));
        address[3] memory callers = [owner, brand, creator];
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidSender.selector, callers[i], forwarder));
            escrow.onReport("", r);
        }
    }

    function testFuzz_Report_ZeroForwarderStillRejectsEveryone(address caller) public {
        uint256 id = _propose(_mk(1));
        vm.prank(owner);
        escrow.setForwarderAddress(address(0)); // owner disables the forwarder check
        assertEq(escrow.getForwarderAddress(), address(0));
        bytes memory r = _reportBytes(0, id, 0, _specHash(id));
        vm.prank(caller);
        vm.expectRevert(ClauseEscrow.UnauthorizedReportForwarder.selector);
        escrow.onReport("", r);
        assertFalse(escrow.certified(id));
    }

    function test_Report_ZeroForwarderRejectsFormerForwarder() public {
        uint256 id = _propose(_mk(1));
        vm.prank(owner);
        escrow.setForwarderAddress(address(0));
        bytes memory r = _reportBytes(0, id, 0, _specHash(id));
        vm.prank(forwarder);
        vm.expectRevert(ClauseEscrow.UnauthorizedReportForwarder.selector);
        escrow.onReport("", r);
    }

    function test_Report_ZeroForwarderCannotSettleOrFail() public {
        uint256 id = _funded(_mk(1));
        _submit(id, 0);
        vm.prank(owner);
        escrow.setForwarderAddress(address(0));
        bytes memory r = _reportBytes(1, id, 0, bytes32(0));
        vm.prank(stranger);
        vm.expectRevert(ClauseEscrow.UnauthorizedReportForwarder.selector);
        escrow.onReport("", r);
        assertEq(_status(id, 0), SUBMITTED);
    }

    function test_Report_OwnerCanRotateForwarder() public {
        address newF = makeAddr("newF");
        vm.prank(owner);
        escrow.setForwarderAddress(newF);
        uint256 id = _propose(_mk(1));
        bytes memory r = _reportBytes(0, id, 0, _specHash(id));
        vm.prank(forwarder);
        vm.expectRevert(abi.encodeWithSelector(ReceiverTemplate.InvalidSender.selector, forwarder, newF));
        escrow.onReport("", r);
        vm.prank(newF);
        escrow.onReport("", r);
        assertTrue(escrow.certified(id));
    }

    function test_Report_NonOwnerCannotSetForwarder() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        escrow.setForwarderAddress(stranger);
    }
}
