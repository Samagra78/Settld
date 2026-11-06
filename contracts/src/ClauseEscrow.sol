// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ReceiverTemplate} from "./ReceiverTemplate.sol";

/// @title ClauseEscrow
/// @notice Reusable escrow: a deal is a list of clauses, each holding part of the money.
///         Chainlink CRE (via the forwarder) certifies the deal and reports each clause
///         as Verified or Failed. Verified clauses are paid to the creator after a dispute
///         window; Failed clauses are refunded to the brand. Money can only ever go to
///         the creator (release) or the brand (refund).
/// @dev Matches docs/INTERFACES.md. State machine mirrors shared/checker.ts:
///        Pending -> Submitted -> Verified -> Released
///        Pending|Submitted -> Failed -> Refunded
///        any non-final clause whose dependency is Refunded -> Refunded (cascade)
///      V1a scope: no dispute() yet (jury is V1c), OneTime clauses only, vestDays unused.
///      Safety rules: terms are immutable once stored; no admin key and no withdrawal
///      function; state is written before money moves; SafeERC20 + ReentrancyGuard.
contract ClauseEscrow is ReceiverTemplate, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- constants
    uint8 public constant MAX_CLAUSES = 5;
    uint8 public constant NO_DEPENDENCY = 255;
    uint64 public constant DISPUTE_WINDOW = 120; // seconds (demo)
    uint64 public constant REPORT_TIMEOUT = 1 days; // Submitted with no report -> Failed

    // ClauseStatus
    uint8 public constant PENDING = 0;
    uint8 public constant SUBMITTED = 1;
    uint8 public constant VERIFIED = 2;
    uint8 public constant FAILED = 3;
    uint8 public constant DISPUTED = 4; // reserved for the jury (not reachable in V1a)
    uint8 public constant RELEASED = 5;
    uint8 public constant REFUNDED = 6;

    // Report kinds
    uint8 public constant REPORT_CERTIFY = 0;
    uint8 public constant REPORT_VERIFIED = 1;
    uint8 public constant REPORT_FAILED = 2;

    // ---------------------------------------------------------------- types
    /// @dev The clause terms that are hashed into specHash (field order matters).
    struct ClauseTerms {
        uint8 kind;
        uint8 checkType;
        string param;
        uint64 deadline;
        uint256 amount;
        uint8 dependsOn;
        uint8 onFail;
        uint32 vestDays;
    }

    struct Clause {
        uint8 kind;
        uint8 checkType;
        string param;
        uint64 deadline;
        uint256 amount;
        uint8 dependsOn;
        uint8 onFail;
        uint32 vestDays;
        uint32 daysVested;
        uint8 status;
        uint64 verifiedAt;
    }

    struct Deal {
        address brand;
        address creator;
        address token;
        uint256 total;
        bytes32 specHash;
        bool accepted;
        bool funded;
    }

    // ---------------------------------------------------------------- storage
    IERC20 public immutable token;
    uint256 public dealCount;

    mapping(uint256 => Deal) private _deals;
    mapping(uint256 => Clause[]) private _clauses;
    mapping(uint256 => bool) public certified;
    mapping(uint256 => mapping(uint8 => uint64)) private _submittedAt;

    // ---------------------------------------------------------------- events
    event DealProposed(uint256 indexed dealId, address indexed brand, address indexed creator, bytes32 specHash);
    event DealAccepted(uint256 indexed dealId);
    event DealCertified(uint256 indexed dealId, bytes32 specHash);
    event DealFunded(uint256 indexed dealId, uint256 total);
    event ClauseSubmitted(uint256 indexed dealId, uint8 clauseId, string videoId);
    event ClauseVerified(uint256 indexed dealId, uint8 clauseId);
    event ClauseFailed(uint256 indexed dealId, uint8 clauseId);
    event ClauseDisputed(uint256 indexed dealId, uint8 clauseId);
    event ClauseSettled(uint256 indexed dealId, uint8 clauseId, uint8 outcome, uint256 amount); // 5 Released, 6 Refunded

    // ---------------------------------------------------------------- errors
    error UnknownDeal();
    error UnknownClause();
    error NotBrand();
    error NotCreator();
    error BadCreator();
    error BadClauseCount();
    error BadClause(uint8 clauseId);
    error AmountsDoNotAddUp(uint256 sum, uint256 total);
    error AlreadyAccepted();
    error NotAccepted();
    error NotCertified();
    error AlreadyCertified();
    error AlreadyFunded();
    error NotFunded();
    error WrongStatus(uint8 clauseId, uint8 status);
    error DeadlinePassed();
    error DeadlineNotPassed();
    error WindowOpen(uint64 releasableAt);
    error DependencyNotReleased(uint8 dependsOn);
    error NotRefundable(uint8 clauseId);
    error SpecHashMismatch(bytes32 got, bytes32 expected);
    error UnsupportedReport(uint8 kind);

    constructor(address forwarder, address token_) ReceiverTemplate(forwarder) {
        require(token_ != address(0), "token=0");
        token = IERC20(token_);
    }

    // ================================================================ deal setup

    /// @notice Brand proposes a deal. specHash is computed here from the stored terms,
    ///         never supplied by the caller (safety rules 3 and 4).
    function proposeDeal(address creator, uint256 total, ClauseTerms[] calldata terms)
        external
        returns (uint256 dealId)
    {
        if (creator == address(0) || creator == msg.sender) revert BadCreator();
        uint256 n = terms.length;
        if (n == 0 || n > MAX_CLAUSES) revert BadClauseCount();

        dealId = ++dealCount;

        uint256 sum;
        for (uint256 i = 0; i < n; i++) {
            ClauseTerms calldata t = terms[i];
            if (t.amount == 0) revert BadClause(uint8(i));
            if (t.dependsOn != NO_DEPENDENCY && (t.dependsOn >= n || t.dependsOn == i)) {
                revert BadClause(uint8(i));
            }
            sum += t.amount;
            _clauses[dealId].push(
                Clause({
                    kind: t.kind,
                    checkType: t.checkType,
                    param: t.param,
                    deadline: t.deadline,
                    amount: t.amount,
                    dependsOn: t.dependsOn,
                    onFail: t.onFail,
                    vestDays: t.vestDays,
                    daysVested: 0,
                    status: PENDING,
                    verifiedAt: 0
                })
            );
        }
        if (sum != total) revert AmountsDoNotAddUp(sum, total);

        bytes32 specHash = keccak256(abi.encode(terms));
        _deals[dealId] = Deal({
            brand: msg.sender,
            creator: creator,
            token: address(token),
            total: total,
            specHash: specHash,
            accepted: false,
            funded: false
        });

        emit DealProposed(dealId, msg.sender, creator, specHash);
    }

    /// @notice Creator accepts the exact terms (specHash) the brand proposed.
    function acceptDeal(uint256 dealId) external {
        Deal storage d = _deal(dealId);
        if (msg.sender != d.creator) revert NotCreator();
        if (d.accepted) revert AlreadyAccepted();
        if (d.funded) revert AlreadyFunded();
        d.accepted = true;
        emit DealAccepted(dealId);
    }

    /// @notice Brand deposits the full total. Refused without the CRE certificate.
    function fundDeal(uint256 dealId) external nonReentrant {
        Deal storage d = _deal(dealId);
        if (msg.sender != d.brand) revert NotBrand();
        if (!d.accepted) revert NotAccepted();
        if (!certified[dealId]) revert NotCertified();
        if (d.funded) revert AlreadyFunded();

        d.funded = true; // effects before interaction
        token.safeTransferFrom(msg.sender, address(this), d.total);
        emit DealFunded(dealId, d.total);
    }

    // ================================================================ delivery

    /// @notice Creator submits a video for a clause. Emits ClauseSubmitted for CRE WF1.
    function submitEvidence(uint256 dealId, uint8 clauseId, string calldata videoId) external {
        Deal storage d = _deal(dealId);
        if (msg.sender != d.creator) revert NotCreator();
        if (!d.funded) revert NotFunded();
        Clause storage c = _clause(dealId, clauseId);
        if (c.status != PENDING) revert WrongStatus(clauseId, c.status);
        if (block.timestamp > c.deadline) revert DeadlinePassed();

        c.status = SUBMITTED;
        _submittedAt[dealId][clauseId] = uint64(block.timestamp);
        emit ClauseSubmitted(dealId, clauseId, videoId);
    }

    /// @notice Anyone can push a stuck clause to Failed so it can be refunded:
    ///         Pending past its deadline, or Submitted with no report for REPORT_TIMEOUT.
    function expire(uint256 dealId, uint8 clauseId) external {
        Deal storage d = _deal(dealId);
        if (!d.funded) revert NotFunded();
        Clause storage c = _clause(dealId, clauseId);

        if (c.status == PENDING) {
            if (block.timestamp <= c.deadline) revert DeadlineNotPassed();
        } else if (c.status == SUBMITTED) {
            if (block.timestamp <= uint256(_submittedAt[dealId][clauseId]) + REPORT_TIMEOUT) {
                revert DeadlineNotPassed();
            }
        } else {
            revert WrongStatus(clauseId, c.status);
        }

        c.status = FAILED;
        emit ClauseFailed(dealId, clauseId);
    }

    // ================================================================ settlement

    /// @notice Pay a Verified clause to the creator once the window has passed and the
    ///         clause it depends on (if any) has been Released. Callable by anyone.
    function release(uint256 dealId, uint8 clauseId) external nonReentrant {
        Deal storage d = _deal(dealId);
        if (!d.funded) revert NotFunded();
        Clause storage c = _clause(dealId, clauseId);
        if (c.status != VERIFIED) revert WrongStatus(clauseId, c.status);

        uint64 releasableAt = c.verifiedAt + DISPUTE_WINDOW;
        if (block.timestamp < releasableAt) revert WindowOpen(releasableAt);
        if (c.dependsOn != NO_DEPENDENCY && _clauses[dealId][c.dependsOn].status != RELEASED) {
            revert DependencyNotReleased(c.dependsOn);
        }

        c.status = RELEASED; // effects before interaction
        token.safeTransfer(d.creator, c.amount);
        emit ClauseSettled(dealId, clauseId, RELEASED, c.amount);
    }

    /// @notice Return a clause's money to the brand when the clause Failed, or when the
    ///         clause it depends on was Refunded (otherwise this money could never move:
    ///         the checker's "cascade" rule). Callable by anyone; funds only go to the brand.
    function refund(uint256 dealId, uint8 clauseId) external nonReentrant {
        Deal storage d = _deal(dealId);
        if (!d.funded) revert NotFunded();
        Clause storage c = _clause(dealId, clauseId);

        bool failed = c.status == FAILED;
        bool dependencyRefunded = c.dependsOn != NO_DEPENDENCY
            && _clauses[dealId][c.dependsOn].status == REFUNDED
            && c.status != RELEASED
            && c.status != REFUNDED;
        if (!failed && !dependencyRefunded) revert NotRefundable(clauseId);

        c.status = REFUNDED; // effects before interaction
        token.safeTransfer(d.brand, c.amount);
        emit ClauseSettled(dealId, clauseId, REFUNDED, c.amount);
    }

    // ================================================================ CRE reports

    /// @dev Report = abi.encode(uint8 kind, uint256 dealId, uint8 clauseId, uint8 value,
    ///      bytes32 data, uint64 sourceSelector, uint64 timestamp). Only reachable via
    ///      onReport, i.e. only the forwarder. sourceSelector/timestamp are carried for
    ///      auditing and not checked: authenticity comes from the forwarder (+ workflow
    ///      checks in production).
    function _processReport(bytes calldata report) internal override {
        (uint8 kind, uint256 dealId, uint8 clauseId,, bytes32 data,,) =
            abi.decode(report, (uint8, uint256, uint8, uint8, bytes32, uint64, uint64));

        Deal storage d = _deal(dealId);

        if (kind == REPORT_CERTIFY) {
            if (d.funded) revert AlreadyFunded();
            if (certified[dealId]) revert AlreadyCertified();
            if (data != d.specHash) revert SpecHashMismatch(data, d.specHash);
            certified[dealId] = true;
            emit DealCertified(dealId, data);
            return;
        }

        if (kind == REPORT_VERIFIED || kind == REPORT_FAILED) {
            if (!d.funded) revert NotFunded();
            Clause storage c = _clause(dealId, clauseId);
            if (c.status != SUBMITTED) revert WrongStatus(clauseId, c.status);

            if (kind == REPORT_VERIFIED) {
                c.status = VERIFIED;
                c.verifiedAt = uint64(block.timestamp);
                emit ClauseVerified(dealId, clauseId);
            } else {
                c.status = FAILED;
                emit ClauseFailed(dealId, clauseId);
            }
            return;
        }

        revert UnsupportedReport(kind);
    }

    // ================================================================ views

    function getDeal(uint256 dealId) external view returns (Deal memory) {
        return _deal(dealId);
    }

    function getClause(uint256 dealId, uint8 clauseId) external view returns (Clause memory) {
        _deal(dealId);
        return _clause(dealId, clauseId);
    }

    /// @notice All clauses of a deal (used by CRE WF0 to read the deal from the chain).
    function getClauses(uint256 dealId) external view returns (Clause[] memory) {
        _deal(dealId);
        return _clauses[dealId];
    }

    function clauseCount(uint256 dealId) external view returns (uint256) {
        _deal(dealId);
        return _clauses[dealId].length;
    }

    // ================================================================ internals

    function _deal(uint256 dealId) private view returns (Deal storage d) {
        d = _deals[dealId];
        if (d.brand == address(0)) revert UnknownDeal();
    }

    function _clause(uint256 dealId, uint8 clauseId) private view returns (Clause storage) {
        if (clauseId >= _clauses[dealId].length) revert UnknownClause();
        return _clauses[dealId][clauseId];
    }
}
