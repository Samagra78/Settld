// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IJurorRegistry} from "../src/IJurorRegistry.sol";

/// @dev Test-only jury registry: records openPanel calls and returns a configurable decision.
contract MockJurorRegistry is IJurorRegistry {
    struct PanelCall {
        uint256 caseId;
        address client;
        address freelancer;
        address caller;
    }

    struct Decision {
        bool decided;
        uint8 band;
        address[] majority;
    }

    PanelCall[] internal _panelCalls;
    mapping(uint256 => Decision) internal _decisions;

    bool public openPanelReverts;
    bool public decisionReverts;

    error MockOpenPanelReverted();
    error MockDecisionReverted();

    function setOpenPanelReverts(bool v) external {
        openPanelReverts = v;
    }

    function setDecisionReverts(bool v) external {
        decisionReverts = v;
    }

    function setDecision(uint256 caseId, bool decided, uint8 band, address[] calldata majority) external {
        Decision storage d = _decisions[caseId];
        d.decided = decided;
        d.band = band;
        delete d.majority;
        for (uint256 i = 0; i < majority.length; ++i) {
            d.majority.push(majority[i]);
        }
    }

    function openPanel(uint256 caseId, address client, address freelancer) external override {
        if (openPanelReverts) revert MockOpenPanelReverted();
        _panelCalls.push(PanelCall(caseId, client, freelancer, msg.sender));
    }

    function decision(uint256 caseId)
        external
        view
        override
        returns (bool decided, uint8 band, address[] memory majority)
    {
        if (decisionReverts) revert MockDecisionReverted();
        Decision storage d = _decisions[caseId];
        return (d.decided, d.band, d.majority);
    }

    function panelCallCount() external view returns (uint256) {
        return _panelCalls.length;
    }

    function panelCall(uint256 i) external view returns (PanelCall memory) {
        return _panelCalls[i];
    }
}
