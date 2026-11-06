// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IReceiver} from "./IReceiver.sol";

/// @title ReceiverTemplate
/// @notice Base for contracts that receive Chainlink CRE reports.
/// @dev Modelled on Chainlink's `cre-templates` ReceiverTemplate, with one deliberate
///      difference: the forwarder can never be address(0). The upstream template treats
///      a zero forwarder as "accept anyone", which would let anybody forge reports.
///      Review against the upstream file before production use.
///
///      The owner can only manage the forwarder and the optional workflow checks. The
///      owner has NO power over deal money (see ClauseEscrow).
abstract contract ReceiverTemplate is IReceiver, Ownable {
    address private s_forwarder;
    address private s_expectedAuthor;
    bytes10 private s_expectedWorkflowName;
    bytes32 private s_expectedWorkflowId;

    error InvalidForwarder();
    error InvalidSender(address sender, address expected);
    error InvalidMetadata();
    error InvalidWorkflowId(bytes32 received, bytes32 expected);
    error InvalidAuthor(address received, address expected);
    error InvalidWorkflowName(bytes10 received, bytes10 expected);

    event ForwarderUpdated(address indexed previous, address indexed current);

    /// @param forwarder simulation: the mock forwarder (or the tester wallet in V1a);
    ///                  production: the KeystoneForwarder. See docs/INTERFACES.md.
    constructor(address forwarder) Ownable(msg.sender) {
        _setForwarder(forwarder);
    }

    /// @inheritdoc IReceiver
    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != s_forwarder) revert InvalidSender(msg.sender, s_forwarder);

        // Workflow checks are OFF by default. Do not set them in simulation (it fails);
        // set them for production, because the forwarder is shared by every workflow.
        if (s_expectedWorkflowId != bytes32(0) || s_expectedAuthor != address(0) || s_expectedWorkflowName != bytes10(0)) {
            if (metadata.length < 62) revert InvalidMetadata();
            bytes32 workflowId = bytes32(metadata[0:32]);
            bytes10 workflowName = bytes10(metadata[32:42]);
            address workflowOwner = address(bytes20(metadata[42:62]));

            if (s_expectedWorkflowId != bytes32(0) && workflowId != s_expectedWorkflowId) {
                revert InvalidWorkflowId(workflowId, s_expectedWorkflowId);
            }
            if (s_expectedAuthor != address(0) && workflowOwner != s_expectedAuthor) {
                revert InvalidAuthor(workflowOwner, s_expectedAuthor);
            }
            if (s_expectedWorkflowName != bytes10(0) && workflowName != s_expectedWorkflowName) {
                revert InvalidWorkflowName(workflowName, s_expectedWorkflowName);
            }
        }

        _processReport(report);
    }

    /// @dev Implemented by the consumer. Only reachable through `onReport`.
    function _processReport(bytes calldata report) internal virtual;

    function getForwarder() external view returns (address) {
        return s_forwarder;
    }

    function setForwarder(address forwarder) external onlyOwner {
        _setForwarder(forwarder);
    }

    function setExpectedWorkflowId(bytes32 id) external onlyOwner {
        s_expectedWorkflowId = id;
    }

    function setExpectedAuthor(address author) external onlyOwner {
        s_expectedAuthor = author;
    }

    function setExpectedWorkflowName(bytes10 name) external onlyOwner {
        s_expectedWorkflowName = name;
    }

    function supportsInterface(bytes4 interfaceId) public pure virtual override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function _setForwarder(address forwarder) private {
        if (forwarder == address(0)) revert InvalidForwarder();
        emit ForwarderUpdated(s_forwarder, forwarder);
        s_forwarder = forwarder;
    }
}
