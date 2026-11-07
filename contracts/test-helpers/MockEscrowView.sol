// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IAICourt} from "../src/IAICourt.sol";
import {IClauseEscrowView, Clause} from "../src/IClauseEscrowView.sol";

/// @dev Test-only stand-in for the court's `escrow`: opens cases on demand and answers
///      getClause with a configurable amount (global default, optional per-clause override).
contract MockEscrowView is IClauseEscrowView {
    IAICourt public court;
    uint256 public amount;
    mapping(uint256 => mapping(uint8 => uint256)) public amountOverride;
    mapping(uint256 => mapping(uint8 => bool)) public hasOverride;

    function setCourt(address court_) external {
        court = IAICourt(court_);
    }

    function setAmount(uint256 amount_) external {
        amount = amount_;
    }

    function setClauseAmount(uint256 dealId, uint8 clauseId, uint256 amount_) external {
        amountOverride[dealId][clauseId] = amount_;
        hasOverride[dealId][clauseId] = true;
    }

    function callOpenCase(uint256 dealId, uint8 clauseId, address client, address freelancer, string calldata reason)
        external
        returns (uint256)
    {
        return court.openCase(dealId, clauseId, client, freelancer, reason);
    }

    function getClause(uint256 dealId, uint8 clauseId) external view override returns (Clause memory c) {
        c.amount = hasOverride[dealId][clauseId] ? amountOverride[dealId][clauseId] : amount;
        c.param = "mock";
    }
}
