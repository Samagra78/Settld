// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title JurorRegistry (v2)
/// @notice World ID-backed human arbitrators for Settld. Used ONLY when a party appeals the AI court.
///         - One human = one wallet: each World ID nullifier links to exactly one wallet, forever.
///           The link is proven by an attestation from the Settld backend, signed after it verified
///           the World ID proof (World ID's on-chain verifier is not on Arc testnet).
///         - AICourt opens a panel on appeal. The first 3 eligible people to commit take the seats.
///         - Votes are hidden (commit, then reveal) and are bands: 0 / 50 / 80 / 100 (freelancer %).
///         - Parties can never judge their own case, by wallet or by World ID.
///         - A track record per human: voting against the majority or not revealing is a strike.
///           2 strikes = suspended for good. A new wallet can't reset it (same World ID).
///         This contract never moves money. AICourt reads `decision(caseId)`.
contract JurorRegistry {
    uint8 public constant PANEL_SIZE = 3;
    uint64 public constant COMMIT_SECS = 120;
    uint64 public constant REVEAL_SECS = 60;
    uint8 public constant MAX_STRIKES = 2;
    uint8 public constant NO_DECISION = 255;

    address public immutable attester;
    address public immutable owner;
    address public court;

    // ------------------------------------------------------------------ people

    mapping(uint256 => address) public walletOf;   // nullifier → wallet
    mapping(address => uint256) public nullifierOf; // wallet → nullifier (0 = not registered)

    struct Profile {
        uint32 cases;
        uint32 withMajority;
        uint8 strikes;
        bool suspended;
    }

    mapping(uint256 => Profile) private _profiles; // by nullifier, so it follows the human

    // ------------------------------------------------------------------ panels

    struct Panel {
        address client;
        address freelancer;
        uint64 commitDeadline;
        uint64 revealDeadline; // set when the 3rd seat commits; otherwise commitDeadline + REVEAL_SECS
        uint8 commits;
        uint8 reveals;
        bool opened;
        bool closed;
        uint8 band;
        address[3] seats;
    }

    struct Vote {
        bytes32 commitment;
        uint8 band;
        bool revealed;
    }

    mapping(uint256 => Panel) private _panels;
    mapping(uint256 => mapping(address => Vote)) private _votes;
    mapping(uint256 => mapping(uint256 => bool)) public seated; // caseId → nullifier → has a seat
    mapping(uint256 => address[]) private _majority;

    // ------------------------------------------------------------------ events / errors

    event CourtSet(address court);
    event PersonRegistered(uint256 indexed nullifier, address indexed wallet);
    event PanelOpened(uint256 indexed caseId, uint64 commitDeadline);
    event VoteCommitted(uint256 indexed caseId, address indexed arbitrator);
    event VoteRevealed(uint256 indexed caseId, address indexed arbitrator, uint8 band);
    event PanelClosed(uint256 indexed caseId, uint8 band, uint8 majoritySize);
    event Struck(uint256 indexed nullifier, uint8 strikes, bool suspended);

    error ZeroAddress();
    error NotOwner();
    error NotCourt();
    error CourtAlreadySet();
    error InvalidNullifier();
    error NullifierAlreadyRegistered();
    error WalletAlreadyRegistered();
    error InvalidAttestation();
    error NotRegistered();
    error Suspended();
    error PanelExists();
    error NoPanel();
    error PanelIsClosed();
    error CommitClosed();
    error PanelFull();
    error PartyCannotJudge();
    error AlreadySeated();
    error EmptyCommitment();
    error NotSeated();
    error AlreadyRevealed();
    error NotRevealPhase();
    error InvalidBand();
    error CommitmentMismatch();
    error TooEarly();

    constructor(address attester_, address owner_) {
        if (attester_ == address(0) || owner_ == address(0)) revert ZeroAddress();
        attester = attester_;
        owner = owner_;
    }

    /// @notice One-time wiring to AICourt (owner only).
    function setCourt(address court_) external {
        if (msg.sender != owner) revert NotOwner();
        if (court != address(0)) revert CourtAlreadySet();
        if (court_ == address(0)) revert ZeroAddress();
        court = court_;
        emit CourtSet(court_);
    }

    // ------------------------------------------------------------------ registration

    /// @notice The message the attester signs (EIP-191 personal_sign over this hash).
    function attestationHash(uint256 nullifier, address wallet) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(nullifier, wallet));
    }

    /// @notice Link the caller's wallet to a World ID nullifier. One nullifier, one wallet, forever.
    function registerPerson(uint256 nullifier, bytes calldata signature) external {
        if (nullifier == 0) revert InvalidNullifier();
        if (walletOf[nullifier] != address(0)) revert NullifierAlreadyRegistered();
        if (nullifierOf[msg.sender] != 0) revert WalletAlreadyRegistered();

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(attestationHash(nullifier, msg.sender));
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || signer != attester) revert InvalidAttestation();

        walletOf[nullifier] = msg.sender;
        nullifierOf[msg.sender] = nullifier;
        emit PersonRegistered(nullifier, msg.sender);
    }

    function isRegistered(address wallet) external view returns (bool) {
        return nullifierOf[wallet] != 0;
    }

    function profile(uint256 nullifier)
        external
        view
        returns (uint32 cases, uint32 withMajority, uint8 strikes, bool suspended)
    {
        Profile storage p = _profiles[nullifier];
        return (p.cases, p.withMajority, p.strikes, p.suspended);
    }

    // ------------------------------------------------------------------ panel lifecycle

    /// @notice AICourt opens a panel when a party appeals.
    function openPanel(uint256 caseId, address client, address freelancer) external {
        if (msg.sender != court) revert NotCourt();
        if (client == address(0) || freelancer == address(0)) revert ZeroAddress();
        Panel storage p = _panels[caseId];
        if (p.opened) revert PanelExists();
        p.opened = true;
        p.client = client;
        p.freelancer = freelancer;
        p.commitDeadline = uint64(block.timestamp) + COMMIT_SECS;
        emit PanelOpened(caseId, p.commitDeadline);
    }

    /// @notice The hidden vote. commitment = keccak256(abi.encode(caseId, band, salt, msg.sender)).
    ///         The first PANEL_SIZE eligible people to commit are the panel.
    function commitVote(uint256 caseId, bytes32 commitment) external {
        Panel storage p = _panels[caseId];
        if (!p.opened) revert NoPanel();
        if (p.closed) revert PanelIsClosed();
        if (block.timestamp > p.commitDeadline) revert CommitClosed();
        if (p.commits >= PANEL_SIZE) revert PanelFull();
        if (commitment == bytes32(0)) revert EmptyCommitment();

        uint256 n = nullifierOf[msg.sender];
        if (n == 0) revert NotRegistered();
        if (_profiles[n].suspended) revert Suspended();
        // no conflict of interest: neither party's wallet nor their World ID may judge
        if (msg.sender == p.client || msg.sender == p.freelancer) revert PartyCannotJudge();
        if (n == nullifierOf[p.client] || n == nullifierOf[p.freelancer]) revert PartyCannotJudge();
        if (seated[caseId][n]) revert AlreadySeated();

        seated[caseId][n] = true;
        p.seats[p.commits] = msg.sender;
        p.commits++;
        _votes[caseId][msg.sender].commitment = commitment;
        if (p.commits == PANEL_SIZE) p.revealDeadline = uint64(block.timestamp) + REVEAL_SECS;
        emit VoteCommitted(caseId, msg.sender);
    }

    /// @notice Reveal the hidden vote. Opens once all seats committed or the commit window ended.
    function revealVote(uint256 caseId, uint8 band, bytes32 salt) external {
        Panel storage p = _panels[caseId];
        if (!p.opened) revert NoPanel();
        if (p.closed) revert PanelIsClosed();
        Vote storage v = _votes[caseId][msg.sender];
        if (v.commitment == bytes32(0)) revert NotSeated();
        if (v.revealed) revert AlreadyRevealed();
        bool revealOpen = p.commits == PANEL_SIZE || block.timestamp > p.commitDeadline;
        if (!revealOpen || block.timestamp > revealDeadline(caseId)) revert NotRevealPhase();
        if (!_validBand(band)) revert InvalidBand();
        if (commitmentHash(caseId, band, salt, msg.sender) != v.commitment) revert CommitmentMismatch();

        v.revealed = true;
        v.band = band;
        p.reveals++;
        emit VoteRevealed(caseId, msg.sender, band);
    }

    /// @notice Anyone (the keeper) closes the panel once every seat revealed or the reveal window ended.
    ///         - Majority (most common band held by more than half of the revealers): that band;
    ///           revealers who voted otherwise get a strike.
    ///         - No majority (e.g. 0 / 50 / 100): the middle band, no strikes, every revealer counts.
    ///         - Committed but never revealed: a strike.
    ///         - Nobody revealed: band = NO_DECISION (255); the court keeps the AI band.
    function closePanel(uint256 caseId) external {
        Panel storage p = _panels[caseId];
        if (!p.opened) revert NoPanel();
        if (p.closed) revert PanelIsClosed();
        bool allRevealed = p.commits == PANEL_SIZE && p.reveals == PANEL_SIZE;
        if (!allRevealed && block.timestamp <= revealDeadline(caseId)) revert TooEarly();
        p.closed = true;

        // collect revealed bands
        uint8[3] memory bands;
        uint8 r;
        for (uint8 i = 0; i < p.commits; i++) {
            Vote storage v = _votes[caseId][p.seats[i]];
            if (v.revealed) {
                bands[r] = v.band;
                r++;
            }
        }

        uint8 band = NO_DECISION;
        bool hasMajority;
        if (r > 0) {
            (uint8 top, uint8 count) = _mostCommon(bands, r);
            if (uint16(count) * 2 > r) {
                band = top;
                hasMajority = true;
            } else {
                band = _lowerMedian(bands, r);
            }
        }
        p.band = band;

        for (uint8 i = 0; i < p.commits; i++) {
            address seat = p.seats[i];
            uint256 n = nullifierOf[seat];
            Profile storage prof = _profiles[n];
            prof.cases++;
            Vote storage v = _votes[caseId][seat];
            bool inMajority = v.revealed && (!hasMajority || v.band == band);
            if (inMajority) {
                prof.withMajority++;
                _majority[caseId].push(seat);
            } else {
                _strike(n, prof);
            }
        }
        emit PanelClosed(caseId, band, uint8(_majority[caseId].length));
    }

    /// @notice Read by AICourt. `majority` gets the appeal fee.
    function decision(uint256 caseId) external view returns (bool decided, uint8 band, address[] memory majority) {
        Panel storage p = _panels[caseId];
        return (p.closed, p.band, _majority[caseId]);
    }

    /// @notice Everything the server / frontend needs to draw a panel.
    function getPanel(uint256 caseId)
        external
        view
        returns (
            address client,
            address freelancer,
            uint64 commitDeadline,
            uint64 revealEnd,
            uint8 commits,
            uint8 reveals,
            bool opened,
            bool closed,
            uint8 band,
            address[3] memory seats
        )
    {
        Panel storage p = _panels[caseId];
        return (
            p.client, p.freelancer, p.commitDeadline, revealDeadline(caseId),
            p.commits, p.reveals, p.opened, p.closed, p.band, p.seats
        );
    }

    function revealDeadline(uint256 caseId) public view returns (uint64) {
        Panel storage p = _panels[caseId];
        if (p.revealDeadline != 0) return p.revealDeadline;
        return p.commitDeadline + REVEAL_SECS;
    }

    function commitmentHash(uint256 caseId, uint8 band, bytes32 salt, address voter) public pure returns (bytes32) {
        return keccak256(abi.encode(caseId, band, salt, voter));
    }

    // ------------------------------------------------------------------ internals

    function _strike(uint256 n, Profile storage prof) private {
        if (prof.strikes < type(uint8).max) prof.strikes++;
        if (prof.strikes >= MAX_STRIKES) prof.suspended = true;
        emit Struck(n, prof.strikes, prof.suspended);
    }

    function _validBand(uint8 b) private pure returns (bool) {
        return b == 0 || b == 50 || b == 80 || b == 100;
    }

    function _mostCommon(uint8[3] memory b, uint8 n) private pure returns (uint8 top, uint8 count) {
        for (uint8 i = 0; i < n; i++) {
            uint8 c;
            for (uint8 j = 0; j < n; j++) if (b[j] == b[i]) c++;
            if (c > count) {
                count = c;
                top = b[i];
            }
        }
    }

    /// middle value of the revealed bands (lower of the two middles when there are 2)
    function _lowerMedian(uint8[3] memory b, uint8 n) private pure returns (uint8) {
        for (uint8 i = 1; i < n; i++) {
            uint8 k = b[i];
            uint8 j = i;
            while (j > 0 && b[j - 1] > k) {
                b[j] = b[j - 1];
                j--;
            }
            b[j] = k;
        }
        return b[(n - 1) / 2];
    }
}
