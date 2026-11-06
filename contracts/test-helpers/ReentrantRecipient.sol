// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ITransferHook} from "./MockFlakyERC20.sol";

interface IClaimFee {
    function claimFee() external;
}

/// @dev Test-only recipient that re-enters `claimFee()` from the token transfer hook.
///      mode 0 = off, 1 = swallow the reentrant revert, 2 = bubble it (revert the transfer).
contract ReentrantRecipient is ITransferHook {
    IClaimFee public immutable court;
    uint8 public mode;
    uint256 public attempts;
    bool public reentrySucceeded;
    bytes4 public lastError;

    constructor(address court_) {
        court = IClaimFee(court_);
    }

    function setMode(uint8 m) external {
        mode = m;
    }

    function claim() external {
        court.claimFee();
    }

    function onTokenReceived() external override {
        if (mode == 0) return;
        ++attempts;
        try court.claimFee() {
            reentrySucceeded = true;
        } catch (bytes memory r) {
            if (r.length >= 4) {
                bytes4 sel;
                assembly {
                    sel := mload(add(r, 32))
                }
                lastError = sel;
            }
            if (mode == 2) {
                assembly {
                    revert(add(r, 32), mload(r))
                }
            }
        }
    }
}
