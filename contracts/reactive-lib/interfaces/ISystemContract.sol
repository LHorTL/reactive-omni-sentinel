// SPDX-License-Identifier: MIT
// Vendored from Reactive-Network/reactive-lib-omni (src/interfaces/ISystemContract.sol)

pragma solidity ^0.8.29;

import { IPayable } from "./IPayable.sol";
import { ISubscriptionService } from "./ISubscriptionService.sol";

/**
 * @title Interface for the Reactive Network's system contract (Reactive Omni).
 */
interface ISystemContract is IPayable, ISubscriptionService {
    /// @notice List of supported callback configuration versions.
    enum CallbackVersion {
        V_1_0
    }

    /// @notice Callback configuration struct for V_1_0 callbacks.
    struct CallbackConfiguration_V_1_0 {
        uint256 chainId;
        address recipient;
        uint64 gasLimit;
        bytes payload;
    }

    /// @notice Requests the posting of a callback to some destination network.
    function requestCallback(CallbackVersion version_, bytes memory config_) external;

    /// @notice Requests the posting of a V_1_0 callback to some destination network.
    function requestCallbackV_1_0(CallbackConfiguration_V_1_0 memory config_) external;
}
