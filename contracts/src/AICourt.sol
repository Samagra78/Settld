// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ReceiverTemplate} from "./cre/ReceiverTemplate.sol";
import {IJurorRegistry} from "./IJurorRegistry.sol";
import {IAICourt} from "./IAICourt.sol";
import {IClauseEscrowView} from "./IClauseEscrowView.sol";

/// @title AICourt
/// @notice CRE round collection, AI verdicts and jury appeals for an Arc Testnet AI court.
/// @dev Requires standard, bool-returning, non-fee-on-transfer, non-rebasing USDC. At transaction
///      boundaries, absent unsolicited token transfers, the USDC balance equals the sum of
///      feePaid for appealed cases whose feeSettled is false plus totalClaimable.
///      Unsolicited transfers create surplus only. Each settled fee is paid or credited exactly
///      once through finalize or rescueFee; credits can only be withdrawn through claimFee.
///      A blocked recipient no longer blocks finalize or rescueFee. Fee flows use effects before
///      transfers and a shared ReentrancyGuard; a failed claim rolls back its withdrawal effects.
contract AICourt is IAICourt, ReceiverTemplate, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Initial per-judge word budget.
    uint16 public constant WORD_BUDGET = 200;
    /// @notice Additional per-judge words for each granted extension.
    uint16 public constant EXTEND_WORDS = 100;
    /// @notice Seconds added by an extension, subject to the hard cap.
    uint256 public constant EXTEND_SECS = 60;
    /// @notice Initial case duration in seconds.
    uint256 public constant BASE_SECS = 180;
    /// @notice Maximum case duration from opening, in seconds.
    uint256 public constant HARD_CAP_SECS = 300;
    /// @notice Maximum granted extensions.
    uint8 public constant MAX_EXT = 2;
    /// @notice Base round allowance before extensions.
    uint8 public constant MAX_ROUNDS = 3;
    /// @notice Appeal fee rate in basis points.
    uint256 public constant APPEAL_BPS = 1000;
    /// @notice Basis-point denominator for appeal fee calculations.
    uint256 public constant BPS_DENOMINATOR = 10000;
    /// @notice Appeal window in seconds after the AI verdict.
    uint256 public constant APPEAL_WINDOW = 120;
    /// @notice Delay after an appeal before its unsettled fee may be rescued.
    uint256 public constant RESCUE_DELAY = 1 days;

    /// @notice Case identity, round limits, AI verdict, appeal and final settlement state.
    /// @dev Existing part-one fields retain their meanings; feePaid uses raw USDC units.
    struct Case {
        uint256 dealId;
        address client;
        uint64 openedAt;
        address freelancer;
        uint64 deadline;
        uint16 wordBudget;
        uint8 clauseId;
        uint8 extensions;
        uint8 nextRound;
        bool aiSet;
        uint8 aiBand;
        uint64 appealDeadline;
        bool appealed;
        address appellant;
        uint64 appealedAt;
        uint256 feePaid;
        bool feeSettled;
        bool finalized;
        uint8 finalBand;
        bool byHumans;
    }

    /// @notice Latest report for one of the three judges; fits in one slot.
    /// @dev A final judge may repeat its values in later rounds.
    struct Judge {
        uint16 wordsUsed;
        uint8 band;
        bool wantsExtend;
        bool isFinal;
        uint8 citedMask;
    }

    /// @notice USDC token used by appeal fee handling.
    address public immutable usdc;
    /// @notice Sole address authorized to open cases.
    address public immutable escrow;
    /// @notice Jury registry, configured once by the owner.
    IJurorRegistry public jury;
    /// @notice Number of cases opened; valid identifiers start at one.
    uint256 public caseCount;

    mapping(uint256 => Case) private _cases;
    mapping(uint256 => Judge[3]) private _judges;

    /// @notice Undelivered fees available for each recipient to claim.
    mapping(address => uint256) public claimable;
    /// @notice Total outstanding fee credits backed by the contract's USDC balance.
    uint256 public totalClaimable;

    error ZeroUSDC();
    error ZeroEscrow();
    error ZeroOwner();
    error USDCNotContract();
    error EscrowNotContract();
    error JuryAlreadySet();
    error ZeroJury();
    error JuryNotContract();
    error NotEscrow();
    error UnknownCase(uint256 caseId);
    error InvalidJudge(uint8 judge);
    error UnauthorizedReportForwarder();
    error InvalidReportKind(uint8 kind);
    error AiVerdictAlreadySet();
    error WrongRound(uint8 expected, uint8 got);
    error RoundLimitReached();
    error DeadlinePassed();
    error InvalidBand(uint8 band);
    error WordsOverBudget(uint8 judge, uint16 used, uint16 budget);
    error InvalidCitedMask(uint8 judge, uint8 mask);
    error AlreadyClosed();
    error NoRoundReported();
    error CannotCloseYet();
    error NotParty();
    error NoAiVerdict();
    error AlreadyAppealed();
    error AppealWindowClosed();
    error JuryNotSet();
    error AlreadyFinalized();
    error AppealWindowOpen();
    error JuryNotDecided();
    error NotAppealed();
    error FeeAlreadySettled();
    error RescueTooEarly();
    error NothingToClaim();

    event JurySet(address indexed jury);
    event CaseOpened(uint256 indexed caseId, uint256 dealId, uint8 clauseId, string reason, uint64 deadline);
    event JudgeUpdated(
        uint256 indexed caseId,
        uint8 round,
        uint8 judge,
        uint8 band,
        uint16 wordsUsed,
        bool wantsExtend,
        bool isFinal,
        uint8 citedMask
    );
    event ExtensionGranted(uint256 indexed caseId, uint16 wordBudget, uint64 deadline);
    event RoundCompleted(uint256 indexed caseId, uint8 round, bytes32 transcriptHash);
    event AIVerdict(uint256 indexed caseId, uint8 band, uint64 appealDeadline);
    event Appealed(uint256 indexed caseId, address by, uint256 fee);
    event Finalized(uint256 indexed caseId, uint8 band, bool byHumans);
    event FeeRescued(uint256 indexed caseId, address indexed to, uint256 fee);
    event FeeCredited(address indexed to, uint256 amount);
    event FeeClaimed(address indexed to, uint256 amount);

    /// @notice Configure the forwarder, token, escrow and final owner.
    /// @dev ReceiverTemplate rejects a zero forwarder and initially owns the contract.
    constructor(address forwarder, address usdc_, address escrow_, address owner_) ReceiverTemplate(forwarder) {
        if (usdc_ == address(0)) revert ZeroUSDC();
        if (escrow_ == address(0)) revert ZeroEscrow();
        if (owner_ == address(0)) revert ZeroOwner();
        if (usdc_.code.length == 0) revert USDCNotContract();
        if (escrow_.code.length == 0) revert EscrowNotContract();
        usdc = usdc_;
        escrow = escrow_;
        _transferOwnership(owner_);
    }

    /// @notice Configure a nonzero jury contract once; only the owner may call.
    function setJury(address jury_) external onlyOwner {
        if (address(jury) != address(0)) revert JuryAlreadySet();
        if (jury_ == address(0)) revert ZeroJury();
        if (jury_.code.length == 0) revert JuryNotContract();
        jury = IJurorRegistry(jury_);
        emit JurySet(jury_);
    }

    /// @notice Open a case as the configured escrow without transferring funds.
    /// @dev Implements IAICourt.openCase.
    /// @return caseId Sequential identifier starting at one.
    function openCase(
        uint256 dealId,
        uint8 clauseId,
        address client,
        address freelancer,
        string calldata reason
    ) external override returns (uint256 caseId) {
        if (msg.sender != escrow) revert NotEscrow();
        caseId = ++caseCount;
        Case storage c = _cases[caseId];
        c.dealId = dealId;
        c.clauseId = clauseId;
        c.client = client;
        c.freelancer = freelancer;
        c.openedAt = uint64(block.timestamp);
        c.deadline = uint64(block.timestamp + BASE_SECS);
        c.wordBudget = WORD_BUDGET;
        // Fresh sequential identifiers leave extensions, nextRound and AI fields zero.
        emit CaseOpened(caseId, dealId, clauseId, reason, c.deadline);
    }

    /// @notice Return a known case, including its appeal and final settlement state.
    function getCase(uint256 caseId) external view returns (Case memory) {
        return _requireCase(caseId);
    }

    /// @notice Return the latest report for judge 0, 1 or 2 of a known case.
    /// @dev Before a judge's first report, all fields are zero.
    function judgeLatest(uint256 caseId, uint8 judge) external view returns (Judge memory) {
        _requireCase(caseId);
        if (judge >= 3) revert InvalidJudge(judge);
        return _judges[caseId][judge];
    }

    /// @notice Close a reported case after its deadline or when all judges are final.
    /// @dev No external calls. The median of three bands also selects any majority band.
    function closeCase(uint256 caseId) external {
        Case storage c = _requireCase(caseId);
        if (c.aiSet) revert AlreadyClosed();
        if (c.nextRound == 0) revert NoRoundReported();
        Judge[3] storage judges = _judges[caseId];
        if (block.timestamp <= c.deadline && !(judges[0].isFinal && judges[1].isFinal && judges[2].isFinal)) {
            revert CannotCloseYet();
        }

        uint8 a = judges[0].band;
        uint8 b = judges[1].band;
        uint8 d = judges[2].band;
        if (a > b) (a, b) = (b, a);
        if (b > d) (b, d) = (d, b);
        if (a > b) (a, b) = (b, a);

        c.aiSet = true;
        c.aiBand = b;
        c.appealDeadline = uint64(block.timestamp + APPEAL_WINDOW);
        emit AIVerdict(caseId, b, c.appealDeadline);
    }

    /// @notice Return the appeal fee from the immutable escrow's clause amount.
    /// @dev Multiply before division; amounts are raw USDC units.
    function appealFee(uint256 caseId) public view returns (uint256) {
        Case storage c = _requireCase(caseId);
        return IClauseEscrowView(escrow).getClause(c.dealId, c.clauseId).amount * APPEAL_BPS / BPS_DENOMINATOR;
    }

    /// @notice Either party may pay once to appeal during the inclusive appeal window.
    /// @dev Store all appeal effects before the token transfer and panel-opening interaction.
    function appeal(uint256 caseId) external nonReentrant {
        Case storage c = _requireCase(caseId);
        if (msg.sender != c.client && msg.sender != c.freelancer) revert NotParty();
        if (!c.aiSet) revert NoAiVerdict();
        if (c.appealed) revert AlreadyAppealed();
        if (block.timestamp > c.appealDeadline) revert AppealWindowClosed();
        if (address(jury) == address(0)) revert JuryNotSet();
        uint256 fee = appealFee(caseId);

        c.appealed = true;
        c.appellant = msg.sender;
        c.appealedAt = uint64(block.timestamp);
        c.feePaid = fee;
        c.feeSettled = false;

        IERC20(usdc).safeTransferFrom(msg.sender, address(this), fee);
        jury.openPanel(caseId, c.client, c.freelancer);
        emit Appealed(caseId, msg.sender, fee);
    }

    /// @notice Finalize the AI outcome after the window, or a decided jury outcome.
    /// @dev Commit all state before any transfers. A rescued fee is never paid again.
    ///      A 255 outcome or empty majority refunds the appellant. Otherwise the final
    ///      majority member receives division dust. Failed USDC payments become claimable
    ///      credits, so a blocked recipient does not block verdict finalization.
    function finalize(uint256 caseId) external nonReentrant {
        Case storage c = _requireCase(caseId);
        if (!c.aiSet) revert NoAiVerdict();
        if (c.finalized) revert AlreadyFinalized();

        uint8 finalBand = c.aiBand;
        bool byHumans;
        address[] memory majority = new address[](0);
        if (!c.appealed) {
            if (block.timestamp <= c.appealDeadline) revert AppealWindowOpen();
        } else {
            (bool decided, uint8 band, address[] memory members) = jury.decision(caseId);
            if (!decided) revert JuryNotDecided();
            if (band != 255) {
                if (band != 0 && band != 50 && band != 80 && band != 100) revert InvalidBand(band);
                finalBand = band;
                byHumans = true;
                majority = members;
            }
        }

        bool payFee = !c.feeSettled;
        uint256 fee = c.feePaid;
        c.finalized = true;
        c.finalBand = finalBand;
        c.byHumans = byHumans;
        if (payFee) c.feeSettled = true;
        emit Finalized(caseId, finalBand, byHumans);

        if (payFee && fee != 0) {
            uint256 n = majority.length;
            if (n == 0) {
                _payOrCredit(c.appellant, fee);
            } else {
                uint256 share = fee / n;
                for (uint256 i = 0; i < n; ++i) {
                    uint256 amount = i == n - 1 ? fee - share * (n - 1) : share;
                    _payOrCredit(majority[i], amount);
                }
            }
        }
    }

    /// @notice Return an unsettled appeal fee after the rescue delay, without setting a verdict.
    /// @dev The shared feeSettled flag ensures each fee is paid or credited exactly once.
    ///      A blocked appellant receives a credit instead of blocking rescue.
    function rescueFee(uint256 caseId) external nonReentrant {
        Case storage c = _requireCase(caseId);
        if (!c.appealed) revert NotAppealed();
        if (c.feeSettled) revert FeeAlreadySettled();
        if (block.timestamp <= uint256(c.appealedAt) + RESCUE_DELAY) revert RescueTooEarly();

        c.feeSettled = true;
        uint256 fee = c.feePaid;
        _payOrCredit(c.appellant, fee);
        emit FeeRescued(caseId, c.appellant, fee);
    }

    /// @notice Withdraw all of the caller's credited fees to the caller.
    /// @dev Clear the credit before transfer; a failed transfer restores it by reverting.
    function claimFee() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        totalClaimable -= amount;
        IERC20(usdc).safeTransfer(msg.sender, amount);
        emit FeeClaimed(msg.sender, amount);
    }

    /// @notice Return the final verdict, or (false, 0) for unknown or unfinished cases.
    function finalVerdict(uint256 caseId) external view override returns (bool isFinal, uint8 band) {
        if (caseId == 0 || caseId > caseCount) return (false, 0);
        Case storage c = _cases[caseId];
        if (!c.finalized) return (false, 0);
        return (true, c.finalBand);
    }

    /// @notice Validate and store a kind-six round report from the configured forwarder.
    /// @dev Decode one static tuple. The inherited external getter requires a self-call;
    ///      this read occurs before effects. No external calls or transfers follow effects.
    ///      Round allowance uses extensions before this report's extension decision.
    function _processReport(bytes calldata report) internal override {
        address f = this.getForwarderAddress();
        if (f == address(0) || msg.sender != f) revert UnauthorizedReportForwarder();
        (
            uint8 kind,
            uint256 caseId,
            uint8 round,
            uint8[3] memory bands,
            uint16[3] memory wordsUsed,
            bool[3] memory wantsExtend,
            bool[3] memory isFinal,
            uint8[3] memory citedMask,
            bytes32 transcriptHash
        ) = abi.decode(report, (uint8, uint256, uint8, uint8[3], uint16[3], bool[3], bool[3], uint8[3], bytes32));

        if (kind != 6) revert InvalidReportKind(kind);
        Case storage c = _requireCase(caseId);
        if (c.aiSet) revert AiVerdictAlreadySet();
        if (round != c.nextRound) revert WrongRound(c.nextRound, round);
        if (round >= MAX_ROUNDS + c.extensions) revert RoundLimitReached();
        if (block.timestamp > c.deadline) revert DeadlinePassed();

        uint8 extensionVotes;
        for (uint8 i = 0; i < 3; ++i) {
            uint8 band = bands[i];
            if (band != 0 && band != 50 && band != 80 && band != 100) revert InvalidBand(band);
            if (wordsUsed[i] > c.wordBudget) revert WordsOverBudget(i, wordsUsed[i], c.wordBudget);
            if ((citedMask[i] & ~uint8(0x07)) != 0) revert InvalidCitedMask(i, citedMask[i]);
            if (wantsExtend[i]) ++extensionVotes;
        }

        for (uint8 i = 0; i < 3; ++i) {
            _judges[caseId][i] = Judge({
                wordsUsed: wordsUsed[i],
                band: bands[i],
                wantsExtend: wantsExtend[i],
                isFinal: isFinal[i],
                citedMask: citedMask[i]
            });
            emit JudgeUpdated(caseId, round, i, bands[i], wordsUsed[i], wantsExtend[i], isFinal[i], citedMask[i]);
        }

        if (extensionVotes >= 2 && c.extensions < MAX_EXT) {
            ++c.extensions;
            c.wordBudget += EXTEND_WORDS;
            uint256 extendedDeadline = uint256(c.deadline) + EXTEND_SECS;
            uint256 hardDeadline = uint256(c.openedAt) + HARD_CAP_SECS;
            c.deadline = uint64(extendedDeadline < hardDeadline ? extendedDeadline : hardDeadline);
            emit ExtensionGranted(caseId, c.wordBudget, c.deadline);
        }
        ++c.nextRound;
        emit RoundCompleted(caseId, round, transcriptHash);
    }

    /// @dev Push first, crediting failed payments. Assumes a standard bool-returning ERC-20
    ///      such as USDC; tokens returning no data are unsupported and may revert on decoding.
    function _payOrCredit(address to, uint256 amount) private {
        if (amount == 0) return;
        try IERC20(usdc).transfer(to, amount) returns (bool ok) {
            if (!ok) {
                _credit(to, amount);
            }
        } catch {
            _credit(to, amount);
        }
    }

    /// @dev Record an undelivered payment exactly once, backed by retained USDC.
    function _credit(address to, uint256 amount) private {
        claimable[to] += amount;
        totalClaimable += amount;
        emit FeeCredited(to, amount);
    }

    /// @dev Require an existing sequential case identifier.
    function _requireCase(uint256 caseId) private view returns (Case storage c) {
        if (caseId == 0 || caseId > caseCount) revert UnknownCase(caseId);
        return _cases[caseId];
    }
}
