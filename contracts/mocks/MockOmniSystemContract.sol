// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ISystemContract } from "../reactive-lib/interfaces/ISystemContract.sol";
import { IReactive } from "../reactive-lib/interfaces/IReactive.sol";
import { IPayer } from "../reactive-lib/interfaces/IPayer.sol";

/**
 * @title MockOmniSystemContract
 * @notice Faithful local Hardhat simulator of Reactive Omni `SystemContract` (0x8888...8888).
 * @dev Deployed at 0x8888888888888888888888888888888888888888 via `hardhat_setCode` in tests so
 *      `OmniGuardReactive` runs unmodified against the real `SYSTEM` constant.
 */
contract MockOmniSystemContract is ISystemContract {
    struct Subscription {
        address subscriber;
        uint256 chainId;
        address contractAddress;
        uint256 topic0;
        uint256 topic1;
        uint256 topic2;
        uint256 topic3;
        bool active;
    }

    struct PendingCallback {
        uint256 chainId;
        address reactiveSender;
        address recipient;
        uint64 gasLimit;
        bytes payload;
    }

    event Subscribe(
        address indexed subscriber,
        uint256 indexed chainId,
        address indexed contractAddress,
        uint256 topic0,
        uint256 topic1,
        uint256 topic2,
        uint256 topic3
    );

    event Unsubscribe(
        address indexed subscriber,
        uint256 indexed chainId,
        address indexed contractAddress,
        uint256 topic0,
        uint256 topic1,
        uint256 topic2,
        uint256 topic3
    );

    event CallbackRequest(
        uint256 indexed chainId_,
        address indexed sender_,
        address indexed recipient_,
        CallbackVersion version_,
        bytes configuration_
    );

    event ReactiveContractReverted(address indexed reactive_, IReactive.LogRecord log_, bytes error_);
    event ReactGasMeasured(address indexed reactive_, uint256 gasUsed);

    mapping(address => uint256) private _debts;
    Subscription[] public subscriptions;
    PendingCallback[] public pendingCallbacks;
    uint256 public fixedFeeWei;
    uint256 public lastReactGasUsed;

    function resetForTest() external {
        delete subscriptions;
        delete pendingCallbacks;
        fixedFeeWei = 0;
        lastReactGasUsed = 0;
    }

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

    function subscribe(
        uint256 chainId_,
        address contract_,
        uint256 topic0_,
        uint256 topic1_,
        uint256 topic2_,
        uint256 topic3_
    ) external override {
        subscriptions.push(
            Subscription({
                subscriber: msg.sender,
                chainId: chainId_,
                contractAddress: contract_,
                topic0: topic0_,
                topic1: topic1_,
                topic2: topic2_,
                topic3: topic3_,
                active: true
            })
        );
        emit Subscribe(msg.sender, chainId_, contract_, topic0_, topic1_, topic2_, topic3_);
    }

    function unsubscribe(
        uint256 chainId_,
        address contract_,
        uint256 topic0_,
        uint256 topic1_,
        uint256 topic2_,
        uint256 topic3_
    ) external override {
        for (uint256 i = 0; i < subscriptions.length; ++i) {
            Subscription storage s = subscriptions[i];
            if (
                s.active &&
                s.subscriber == msg.sender &&
                s.chainId == chainId_ &&
                s.contractAddress == contract_ &&
                s.topic0 == topic0_
            ) {
                s.active = false;
            }
        }
        emit Unsubscribe(msg.sender, chainId_, contract_, topic0_, topic1_, topic2_, topic3_);
    }

    function requestCallback(CallbackVersion version_, bytes memory config_) external override {
        require(version_ == CallbackVersion.V_1_0, "Invalid version");
        CallbackConfiguration_V_1_0 memory cfg = abi.decode(config_, (CallbackConfiguration_V_1_0));
        _storeCallback(cfg, version_, config_);
    }

    function requestCallbackV_1_0(CallbackConfiguration_V_1_0 memory config_) external override {
        _storeCallback(config_, CallbackVersion.V_1_0, abi.encode(config_));
    }

    function _storeCallback(
        CallbackConfiguration_V_1_0 memory cfg,
        CallbackVersion version_,
        bytes memory rawConfig
    ) internal {
        // Mirror Reactive Omni signer: overwrite bytes [4..36] (1st address arg) with msg.sender
        bytes memory injectedPayload = cfg.payload;
        if (injectedPayload.length >= 36) {
            address sender = msg.sender;
            assembly {
                mstore(add(injectedPayload, 36), sender)
            }
        }

        pendingCallbacks.push(
            PendingCallback({
                chainId: cfg.chainId,
                reactiveSender: msg.sender,
                recipient: cfg.recipient,
                gasLimit: cfg.gasLimit,
                payload: injectedPayload
            })
        );

        emit CallbackRequest(cfg.chainId, msg.sender, cfg.recipient, version_, rawConfig);
    }

    /// @notice Mirrors `SystemContract.trigger(contract_, log_)` in Reactive Omni.
    function trigger(IReactive contract_, IReactive.LogRecord calldata log_) external {
        require(_debts[address(contract_)] == 0, "InDebt");

        uint256 gasBefore = gasleft();
        try contract_.react(log_) {} catch (bytes memory err) {
            emit ReactiveContractReverted(address(contract_), log_, err);
        }
        uint256 measured = gasBefore - gasleft();
        lastReactGasUsed = measured;
        emit ReactGasMeasured(address(contract_), measured);

        if (fixedFeeWei > 0) {
            try IPayer(payable(address(contract_))).pay(fixedFeeWei) {} catch {
                _debts[address(contract_)] += fixedFeeWei;
            }
        }
    }

    function subscriptionCount() external view returns (uint256) {
        return subscriptions.length;
    }

    function pendingCallbackCount() external view returns (uint256) {
        return pendingCallbacks.length;
    }

    function getPendingCallback(uint256 index) external view returns (PendingCallback memory) {
        return pendingCallbacks[index];
    }
}
