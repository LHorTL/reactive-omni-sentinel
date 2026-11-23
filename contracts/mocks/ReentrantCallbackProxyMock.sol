// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IPayable } from "../reactive-lib/interfaces/IPayable.sol";

/**
 * @title ReentrantCallbackProxyMock
 * @notice Adversarial mock proxy that attempts to re-enter `executeEmergencyDeleverage` when `coverDebt()`
 *         or `rescueNative()` sends ETH to it, proving `ReentrancyGuard` protection holds.
 */
contract ReentrantCallbackProxyMock is IPayable {
    address public targetVault;
    bytes public reentryPayload;
    bool public attackEnabled;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    mapping(address => uint256) private _debts;

    function configureAttack(address targetVault_, bytes calldata payload_, uint256 fakeDebt) external {
        targetVault = targetVault_;
        reentryPayload = payload_;
        _debts[targetVault_] = fakeDebt;
        attackEnabled = true;
        reentryAttempted = false;
        reentrySucceeded = false;
    }

    function debt(address contract_) external view override returns (uint256) {
        return _debts[contract_];
    }

    receive() external payable override {
        if (attackEnabled && !reentryAttempted && targetVault != address(0)) {
            reentryAttempted = true;
            (bool ok, ) = targetVault.call(reentryPayload);
            reentrySucceeded = ok;
        }
    }
}
