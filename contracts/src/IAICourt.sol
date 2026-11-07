// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAICourt {
    function openCase(
        uint256 dealId,
        uint8 clauseId,
        address client,
        address freelancer,
        string calldata reason
    ) external returns (uint256 caseId);

    function finalVerdict(uint256 caseId) external view returns (bool isFinal, uint8 band);
}
