// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AICourt} from "../src/AICourt.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";
import {MockEscrowView} from "../test-helpers/MockEscrowView.sol";
import {MockJurorRegistry} from "../test-helpers/MockJurorRegistry.sol";

/// @dev Shared fixture + helpers for AICourt tests. No test functions here.
abstract contract AICourtTestBase is Test {
    AICourt internal court;
    MockERC20 internal usdc;
    MockEscrowView internal escrowMock;
    MockJurorRegistry internal jury;

    address internal forwarder = makeAddr("forwarder");
    address internal owner = makeAddr("owner");
    address internal client = makeAddr("client");
    address internal freelancer = makeAddr("freelancer");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant T0 = 1_700_000_000;
    /// @dev clause amount used by default; appeal fee = 10% = 100e6
    uint256 internal constant DEFAULT_AMOUNT = 1_000e6;
    uint256 internal constant DEFAULT_FEE = 100e6;
    uint256 internal constant PARTY_START = 1_000_000e6;
    uint8 internal constant AI_BAND = 80;

    /// @dev Overridable so a category can run the whole fixture on a different token.
    function _deployUsdc() internal virtual returns (MockERC20) {
        return new MockERC20("Mock USDC", "mUSDC", 6);
    }

    function setUp() public virtual {
        vm.warp(T0);
        usdc = _deployUsdc();
        escrowMock = new MockEscrowView();
        escrowMock.setAmount(DEFAULT_AMOUNT);
        court = new AICourt(forwarder, address(usdc), address(escrowMock), owner);
        escrowMock.setCourt(address(court));
        jury = new MockJurorRegistry();
        vm.prank(owner);
        court.setJury(address(jury));

        usdc.mint(client, PARTY_START);
        usdc.mint(freelancer, PARTY_START);
        vm.prank(client);
        usdc.approve(address(court), type(uint256).max);
        vm.prank(freelancer);
        usdc.approve(address(court), type(uint256).max);
    }

    // ------------------------------------------------------------ array builders

    function _b3(uint8 a, uint8 b, uint8 c) internal pure returns (uint8[3] memory r) {
        r[0] = a;
        r[1] = b;
        r[2] = c;
    }

    function _w3(uint16 a, uint16 b, uint16 c) internal pure returns (uint16[3] memory r) {
        r[0] = a;
        r[1] = b;
        r[2] = c;
    }

    function _f3(bool a, bool b, bool c) internal pure returns (bool[3] memory r) {
        r[0] = a;
        r[1] = b;
        r[2] = c;
    }

    function _jurors(uint256 n) internal pure returns (address[] memory a) {
        a = new address[](n);
        for (uint256 i = 0; i < n; ++i) {
            a[i] = address(uint160(0xA11CE0 + i));
        }
    }

    // ------------------------------------------------------------ report builders

    function _encFull(
        uint8 kind,
        uint256 caseId,
        uint8 round,
        uint8[3] memory bands,
        uint16[3] memory words,
        bool[3] memory ext,
        bool[3] memory fin,
        uint8[3] memory cited,
        bytes32 th
    ) internal pure returns (bytes memory) {
        return abi.encode(kind, caseId, round, bands, words, ext, fin, cited, th);
    }

    function _enc(
        uint256 caseId,
        uint8 round,
        uint8[3] memory bands,
        uint16[3] memory words,
        bool[3] memory ext,
        bool[3] memory fin
    ) internal pure returns (bytes memory) {
        return _encFull(6, caseId, round, bands, words, ext, fin, _b3(0, 0, 0), keccak256(abi.encode(caseId, round)));
    }

    function _send(bytes memory report) internal {
        vm.prank(forwarder);
        court.onReport("", report);
    }

    /// @dev Plain round: words 10 each, no extension votes, nobody final.
    function _round(uint256 caseId, uint8 round, uint8[3] memory bands) internal {
        _send(_enc(caseId, round, bands, _w3(10, 10, 10), _f3(false, false, false), _f3(false, false, false)));
    }

    /// @dev Round where the first `votes` judges want an extension.
    function _roundExt(uint256 caseId, uint8 round, uint8 votes) internal {
        _send(
            _enc(
                caseId,
                round,
                _b3(50, 50, 50),
                _w3(10, 10, 10),
                _f3(votes > 0, votes > 1, votes > 2),
                _f3(false, false, false)
            )
        );
    }

    /// @dev Round where all three judges are final.
    function _roundFinal(uint256 caseId, uint8 round, uint8[3] memory bands) internal {
        _send(_enc(caseId, round, bands, _w3(10, 10, 10), _f3(false, false, false), _f3(true, true, true)));
    }

    // ------------------------------------------------------------ lifecycle helpers

    function _open() internal returns (uint256) {
        return escrowMock.callOpenCase(1, 0, client, freelancer, "dispute");
    }

    function _deadline(uint256 id) internal view returns (uint256) {
        return court.getCase(id).deadline;
    }

    /// @dev Open a case, report round 0 with `bands`, pass the deadline and close it.
    function _closedWith(uint8[3] memory bands) internal returns (uint256 id) {
        id = _open();
        _round(id, 0, bands);
        vm.warp(_deadline(id) + 1);
        court.closeCase(id);
    }

    /// @dev Closed case with AI band 80.
    function _closed() internal returns (uint256) {
        return _closedWith(_b3(80, 80, 50));
    }

    function _setFee(uint256 fee) internal {
        // floor((fee*10 + 9) * 1000 / 10000) == fee
        escrowMock.setAmount(fee * 10 + 9);
    }

    function _appealBy(uint256 id, address who) internal {
        vm.prank(who);
        court.appeal(id);
    }

    function _decide(uint256 id, uint8 band, address[] memory majority) internal {
        jury.setDecision(id, true, band, majority);
    }

    function _bal(address a) internal view returns (uint256) {
        return usdc.balanceOf(a);
    }

    function _sumBal(address[] memory a) internal view returns (uint256 s) {
        for (uint256 i = 0; i < a.length; ++i) {
            s += usdc.balanceOf(a[i]);
        }
    }
}
