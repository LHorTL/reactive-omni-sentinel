// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IPayable } from "../reactive-lib/interfaces/IPayable.sol";
import { IPayer } from "../reactive-lib/interfaces/IPayer.sol";
import { ISystemContract } from "../reactive-lib/interfaces/ISystemContract.sol";

/**
 * @title MockOmniCallbackProxy
 * @notice Faithful local simulator of Reactive Omni `CallbackProxy` (Base Sepolia: 0x476F...3585).
 */
contract MockOmniCallbackProxy is IPayable {
    error InDebt(address target, uint256 debtAmount);
    error NotAContract(address target);
    error InsufficientGasLimit(uint64 gasLimit);

    event CallbackDelivered(address indexed target, bool success, bytes returnData);
    event CallbackFailure(address indexed target_, bytes payload_);

    mapping(address => uint256) private _debts;
    uint256 public fixedFeeWei;

    receive() external payable override {
        if (_debts[msg.sender] >= msg.value) {
            _debts[msg.sender] -= msg.value;
        } else {
            _debts[msg.sender] = 0;
        }
    }

    function setFixedFeeWei(uint256 feeWei) external {
        fixedFeeWei = feeWei;
    }

    function setDebt(address contract_, uint256 debtAmount) external {
        _debts[contract_] = debtAmount;
    }

    function debt(address contract_) external view override returns (uint256) {
        return _debts[contract_];
    }

    /**
     * @notice Delivers a V_1_0 callback payload to the destination contract and bills callback fee.
     * @dev Reverts on underlying failure when `strictRevert == true` (useful for Hardhat revert assertions),
     *      or emits `CallbackFailure` like production `CallbackProxy` when `strictRevert == false`.
     */
    function deliverCallback(
        ISystemContract.CallbackConfiguration_V_1_0 calldata config,
        bool strictRevert
    ) external returns (bool success, bytes memory returnData) {
        if (_debts[config.recipient] > 0) {
            revert InDebt(config.recipient, _debts[config.recipient]);
        }
        if (config.recipient.code.length == 0) {
            revert NotAContract(config.recipient);
        }
        if (config.gasLimit < 100_000) {
            revert InsufficientGasLimit(config.gasLimit);
        }

        (success, returnData) = config.recipient.call{ gas: config.gasLimit }(config.payload);

        if (!success) {
            if (strictRevert) {
                assembly {
                    revert(add(returnData, 32), mload(returnData))
                }
            }
            emit CallbackFailure(config.recipient, config.payload);
        }

        emit CallbackDelivered(config.recipient, success, returnData);

        if (fixedFeeWei > 0) {
            try IPayer(payable(config.recipient)).pay(fixedFeeWei) {} catch {
                _debts[config.recipient] += fixedFeeWei;
            }
        }
    }
}
