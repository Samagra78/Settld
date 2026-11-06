// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AICourt} from "../src/AICourt.sol";
import {MockFlakyERC20} from "../test-helpers/MockFlakyERC20.sol";
import {MockEscrowView} from "../test-helpers/MockEscrowView.sol";
import {MockJurorRegistry} from "../test-helpers/MockJurorRegistry.sol";

/// @dev Drives open/close/appeal/decide/finalize/rescue/time-warp and tracks fee flows.
contract AICourtHandler is Test {
    AICourt public court;
    MockFlakyERC20 public usdc;
    MockEscrowView public escrowMock;
    MockJurorRegistry public jury;
    address public forwarder;
    address public client;
    address public freelancer;

    uint256 public constant MAX_CASES = 12;
    uint256 public violations;
    uint256 public ghostIn;
    uint256 public ghostOut;
    uint256 public appealsMade;
    uint256 public finalizes;
    uint256 public rescues;
    uint256 public claims;
    uint256 public credits;
    uint256 public claimedOut;
    mapping(uint256 => uint256) public paidOut;

    constructor(
        AICourt court_,
        MockFlakyERC20 usdc_,
        MockEscrowView escrowMock_,
        MockJurorRegistry jury_,
        address forwarder_,
        address client_,
        address freelancer_
    ) {
        court = court_;
        usdc = usdc_;
        escrowMock = escrowMock_;
        jury = jury_;
        forwarder = forwarder_;
        client = client_;
        freelancer = freelancer_;
    }

    function _pick(uint256 seed) internal view returns (uint256) {
        return bound(seed, 1, court.caseCount());
    }

    function openAndClose(uint256 amountSeed, uint256 bandSeed) external {
        if (court.caseCount() >= MAX_CASES) return;
        uint8[4] memory vals = [0, 50, 80, 100];
        uint8[3] memory bands = [vals[bandSeed % 4], vals[(bandSeed / 4) % 4], vals[(bandSeed / 16) % 4]];
        escrowMock.setAmount(bound(amountSeed, 0, 20_000e6));
        uint256 id = escrowMock.callOpenCase(1, 0, client, freelancer, "r");
        bytes memory rep = abi.encode(
            uint8(6), id, uint8(0), bands, [uint16(1), 1, 1], [false, false, false], [false, false, false],
            [uint8(0), 0, 0], bytes32(0)
        );
        vm.prank(forwarder);
        court.onReport("", rep);
        vm.warp(uint256(court.getCase(id).deadline) + 1);
        court.closeCase(id);
    }

    function appeal(uint256 idSeed, bool byClient) external {
        if (court.caseCount() == 0) return;
        uint256 id = _pick(idSeed);
        address who = byClient ? client : freelancer;
        usdc.mint(who, 30_000e6);
        uint256 before_ = usdc.balanceOf(address(court));
        vm.prank(who);
        court.appeal(id);
        uint256 delta = usdc.balanceOf(address(court)) - before_;
        if (delta != court.getCase(id).feePaid) ++violations;
        ghostIn += delta;
        ++appealsMade;
    }

    function decide(uint256 idSeed, uint256 bandSeed, uint256 n) external {
        if (court.caseCount() == 0) return;
        uint256 id = _pick(idSeed);
        uint8[6] memory vals = [0, 50, 80, 100, 255, 30];
        n = bound(n, 0, 7);
        address[] memory m = new address[](n);
        for (uint256 i = 0; i < n; ++i) {
            m[i] = address(uint160(0xA11CE0 + i));
        }
        jury.setDecision(id, bandSeed % 5 != 0, vals[bandSeed % 6], m);
    }

    function setDecisionReverts(bool v) external {
        jury.setDecisionReverts(v);
    }

    function _actors() internal view returns (address[] memory a) {
        a = new address[](9);
        for (uint256 i = 0; i < 7; ++i) {
            a[i] = address(uint160(0xA11CE0 + i));
        }
        a[7] = client;
        a[8] = freelancer;
    }

    function _settle(uint256 id, bool isRescue) internal {
        AICourt.Case memory pre = court.getCase(id);
        uint256 before_ = usdc.balanceOf(address(court));
        uint256 claimBefore = court.totalClaimable();
        if (isRescue) court.rescueFee(id);
        else court.finalize(id);
        uint256 out = before_ - usdc.balanceOf(address(court));
        uint256 credited = court.totalClaimable() - claimBefore;
        uint256 expected = (pre.appealed && !pre.feeSettled) ? pre.feePaid : 0;
        // every fee is either paid out or credited, exactly once
        if (out + credited != expected) ++violations;
        paidOut[id] += out + credited;
        if (paidOut[id] > pre.feePaid) ++violations;
        ghostOut += out;
        credits += credited;
    }

    /// @dev Any actor claims; success must pay exactly its credit, failure must change nothing.
    function claimFee(uint256 actorSeed) external {
        address[] memory a = _actors();
        address who = a[actorSeed % a.length];
        uint256 credit = court.claimable(who);
        uint256 totalBefore = court.totalClaimable();
        uint256 courtBefore = usdc.balanceOf(address(court));
        uint256 whoBefore = usdc.balanceOf(who);
        vm.prank(who);
        try court.claimFee() {
            if (credit == 0) ++violations;
            if (court.claimable(who) != 0) ++violations;
            if (court.totalClaimable() != totalBefore - credit) ++violations;
            if (usdc.balanceOf(who) != whoBefore + credit) ++violations;
            if (usdc.balanceOf(address(court)) != courtBefore - credit) ++violations;
            ghostOut += credit;
            claimedOut += credit;
            ++claims;
        } catch {
            if (court.claimable(who) != credit) ++violations;
            if (court.totalClaimable() != totalBefore) ++violations;
            if (usdc.balanceOf(address(court)) != courtBefore) ++violations;
        }
    }

    /// @dev mode 0 = clear, 1 = revert on transfer, 2 = return false.
    function setBlock(uint256 actorSeed, uint256 mode) external {
        address[] memory a = _actors();
        address who = a[actorSeed % a.length];
        usdc.setBlocked(who, mode % 3 == 1);
        usdc.setSoft(who, mode % 3 == 2);
    }

    function finalize(uint256 idSeed) external {
        if (court.caseCount() == 0) return;
        _settle(_pick(idSeed), false);
        ++finalizes;
    }

    function rescue(uint256 idSeed) external {
        if (court.caseCount() == 0) return;
        _settle(_pick(idSeed), true);
        ++rescues;
    }

    function warp(uint256 secs, bool big) external {
        secs = big ? bound(secs, 0, 2 days) : bound(secs, 0, 200);
        vm.warp(block.timestamp + secs);
    }
}

