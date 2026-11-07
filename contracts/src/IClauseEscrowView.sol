// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice ABI-compatible clause data returned by ClauseEscrow.getClause.
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

interface IClauseEscrowView {
    function getClause(uint256 dealId, uint8 clauseId) external view returns (Clause memory);
}
