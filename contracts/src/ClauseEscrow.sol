// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ReceiverTemplate} from "./cre/ReceiverTemplate.sol";
import {IAICourt} from "./IAICourt.sol";

/// @title ClauseEscrow
/// @notice CRE-certified, clause-based USDC escrow for Arc Testnet.
/// @dev Amounts are raw 6-decimal USDC units. Requires standard, non-fee-on-transfer USDC.
///      Terms are immutable; descriptive fields do not implement vesting or failure policies.
///      Disputes settle via an external AI court, which the owner sets once, or use the
///      original verdict after a one-day escape delay if the court has no usable final verdict.
///      Only release, refund and dispute resolution move custody funds out.
contract ClauseEscrow is ReceiverTemplate, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant Pending = 0;
    uint8 public constant Submitted = 1;
    uint8 public constant Verified = 2;
    uint8 public constant Failed = 3;
    uint8 public constant Disputed = 4;
    uint8 public constant Released = 5;
    uint8 public constant Refunded = 6;
    uint8 public constant MAX_CLAUSES = 5;
    uint256 public constant RELEASE_WINDOW = 120 seconds;
    uint256 public constant SUBMITTED_TIMEOUT = 1 days;
    /// @notice Minimum delay before a court case without a usable final verdict may use its original verdict.
    uint256 public constant DISPUTE_ESCAPE = 1 days;
    /// @notice Minimum gas remaining required before querying the court's verdict.
    uint256 public constant MIN_VERDICT_GAS = 300_000;

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

    address public immutable usdc;
    uint256 public dealCount;
    mapping(uint256 => bool) public certified;
    mapping(uint256 => Deal) private _deals;
    mapping(uint256 => Clause[]) private _clauses;
    mapping(uint256 => mapping(uint8 => uint256)) private _submittedAt;
    mapping(uint256 => mapping(uint8 => string)) private _evidence;
    /// @notice The external AI court configured once by the owner.
    IAICourt public court;
    mapping(uint256 => mapping(uint8 => uint64)) private _verdictAt;
    mapping(uint256 => mapping(uint8 => uint8)) private _preDisputeStatus;
    mapping(uint256 => mapping(uint8 => uint256)) private _caseId;
    mapping(uint256 => mapping(uint8 => uint64)) private _disputedAt;
    mapping(uint256 => mapping(uint8 => uint8)) private _defaultBand;

    error ZeroUSDC();
    error InvalidCreator();
    error InvalidClauseCount();
    error ZeroClauseAmount(uint8 clauseId);
    error TotalMismatch();
    error InvalidDependency(uint8 clauseId, uint8 dependency);
    error UnknownDeal(uint256 dealId);
    error UnknownClause(uint256 dealId, uint8 clauseId);
    error NotCreator();
    error NotBrand();
    error AlreadyAccepted();
    error AlreadyFunded();
    error NotAccepted();
    error NotCertified();
    error NotFunded();
    error AlreadyCertified();
    error SpecHashMismatch();
    error UnauthorizedReportForwarder();
    error InvalidReportKind(uint8 kind);
    error InvalidClauseStatus(uint8 status);
    error DeadlinePassed();
    error ReleaseWindowActive();
    error DependencyNotReleased();
    error RefundNotAllowed();
    error NotExpired();
    error ZeroOwner();
    error CourtAlreadySet();
    error ZeroCourt();
    error NotParty();
    error DisputeWindowClosed();
    error ReasonTooLong();
    error CourtNotSet();
    error WindowOpen();
    error CaseNotResolved();
    error InvalidBand(uint8 band);
    error DependencyNotSettled();
    error InvalidCaseId();
    error EscapeNotReached();
    error CaseAlreadyFinal();
    error CourtNotContract();
    error InsufficientGas();

    event DealProposed(uint256 indexed dealId, address indexed brand, address indexed creator, bytes32 specHash);
    event DealAccepted(uint256 indexed dealId);
    event DealFunded(uint256 indexed dealId, uint256 total);
    event DealCertified(uint256 indexed dealId);
    event ClauseSubmitted(uint256 indexed dealId, uint8 clauseId, string videoId);
    event ClauseVerified(uint256 indexed dealId, uint8 clauseId);
    event ClauseFailed(uint256 indexed dealId, uint8 clauseId);
    event ClauseSettled(uint256 indexed dealId, uint8 clauseId, uint8 status, uint256 amount);

    event CourtSet(address indexed court);
    event ClauseDisputed(uint256 indexed dealId, uint8 clauseId, uint256 caseId, address indexed disputer, string reason);
    event ClauseResolved(uint256 indexed dealId, uint8 clauseId, uint16 creatorBps, uint256 creatorAmount, uint256 brandAmount);
    /// @notice Exact token allocation on either court or escape resolution.
    event ClauseSplit(uint256 indexed dealId, uint8 clauseId, uint256 toFreelancer, uint256 toClient);

    /// @notice Configure the trusted CRE forwarder, the USDC token and the owner.
    constructor(address forwarder, address usdc_, address owner_) ReceiverTemplate(forwarder) {
        if (usdc_ == address(0)) revert ZeroUSDC();
        usdc = usdc_;
        if (owner_ == address(0)) revert ZeroOwner();
        _transferOwnership(owner_);
    }

    /// @notice Set the external AI court once as the owner; the address must contain code.
    function setCourt(address court_) external onlyOwner {
        if (address(court) != address(0)) revert CourtAlreadySet();
        if (court_ == address(0)) revert ZeroCourt();
        if (court_.code.length == 0) revert CourtNotContract();
        court = IAICourt(court_);
        emit CourtSet(court_);
    }

    /// @notice Propose immutable terms without transferring funds.
    /// @dev Dependencies must point strictly backwards, preventing cycles and self-dependencies.
    /// @return dealId Sequential identifier starting at one.
    function proposeDeal(address creator, uint256 total, ClauseTerms[] calldata terms)
        external returns (uint256 dealId)
    {
        if (creator == address(0) || creator == msg.sender) revert InvalidCreator();
        uint256 length = terms.length;
        if (length == 0 || length > MAX_CLAUSES) revert InvalidClauseCount();
        uint256 sum;
        for (uint256 i = 0; i < length; ++i) {
            ClauseTerms calldata term = terms[i];
            if (term.amount == 0) revert ZeroClauseAmount(uint8(i));
            if (term.dependsOn != 255 && term.dependsOn >= i) {
                revert InvalidDependency(uint8(i), term.dependsOn);
            }
            sum += term.amount;
        }
        if (sum != total) revert TotalMismatch();

        ClauseTerms[] memory termsMemory = terms;
        bytes32 specHash = keccak256(abi.encode(termsMemory));
        dealId = ++dealCount;
        _deals[dealId] = Deal(msg.sender, creator, usdc, total, specHash, false, false);
        for (uint256 i = 0; i < length; ++i) {
            ClauseTerms calldata term = terms[i];
            _clauses[dealId].push(Clause({
                kind: term.kind,
                checkType: term.checkType,
                param: term.param,
                deadline: term.deadline,
                amount: term.amount,
                dependsOn: term.dependsOn,
                onFail: term.onFail,
                vestDays: term.vestDays,
                daysVested: 0,
                status: Pending,
                verifiedAt: 0
            }));
        }
        emit DealProposed(dealId, msg.sender, creator, specHash);
    }

    /// @notice Accept the proposal as its designated creator.
    function acceptDeal(uint256 dealId) external {
        Deal storage deal = _requireDeal(dealId);
        if (msg.sender != deal.creator) revert NotCreator();
        if (deal.funded) revert AlreadyFunded();
        if (deal.accepted) revert AlreadyAccepted();
        deal.accepted = true;
        emit DealAccepted(dealId);
    }

    /// @notice Deposit the total after creator acceptance and CRE certification.
    /// @dev The brand must first approve this contract for the exact raw-token amount.
    function fundDeal(uint256 dealId) external nonReentrant {
        Deal storage deal = _requireDeal(dealId);
        if (msg.sender != deal.brand) revert NotBrand();
        if (!deal.accepted) revert NotAccepted();
        if (!certified[dealId]) revert NotCertified();
        if (deal.funded) revert AlreadyFunded();
        deal.funded = true;
        IERC20(deal.token).safeTransferFrom(deal.brand, address(this), deal.total);
        emit DealFunded(dealId, deal.total);
    }

    /// @notice Submit an evidence identifier at or before the clause deadline.
    function submitEvidence(uint256 dealId, uint8 clauseId, string calldata videoId) external {
        Deal storage deal = _requireDeal(dealId);
        if (msg.sender != deal.creator) revert NotCreator();
        if (!deal.funded) revert NotFunded();
        Clause storage clause = _requireClause(dealId, clauseId);
        if (clause.status != Pending) revert InvalidClauseStatus(clause.status);
        if (block.timestamp > clause.deadline) revert DeadlinePassed();
        clause.status = Submitted;
        _submittedAt[dealId][clauseId] = block.timestamp;
        _evidence[dealId][clauseId] = videoId;
        emit ClauseSubmitted(dealId, clauseId, videoId);
    }

    /// @notice Process certification or a submitted clause's verification result.
    /// @dev Fail closed even when the inherited owner sets the forwarder to zero.
    ///      The inherited getter is external, so it must be called through this.
    ///      Report value, source selector and source timestamp are informational only.
    function _processReport(bytes calldata report) internal override {
        address f = this.getForwarderAddress();
        if (f == address(0) || msg.sender != f) revert UnauthorizedReportForwarder();
        (uint8 kind, uint256 dealId, uint8 clauseId, , bytes32 data, , ) =
            abi.decode(report, (uint8, uint256, uint8, uint8, bytes32, uint64, uint64));
        Deal storage deal = _requireDeal(dealId);
        if (kind == 0) {
            // Certification is deal-level; the clause index is ignored.
            if (deal.funded) revert AlreadyFunded();
            if (certified[dealId]) revert AlreadyCertified();
            if (data != deal.specHash) revert SpecHashMismatch();
            certified[dealId] = true;
            emit DealCertified(dealId);
        } else if (kind == 1 || kind == 2) {
            if (!deal.funded) revert NotFunded();
            Clause storage clause = _requireClause(dealId, clauseId);
            if (clause.status != Submitted) revert InvalidClauseStatus(clause.status);
            _verdictAt[dealId][clauseId] = uint64(block.timestamp);
            if (kind == 1) {
                clause.status = Verified;
                clause.verifiedAt = uint64(block.timestamp);
                emit ClauseVerified(dealId, clauseId);
            } else {
                clause.status = Failed;
                emit ClauseFailed(dealId, clauseId);
            }
        } else {
            revert InvalidReportKind(kind);
        }
    }

    /// @notice Open a court case as either party during a verified or failed clause's dispute window.
    /// @dev Freeze only this clause and store the original verdict (100 for Verified, 0 for Failed)
    ///      and escape timestamp before calling the court. A zero case identifier reverts all effects.
    function dispute(uint256 dealId, uint8 clauseId, string calldata reason) external nonReentrant {
        Deal storage deal = _requireDeal(dealId);
        if (msg.sender != deal.brand && msg.sender != deal.creator) revert NotParty();
        if (!deal.funded) revert NotFunded();
        Clause storage clause = _requireClause(dealId, clauseId);
        uint8 status = clause.status;
        if (status != Verified && status != Failed) revert InvalidClauseStatus(status);
        if (block.timestamp >= uint256(_verdictAt[dealId][clauseId]) + RELEASE_WINDOW) {
            revert DisputeWindowClosed();
        }
        if (bytes(reason).length > 500) revert ReasonTooLong();
        if (address(court) == address(0)) revert CourtNotSet();

        _preDisputeStatus[dealId][clauseId] = status;
        clause.status = Disputed;
        _disputedAt[dealId][clauseId] = uint64(block.timestamp);
        _defaultBand[dealId][clauseId] = status == Verified ? 100 : 0;
        uint256 caseId = court.openCase(dealId, clauseId, deal.brand, deal.creator, reason);
        if (caseId == 0) revert InvalidCaseId();
        _caseId[dealId][clauseId] = caseId;
        emit ClauseDisputed(dealId, clauseId, caseId, msg.sender, reason);
    }

    /// @notice Anyone may settle a disputed clause using the court's final percentage band.
    /// @dev Only bands 0, 50, 80 and 100 are valid. A refunded dependency forces a full brand refund.
    ///      The court query requires at least MIN_VERDICT_GAS gas remaining.
    function resolveDispute(uint256 dealId, uint8 clauseId) external nonReentrant {
        Deal storage deal = _requireDeal(dealId);
        if (!deal.funded) revert NotFunded();
        Clause storage clause = _requireClause(dealId, clauseId);
        if (clause.status != Disputed) revert InvalidClauseStatus(clause.status);
        (bool ok, bool isFinal, uint8 band) = _courtVerdict(_caseId[dealId][clauseId]);
        if (!ok || !isFinal) revert CaseNotResolved();
        if (band != 0 && band != 50 && band != 80 && band != 100) revert InvalidBand(band);
        _settleDispute(dealId, clauseId, deal, clause, band);
    }

    /// @notice Anyone may use the original verdict after one day if the court has no usable final verdict.
    /// @dev A reverting, malformed or unusable-band court response counts as no usable verdict.
    ///      Dependencies must still be settled; a refunded dependency forces a full brand refund.
    ///      A usable final verdict must use resolveDispute instead.
    ///      The court query requires at least MIN_VERDICT_GAS gas remaining.
    function resolveStuckDispute(uint256 dealId, uint8 clauseId) external nonReentrant {
        Deal storage deal = _requireDeal(dealId);
        if (!deal.funded) revert NotFunded();
        Clause storage clause = _requireClause(dealId, clauseId);
        if (clause.status != Disputed) revert InvalidClauseStatus(clause.status);
        if (block.timestamp < uint256(_disputedAt[dealId][clauseId]) + DISPUTE_ESCAPE) {
            revert EscapeNotReached();
        }
        (bool ok, bool isFinal, uint8 band) = _courtVerdict(_caseId[dealId][clauseId]);
        if (ok && isFinal && (band == 0 || band == 50 || band == 80 || band == 100)) {
            revert CaseAlreadyFinal();
        }
        _settleDispute(dealId, clauseId, deal, clause, _defaultBand[dealId][clauseId]);
    }

    /// @dev Requires MIN_VERDICT_GAS before the court query; failed or malformed responses return ok=false.
    ///      Read and validate both ABI words manually before narrowing to bool and uint8.
    function _courtVerdict(uint256 caseId) private view returns (bool ok, bool isFinal, uint8 band) {
        // EIP-150 forwards at most 63/64 of the remaining gas, so require enough to forward the full
        // MIN_VERDICT_GAS budget plus a margin for call setup.
        if (gasleft() < (MIN_VERDICT_GAS * 64) / 63 + 10_000) revert InsufficientGas();
        bytes memory callData = abi.encodeCall(IAICourt.finalVerdict, (caseId));
        address target = address(court);
        bool success;
        uint256 size;
        uint256 finalWord;
        uint256 bandWord;
        // Copy at most 64 bytes of return data so an oversized payload cannot burn the caller's gas.
        assembly ("memory-safe") {
            let out := mload(0x40)
            success := staticcall(gas(), target, add(callData, 0x20), mload(callData), out, 0x40)
            size := returndatasize()
            finalWord := mload(out)
            bandWord := mload(add(out, 0x20))
        }
        if (!success || size < 64) return (false, false, 0);
        if (finalWord > 1 || bandWord > 255) return (false, false, 0);
        return (true, finalWord == 1, uint8(bandWord));
    }

    /// @dev Shared settlement for both resolution paths. Callers require Disputed and a valid band.
    ///      Multiply before division; the brand receives the remainder, conserving the full amount.
    ///      Write the terminal status before SafeERC20 transfers so each clause settles at most once.
    function _settleDispute(
        uint256 dealId,
        uint8 clauseId,
        Deal storage deal,
        Clause storage clause,
        uint8 band
    ) private {
        if (clause.dependsOn != 255) {
            uint8 dependencyStatus = _clauses[dealId][clause.dependsOn].status;
            if (dependencyStatus != Released && dependencyStatus != Refunded) revert DependencyNotSettled();
            if (dependencyStatus == Refunded) band = 0;
        }

        uint256 toFreelancer = clause.amount * band / 100;
        uint256 toClient = clause.amount - toFreelancer;
        uint8 outcome = toFreelancer > 0 ? Released : Refunded;
        clause.status = outcome;
        if (toFreelancer > 0) IERC20(deal.token).safeTransfer(deal.creator, toFreelancer);
        if (toClient > 0) IERC20(deal.token).safeTransfer(deal.brand, toClient);
        emit ClauseSplit(dealId, clauseId, toFreelancer, toClient);
        emit ClauseResolved(dealId, clauseId, uint16(band) * 100, toFreelancer, toClient);
        emit ClauseSettled(dealId, clauseId, outcome, toFreelancer > 0 ? toFreelancer : toClient);
    }

    /// @notice Pay a verified clause to the creator after its window and dependency settle.
    function release(uint256 dealId, uint8 clauseId) external nonReentrant {
        Deal storage deal = _requireDeal(dealId);
        if (!deal.funded) revert NotFunded();
        Clause storage clause = _requireClause(dealId, clauseId);
        if (clause.status != Verified) revert InvalidClauseStatus(clause.status);
        if (block.timestamp < uint256(clause.verifiedAt) + RELEASE_WINDOW) revert ReleaseWindowActive();
        if (clause.dependsOn != 255 && _clauses[dealId][clause.dependsOn].status != Released) {
            revert DependencyNotReleased();
        }
        clause.status = Released;
        IERC20(deal.token).safeTransfer(deal.creator, clause.amount);
        emit ClauseSettled(dealId, clauseId, Released, clause.amount);
    }

    /// @notice Return a failed clause, or cascade a dependency refund, to the brand.
    /// @dev Failed clauses always wait for their dispute window, including dependency cascades.
    function refund(uint256 dealId, uint8 clauseId) external nonReentrant {
        Deal storage deal = _requireDeal(dealId);
        if (!deal.funded) revert NotFunded();
        Clause storage clause = _requireClause(dealId, clauseId);
        uint8 status = clause.status;
        if (status == Released || status == Refunded) revert RefundNotAllowed();
        if (status == Disputed) revert RefundNotAllowed();
        bool cascade = clause.dependsOn != 255 && _clauses[dealId][clause.dependsOn].status == Refunded;
        if (status != Failed && !cascade) revert RefundNotAllowed();
        if (status == Failed && block.timestamp < uint256(_verdictAt[dealId][clauseId]) + RELEASE_WINDOW) {
            revert WindowOpen();
        }
        clause.status = Refunded;
        IERC20(deal.token).safeTransfer(deal.brand, clause.amount);
        emit ClauseSettled(dealId, clauseId, Refunded, clause.amount);
    }

    /// @notice Mark a funded pending or submitted clause failed once its timeout elapses.
    function expire(uint256 dealId, uint8 clauseId) external {
        Deal storage deal = _requireDeal(dealId);
        if (!deal.funded) revert NotFunded();
        Clause storage clause = _requireClause(dealId, clauseId);
        bool pendingExpired = clause.status == Pending && block.timestamp > clause.deadline;
        bool submissionExpired = clause.status == Submitted
            && block.timestamp >= _submittedAt[dealId][clauseId] + SUBMITTED_TIMEOUT;
        if (!pendingExpired && !submissionExpired) revert NotExpired();
        clause.status = Failed;
        _verdictAt[dealId][clauseId] = uint64(block.timestamp);
        emit ClauseFailed(dealId, clauseId);
    }

    /// @notice Return the dispute window end for a known clause.
    function disputeWindowEnd(uint256 dealId, uint8 clauseId) external view returns (uint64) {
        _requireDeal(dealId);
        _requireClause(dealId, clauseId);
        return uint64(uint256(_verdictAt[dealId][clauseId]) + RELEASE_WINDOW);
    }

    /// @notice Return the evidence identifier stored by submitEvidence (empty if none was submitted).
    function evidenceOf(uint256 dealId, uint8 clauseId) external view returns (string memory) {
        _requireDeal(dealId);
        _requireClause(dealId, clauseId);
        return _evidence[dealId][clauseId];
    }

    /// @notice Return the court case identifier stored for a known clause.
    function caseOf(uint256 dealId, uint8 clauseId) external view returns (uint256) {
        _requireDeal(dealId);
        _requireClause(dealId, clauseId);
        return _caseId[dealId][clauseId];
    }

    /// @notice Return a known deal, including its immutable specification hash.
    function getDeal(uint256 dealId) external view returns (Deal memory) {
        return _requireDeal(dealId);
    }

    /// @notice Return a known clause and its current settlement state.
    function getClause(uint256 dealId, uint8 clauseId) external view returns (Clause memory) {
        _requireDeal(dealId);
        return _requireClause(dealId, clauseId);
    }

    /// @notice Return every clause of a known deal in its original order.
    function getClauses(uint256 dealId) external view returns (Clause[] memory) {
        _requireDeal(dealId);
        return _clauses[dealId];
    }

    /// @notice Return the number of clauses in a known deal.
    function clauseCount(uint256 dealId) external view returns (uint256) {
        _requireDeal(dealId);
        return _clauses[dealId].length;
    }

    function _requireDeal(uint256 dealId) private view returns (Deal storage deal) {
        if (dealId == 0 || dealId > dealCount) revert UnknownDeal(dealId);
        return _deals[dealId];
    }

    function _requireClause(uint256 dealId, uint8 clauseId) private view returns (Clause storage clause) {
        if (clauseId >= _clauses[dealId].length) revert UnknownClause(dealId, clauseId);
        return _clauses[dealId][clauseId];
    }
}