contract AICourtInvariantTest is Test {
    AICourt internal court;
    MockFlakyERC20 internal usdc;
    MockEscrowView internal escrowMock;
    MockJurorRegistry internal jury;
    AICourtHandler internal handler;

    address internal forwarder = makeAddr("forwarder");
    address internal owner = makeAddr("owner");
    address internal client = makeAddr("client");
    address internal freelancer = makeAddr("freelancer");

    function setUp() public {
        vm.warp(1_700_000_000);
        usdc = new MockFlakyERC20("Mock USDC", "mUSDC", 6);
        escrowMock = new MockEscrowView();
        court = new AICourt(forwarder, address(usdc), address(escrowMock), owner);
        escrowMock.setCourt(address(court));
        jury = new MockJurorRegistry();
        vm.prank(owner);
        court.setJury(address(jury));
        vm.prank(client);
        usdc.approve(address(court), type(uint256).max);
        vm.prank(freelancer);
        usdc.approve(address(court), type(uint256).max);

        handler = new AICourtHandler(court, usdc, escrowMock, jury, forwarder, client, freelancer);
        targetContract(address(handler));
        bytes4[] memory sels = new bytes4[](9);
        sels[0] = AICourtHandler.openAndClose.selector;
        sels[1] = AICourtHandler.appeal.selector;
        sels[2] = AICourtHandler.decide.selector;
        sels[3] = AICourtHandler.finalize.selector;
        sels[4] = AICourtHandler.rescue.selector;
        sels[5] = AICourtHandler.warp.selector;
        sels[6] = AICourtHandler.setDecisionReverts.selector;
        sels[7] = AICourtHandler.claimFee.selector;
        sels[8] = AICourtHandler.setBlock.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    /// @dev Court USDC balance == sum of unsettled appeal fees + totalClaimable.
    function invariant_CourtBalanceEqualsUnsettledFeesPlusClaimable() public view {
        uint256 expected;
        uint256 n = court.caseCount();
        for (uint256 i = 1; i <= n; ++i) {
            AICourt.Case memory c = court.getCase(i);
            if (c.appealed && !c.feeSettled) expected += c.feePaid;
        }
        assertEq(usdc.balanceOf(address(court)), expected + court.totalClaimable());
    }

    /// @dev totalClaimable == sum of every recipient's credit.
    function invariant_TotalClaimableEqualsSumOfCredits() public view {
        uint256 s;
        for (uint256 i = 0; i < 7; ++i) {
            s += court.claimable(address(uint160(0xA11CE0 + i)));
        }
        s += court.claimable(client) + court.claimable(freelancer);
        assertEq(court.totalClaimable(), s);
    }

    /// @dev Credited fees minus claimed fees == outstanding credits.
    function invariant_CreditsMinusClaimsEqualsOutstanding() public view {
        assertEq(handler.credits() - handler.claimedOut(), court.totalClaimable());
    }

    /// @dev Every fee leaves the court at most once and only via the settle flags.
    function invariant_NoDoublePayout() public view {
        assertEq(handler.violations(), 0);
    }

    /// @dev Money in minus money out equals what the court holds.
    function invariant_FlowsBalance() public view {
        assertEq(handler.ghostIn() - handler.ghostOut(), usdc.balanceOf(address(court)));
    }

    /// @dev Finalized cases carry a legal band; settled-but-unfinalized only via rescue.
    function invariant_FinalizedBandsAreLegal() public view {
        uint256 n = court.caseCount();
        for (uint256 i = 1; i <= n; ++i) {
            AICourt.Case memory c = court.getCase(i);
            if (c.finalized) {
                assertTrue(c.aiSet);
                assertTrue(c.finalBand == 0 || c.finalBand == 50 || c.finalBand == 80 || c.finalBand == 100);
            }
            if (c.feeSettled) assertTrue(c.appealed || c.finalized);
        }
    }
}
