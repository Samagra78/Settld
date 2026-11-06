// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IJurorRegistry
/// @notice Jury panel integration for court appeals.
interface IJurorRegistry {
    /// @notice Open a panel for a case and its two parties.
    function openPanel(uint256 caseId, address client, address freelancer) external;

    /// @notice Return the panel outcome and majority jurors.
    /// @dev A band of 255 means nobody revealed a decision.
    function decision(uint256 caseId)
        external
        view
        returns (bool decided, uint8 band, address[] memory majority);
}
