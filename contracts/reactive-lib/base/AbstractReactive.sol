// SPDX-License-Identifier: MIT
// Vendored from Reactive-Network/reactive-lib-omni (src/base/AbstractReactive.sol)

pragma solidity ^0.8.29;

import { ISystemContract } from "../interfaces/ISystemContract.sol";
import { IReactive } from "../interfaces/IReactive.sol";
import { AbstractPayer } from "./AbstractPayer.sol";

/**
 * @title Abstract base contract for reactive contracts on Reactive Omni.
 */
abstract contract AbstractReactive is AbstractPayer, IReactive {
    /// @notice Address of the Reactive Omni system contract (Lasna 5318007 & Mainnet 1597).
    ISystemContract internal constant SYSTEM = ISystemContract(payable(0x8888888888888888888888888888888888888888));

    /// @notice Predefined wildcard topic value for event subscriptions.
    uint256 internal constant REACTIVE_IGNORE = 0xa65f96fc951c35ead38878e0f0b7a3c744a6f5ccc1476b313353ce31712313ad;

    constructor() AbstractPayer(SYSTEM) {}

    /// @notice Guards methods that may only be called by the Reactive Omni system contract.
    modifier onlySystem() {
        _onlyServiceProvider();
        _;
    }
}
