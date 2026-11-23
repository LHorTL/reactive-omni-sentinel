// SPDX-License-Identifier: MIT
// Vendored from Reactive-Network/reactive-lib-omni (src/interfaces/IReactive.sol)

pragma solidity ^0.8.29;

import { IPayer } from "./IPayer.sol";

/**
 * @title Interface for reactive contracts.
 * @notice Reactive contracts receive notifications about new events matching the criteria of their event subscriptions.
 */
interface IReactive is IPayer {
    /// @notice A standard representation of log records from EVM-style networks.
    struct LogRecord {
        uint256 chainId;
        address contractAddress;
        uint256 topic0;
        uint256 topic1;
        uint256 topic2;
        uint256 topic3;
        bytes data;
        uint256 blockNumber;
        uint256 opCode;
        uint256 blockHash;
        uint256 txHash;
        uint256 logIndex;
    }

    /// @notice Legacy callback event (deprecated in Reactive Omni in favor of SYSTEM.requestCallbackV_1_0).
    event Callback(
        uint256 indexed chainId_,
        address indexed contract_,
        uint64 indexed gasLimit_,
        bytes payload_
    );

    /// @notice Entry point for handling new event notifications.
    /// @param log_ Data structure containing the information about the intercepted log record.
    function react(LogRecord calldata log_) external;
}
