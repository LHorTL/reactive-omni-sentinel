// SPDX-License-Identifier: MIT
// Vendored from Reactive-Network/reactive-lib-omni (src/base/AbstractPayer.sol)

pragma solidity ^0.8.29;

import { IPayer } from "../interfaces/IPayer.sol";
import { IPayable } from "../interfaces/IPayable.sol";

/**
 * @title Abstract base contract for contracts needing to handle payments to the system contract or callback proxies.
 */
abstract contract AbstractPayer is IPayer {
    error NotAuthorized(address sender_, address provider_);
    error InsufficientFunds(uint256 required_, uint256 available_);
    error TransferFailed();

    /// @notice Service provider contract allowed to request payments.
    IPayable public immutable _SERVICE_PROVIDER;

    constructor(IPayable serviceProvider_) {
        _SERVICE_PROVIDER = serviceProvider_;
    }

    /// @inheritdoc IPayer
    receive() external payable virtual {}

    modifier onlyServiceProvider() {
        _onlyServiceProvider();
        _;
    }

    function _onlyServiceProvider() internal view {
        if (msg.sender != address(_SERVICE_PROVIDER)) {
            revert NotAuthorized(msg.sender, address(_SERVICE_PROVIDER));
        }
    }

    /// @inheritdoc IPayer
    function pay(uint256 amount_) external onlyServiceProvider {
        _pay(payable(msg.sender), amount_);
    }

    function _coverDebt() internal {
        uint256 amount = _SERVICE_PROVIDER.debt(address(this));
        _pay(payable(_SERVICE_PROVIDER), amount);
    }

    function _pay(address payable recipient_, uint256 amount_) internal {
        if (address(this).balance < amount_) {
            revert InsufficientFunds(amount_, address(this).balance);
        }

        if (amount_ > 0) {
            (bool success, ) = payable(recipient_).call{ value: amount_ }(new bytes(0));

            if (!success) {
                revert TransferFailed();
            }
        }
    }
}
