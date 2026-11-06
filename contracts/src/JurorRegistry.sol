// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @notice Read-only view of ClauseEscrow that the jury needs (matches the deployed ABI).
interface IClauseEscrowView {
    struct Deal {
        address brand;
        address creator;
        address token;
        uint256 total;
        bytes32 specHash;
        bool accepted;
        bool funded;
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

    function getDeal(uint256 dealId) external view returns (Deal memory);
    function getClauses(uint256 dealId) external view returns (Clause[] memory);
}

/// @title JurorRegistry
/// @notice World ID-backed jury for Settld disputes.
///         - One human = one seat: each World ID nullifier can be linked to exactly one wallet.
///         - The link is proven by an attestation signed by the Settld backend after it verified
///           the World ID proof (World ID's on-chain verifier is not on Arc testnet).
///         - A party to a deal (brand or creator, by wallet or by World ID) can never vote on it.
///         - The first JURY_SIZE eligible votes on a disputed clause decide it by majority.
///         ClauseEscrow (or anyone) reads `decision(dealId, clauseId)` to settle the clause —
///         this contract never moves money.
contract JurorRegistry {
    uint8 public constant JURY_SIZE = 3;
    uint8 public constant MAJORITY = 2;
    uint8 public constant STATUS_DISPUTED = 4;

    address public immutable attester;
    IClauseEscrowView public immutable escrow;

    /// nullifier → wallet, wallet → nullifier (0 = not registered)
    mapping(uint256 => address) public walletOf;
    mapping(address => uint256) public nullifierOf;

    struct Case {
        uint8 votesPay;
        uint8 votesRefund;
        bool decided;
        bool payCreator;
    }

    mapping(bytes32 => Case) private _cases;
    mapping(bytes32 => mapping(uint256 => bool)) public hasVoted; // caseKey → nullifier → voted

    event PersonRegistered(uint256 indexed nullifier, address indexed wallet);
    event Voted(uint256 indexed dealId, uint8 indexed clauseId, address indexed juror, bool payCreator);
    event Decided(uint256 indexed dealId, uint8 indexed clauseId, bool payCreator, uint8 votesPay, uint8 votesRefund);

    error ZeroAddress();
    error InvalidNullifier();
    error NullifierAlreadyRegistered();
    error WalletAlreadyRegistered();
    error InvalidAttestation();
    error NotRegistered();
    error NotDisputed(uint8 status);
    error UnknownClause();
    error PartyCannotVote();
    error AlreadyVoted();
    error AlreadyDecided();

    constructor(address attester_, address escrow_) {
        if (attester_ == address(0) || escrow_ == address(0)) revert ZeroAddress();
        attester = attester_;
        escrow = IClauseEscrowView(escrow_);
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

    // ------------------------------------------------------------------ voting

    function caseKey(uint256 dealId, uint8 clauseId) public pure returns (bytes32) {
        return keccak256(abi.encode(dealId, clauseId));
    }

    /// @notice Vote on a disputed clause: true = pay the creator, false = refund the brand.
    function vote(uint256 dealId, uint8 clauseId, bool payCreator) external {
        uint256 n = nullifierOf[msg.sender];
        if (n == 0) revert NotRegistered();

        bytes32 key = caseKey(dealId, clauseId);
        Case storage c = _cases[key];
        if (c.decided) revert AlreadyDecided();
        if (hasVoted[key][n]) revert AlreadyVoted();

        // the clause must be disputed right now
        IClauseEscrowView.Clause[] memory clauses = escrow.getClauses(dealId);
        if (clauseId >= clauses.length) revert UnknownClause();
        uint8 status = clauses[clauseId].status;
        if (status != STATUS_DISPUTED) revert NotDisputed(status);

        // no conflict of interest: neither party's wallet nor their World ID may vote
        IClauseEscrowView.Deal memory d = escrow.getDeal(dealId);
        if (msg.sender == d.brand || msg.sender == d.creator) revert PartyCannotVote();
        if (n == nullifierOf[d.brand] || n == nullifierOf[d.creator]) revert PartyCannotVote();

        hasVoted[key][n] = true;
        if (payCreator) c.votesPay++;
        else c.votesRefund++;
        emit Voted(dealId, clauseId, msg.sender, payCreator);

        if (c.votesPay >= MAJORITY || c.votesRefund >= MAJORITY) {
            c.decided = true;
            c.payCreator = c.votesPay >= MAJORITY;
            emit Decided(dealId, clauseId, c.payCreator, c.votesPay, c.votesRefund);
        }
    }

    /// @notice Result for a clause, read by ClauseEscrow to settle it.
    function decision(uint256 dealId, uint8 clauseId)
        external
        view
        returns (bool decided, bool payCreator, uint8 votesPay, uint8 votesRefund)
    {
        Case storage c = _cases[caseKey(dealId, clauseId)];
        return (c.decided, c.payCreator, c.votesPay, c.votesRefund);
    }
}
