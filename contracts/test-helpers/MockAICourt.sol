// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IAICourt} from "../src/IAICourt.sol";

/// @dev Test-only AI court implementing the current IAICourt. Records every opened case;
///      tests set verdicts manually and can force case id 0 or a reverting finalVerdict.
contract MockAICourt is IAICourt {
    struct Case {
        uint256 dealId;
        uint8 clauseId;
        address client;
        address freelancer;
        string reason;
    }

    struct Verdict {
        bool isFinal;
        uint8 band;
    }

    error MockVerdictReverted();

    uint256 public caseCount;
    bool public returnZeroCaseId;
    bool public revertOnVerdict;
    mapping(uint256 => Case) private _cases;
    mapping(uint256 => Verdict) private _verdicts;

    function setReturnZeroCaseId(bool on) external {
        returnZeroCaseId = on;
    }

    function setRevertOnVerdict(bool on) external {
        revertOnVerdict = on;
    }

    function openCase(
        uint256 dealId,
        uint8 clauseId,
        address client,
        address freelancer,
        string calldata reason
    ) external returns (uint256 caseId) {
        if (returnZeroCaseId) return 0;
        caseId = ++caseCount;
        Case storage c = _cases[caseId];
        c.dealId = dealId;
        c.clauseId = clauseId;
        c.client = client;
        c.freelancer = freelancer;
        c.reason = reason;
    }

    function getCase(uint256 caseId) external view returns (Case memory) {
        return _cases[caseId];
    }

    function setVerdict(uint256 caseId, bool isFinal, uint8 band) external {
        _verdicts[caseId] = Verdict(isFinal, band);
    }

    /// @dev Raw return modes for finalVerdict:
    ///      0 normal, 1 empty returndata, 2 32-byte returndata only, 3 bool word = 2,
    ///      4 band word = 256, 5 invalid opcode (burns all forwarded gas), 6 final=1 with band word = `rawBand`.
    uint8 public mode;
    /// @dev Gas burned (in a loop) before answering, in every non-reverting mode.
    uint256 public burnGas;
    uint256 public rawBand;

    function setMode(uint8 m) external {
        mode = m;
    }

    function setBurnGas(uint256 g) external {
        burnGas = g;
    }

    function setRawBand(uint256 b) external {
        rawBand = b;
    }

    function finalVerdict(uint256 caseId) external view returns (bool isFinal, uint8 band) {
        if (revertOnVerdict) revert MockVerdictReverted();
        uint256 start = gasleft();
        uint256 target = burnGas;
        while (start - gasleft() < target) {}
        uint8 m = mode;
        if (m != 0) {
            uint256 rb = rawBand;
            assembly {
                switch m
                case 1 { return(0, 0) }
                case 2 {
                    mstore(0, 1)
                    return(0, 32)
                }
                case 3 {
                    mstore(0, 2)
                    mstore(32, 50)
                    return(0, 64)
                }
                case 4 {
                    mstore(0, 1)
                    mstore(32, 256)
                    return(0, 64)
                }
                case 5 { invalid() }
                case 6 {
                    mstore(0, 1)
                    mstore(32, rb)
                    return(0, 64)
                }
            }
        }
        Verdict storage v = _verdicts[caseId];
        return (v.isFinal, v.band);
    }
}
