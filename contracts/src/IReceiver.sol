// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/// @notice Interface the Chainlink KeystoneForwarder calls to deliver a CRE report.
interface IReceiver is IERC165 {
    /// @param metadata packed as: bytes32 workflowId | bytes10 workflowName | address workflowOwner
    /// @param report   ABI-encoded report (see docs/INTERFACES.md)
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
