// SPDX-License-Identifier: MIT
// Vendored from Reactive-Network/reactive-lib-omni (src/base/AbstractCallback.sol)

pragma solidity ^0.8.29;

import { IPayable } from "../interfaces/IPayable.sol";
import { AbstractPayer } from "./AbstractPayer.sol";

/**
 * @title Abstract base contract for destination contracts receiving Reactive Omni callbacks.
 */
abstract contract AbstractCallback is AbstractPayer {
    error CallbackNotAuthorized(address sender_, address expectedSender_);

    /// @notice Address of the authorized reactive contract on Reactive Network.
    address public immutable _CALLBACK_SENDER;

    constructor(IPayable callbackProxy_, address callbackSender_) AbstractPayer(callbackProxy_) {
        _CALLBACK_SENDER = callbackSender_;
    }

    modifier onlyCallbackSender(address callbackSender_) {
        _onlyCallbackSender(callbackSender_);
        _;
    }

    function _onlyCallbackSender(address callbackSender_) internal view {
        if (callbackSender_ != _CALLBACK_SENDER) {
            revert CallbackNotAuthorized(callbackSender_, _CALLBACK_SENDER);
        }
    }
}
