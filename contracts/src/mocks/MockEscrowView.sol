// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IClauseEscrowView} from "../JurorRegistry.sol";

/// @notice Tests only. Lets tests set a deal's parties and clause statuses directly.
contract MockEscrowView is IClauseEscrowView {
    mapping(uint256 => Deal) private _deals;
    mapping(uint256 => Clause[]) private _clauses;

    function setDeal(uint256 dealId, address brand, address creator, uint8[] calldata statuses) external {
        _deals[dealId] = Deal(brand, creator, address(0), 0, bytes32(0), true, true);
        delete _clauses[dealId];
        for (uint256 i = 0; i < statuses.length; i++) {
            _clauses[dealId].push(Clause(0, 0, "", 0, 1, 255, 0, 0, 0, statuses[i], 0));
        }
    }

    function setStatus(uint256 dealId, uint8 clauseId, uint8 status) external {
        _clauses[dealId][clauseId].status = status;
    }

    function getDeal(uint256 dealId) external view returns (Deal memory) {
        return _deals[dealId];
    }

    function getClauses(uint256 dealId) external view returns (Clause[] memory) {
        return _clauses[dealId];
    }
}
