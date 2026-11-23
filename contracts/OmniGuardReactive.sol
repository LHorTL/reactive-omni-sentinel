// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ISystemContract } from "./reactive-lib/interfaces/ISystemContract.sol";
import { IReactive } from "./reactive-lib/interfaces/IReactive.sol";
import { AbstractReactive } from "./reactive-lib/base/AbstractReactive.sol";

/**
 * @title OmniGuardReactive
 * @notice Reactive Omni smart contract deployed on Reactive Lasna (Chain ID 5318007) delivering ~1s CometBFT
 *         finality liquidation protection & automated circuit breaking for `OriginPriceVault` on Base Sepolia (84532).
 * @dev Implements genuine stateful multi-tier escalation (`SAFE` -> `WARN` -> `REBALANCE` -> `EMERGENCY_FREEZE`)
 *      with wall-clock timestamp cooldowns (`block.timestamp` / `eventTs`, NEVER block counts — safe for Base
 *      Sepolia's 200ms blocks!), consecutive-warning auto-escalation, monotonic nonces, and non-reverting `react()`
 *      discipline to avoid wasting Reactive gas on non-actionable logs.
 */
contract OmniGuardReactive is AbstractReactive {
    // -------------------------------------------------------------------------
    // Types & Constants
    // -------------------------------------------------------------------------

    enum ActionTier {
        SAFE,
        WARN,
        REBALANCE,
        EMERGENCY_FREEZE
    }

    struct UserRiskState {
        ActionTier lastTier;
        uint256 lastHealthBps;
        uint256 lastEventTs;
        uint256 lastCallbackTs;
        uint256 lastWarnTs;
        uint256 warnStreak;
        uint256 actionNonce;
        uint256 totalCallbacksTriggered;
    }

    /// @notice keccak256("HealthFactorChanged(address,uint256,uint256,uint256,uint256)")
    uint256 public constant HEALTH_FACTOR_TOPIC0 =
        uint256(keccak256("HealthFactorChanged(address,uint256,uint256,uint256,uint256)"));

    uint64 public constant MIN_CALLBACK_GAS_LIMIT = 150_000; // safely above Reactive's 100k minimum
    uint64 public constant MAX_CALLBACK_GAS_LIMIT = 2_000_000;
    uint256 public constant MIN_DECODE_DATA_BYTES = 128; // 4 x uint256 ABI words

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error OnlyOwner(address caller);
    error ZeroAddress();
    error ZeroAmount();
    error InvalidChainId();
    error InvalidGasLimit(uint64 gasLimit);
    error InvalidThresholds();
    error InvalidCooldownConfig();
    error VaultAlreadySubscribed();
    error VaultNotSubscribed();

    // -------------------------------------------------------------------------
    // State Variables
    // -------------------------------------------------------------------------

    address public owner;
    bool public paused;

    uint256 public originChainId;
    uint256 public destChainId;
    address public originVault;
    address public callbackVault;
    bool public subscribed;
    uint64 public callbackGasLimit;

    // Multi-tier thresholds (in basis points; 10000 = 1.00x)
    uint256 public warnThresholdBps = 13_500; // 1.35x -> WARN
    uint256 public rebalanceThresholdBps = 12_000; // 1.20x -> REBALANCE
    uint256 public freezeThresholdBps = 10_800; // 1.08x -> EMERGENCY_FREEZE
    uint256 public targetHealthBps = 15_000; // 1.50x restored target

    // Wall-clock timestamp controls (seconds — immune to Base Sepolia's 200ms block cadence!)
    uint256 public rebalanceCooldownSeconds = 15;
    uint256 public emergencyCooldownSeconds = 5;
    uint256 public escalationWindowSeconds = 60;
    uint256 public warnEscalationCount = 2; // 2 consecutive WARN events within window -> REBALANCE

    // Aggregate telemetry
    uint256 public totalEventsProcessed;
    uint256 public totalCallbacksRequested;
    uint256 public totalCooldownSuppressions;
    uint256 public totalEmergencyFreezesRequested;

    mapping(address => UserRiskState) private _userStates;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event VaultSubscribed(
        uint256 indexed originChainId,
        address indexed originVault,
        uint256 indexed destChainId,
        address callbackVault
    );

    event VaultUnsubscribed(uint256 indexed originChainId, address indexed originVault);

    event RiskEvaluated(
        address indexed user,
        ActionTier indexed tier,
        uint256 healthBps,
        uint256 warnStreak,
        bool callbackDispatched,
        uint256 effectiveTs
    );

    event ShieldCallbackDispatched(
        address indexed user,
        ActionTier indexed tier,
        uint256 healthBps,
        uint256 targetBps,
        uint256 actionNonce,
        uint256 triggerTs,
        uint256 destChainId,
        address callbackVault
    );

    event CooldownSuppressed(
        address indexed user,
        ActionTier indexed attemptedTier,
        uint256 healthBps,
        uint256 effectiveTs,
        uint256 nextAllowedTs
    );

    event ReactionIgnored(bytes32 indexed reason, uint256 chainId, address contractAddress);
    event ThresholdsUpdated(uint256 warnBps, uint256 rebalanceBps, uint256 freezeBps, uint256 targetBps);
    event CooldownsUpdated(
        uint256 rebalanceCooldownSec,
        uint256 emergencyCooldownSec,
        uint256 escalationWindowSec,
        uint256 warnEscalationCount
    );
    event CallbackGasLimitUpdated(uint64 newGasLimit);
    event PausedStateChanged(bool paused);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event NativeRescued(address indexed to, uint256 amount);

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner(msg.sender);
        _;
    }

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /**
     * @notice Deploys the Reactive Omni sentinel.
     * @dev Following official Reactive Omni deployment order, `originVault_` and `callbackVault_` may be passed as
     *      `address(0)` at construction so `OriginPriceVault` can bind immutable `_CALLBACK_SENDER = address(this)`,
     *      followed immediately by `configureVaultAndSubscribe(originVault, callbackVault)`.
     */
    constructor(
        uint256 originChainId_,
        uint256 destChainId_,
        address originVault_,
        address callbackVault_,
        uint64 callbackGasLimit_
    ) payable {
        if (originChainId_ == 0 || destChainId_ == 0) revert InvalidChainId();
        if (callbackGasLimit_ < MIN_CALLBACK_GAS_LIMIT || callbackGasLimit_ > MAX_CALLBACK_GAS_LIMIT) {
            revert InvalidGasLimit(callbackGasLimit_);
        }

        owner = msg.sender;
        originChainId = originChainId_;
        destChainId = destChainId_;
        callbackGasLimit = callbackGasLimit_;

        if (originVault_ != address(0)) {
            if (callbackVault_ == address(0)) revert ZeroAddress();
            originVault = originVault_;
            callbackVault = callbackVault_;
            _subscribeCurrent();
        }
    }

    // -------------------------------------------------------------------------
    // Core Reactive Omni Entry Point
    // -------------------------------------------------------------------------

    /**
     * @notice Invoked automatically by Reactive Omni `SYSTEM` (`0x8888...8888`) when `HealthFactorChanged` fires.
     * @dev Strictly guarded by `onlySystem`. Uses non-reverting exits for non-actionable / paused / cooled-down logs
     *      so Reactive gas reserves are never burned on unnecessary `ReactiveContractReverted` failures.
     */
    function react(LogRecord calldata log_) external override onlySystem {
        if (paused) {
            emit ReactionIgnored("PAUSED", log_.chainId, log_.contractAddress);
            return;
        }
        if (callbackVault == address(0) || originVault == address(0)) {
            emit ReactionIgnored("UNCONFIGURED", log_.chainId, log_.contractAddress);
            return;
        }
        if (
            log_.chainId != originChainId ||
            log_.contractAddress != originVault ||
            log_.topic0 != HEALTH_FACTOR_TOPIC0
        ) {
            emit ReactionIgnored("FILTER_MISMATCH", log_.chainId, log_.contractAddress);
            return;
        }
        if (log_.data.length < MIN_DECODE_DATA_BYTES) {
            emit ReactionIgnored("MALFORMED_DATA", log_.chainId, log_.contractAddress);
            return;
        }

        address user = address(uint160(log_.topic1));
        if (user == address(0)) {
            emit ReactionIgnored("ZERO_USER", log_.chainId, log_.contractAddress);
            return;
        }

        (uint256 healthBps, , uint256 debt, uint256 eventTs) = abi.decode(
            log_.data,
            (uint256, uint256, uint256, uint256)
        );

        uint256 effectiveTs = eventTs > 0 ? eventTs : block.timestamp;
        UserRiskState storage state = _userStates[user];

        // Ignore out-of-order stale logs older than the latest processed timestamp for this user
        if (state.lastEventTs > 0 && effectiveTs < state.lastEventTs) {
            emit ReactionIgnored("STALE_EVENT_TS", log_.chainId, log_.contractAddress);
            return;
        }

        totalEventsProcessed += 1;
        state.lastHealthBps = healthBps;
        state.lastEventTs = effectiveTs;

        // Zero-debt position is unconditionally safe
        if (debt == 0 || healthBps >= warnThresholdBps) {
            state.lastTier = ActionTier.SAFE;
            state.warnStreak = 0;
            emit RiskEvaluated(user, ActionTier.SAFE, healthBps, 0, false, effectiveTs);
            return;
        }

        // Tier 3: Imminent Liquidation / Critical Insolvency -> EMERGENCY_FREEZE
        if (healthBps < freezeThresholdBps) {
            bool isImmediateEscalation = state.lastTier != ActionTier.EMERGENCY_FREEZE;
            bool emergencyCooldownPassed =
                state.lastCallbackTs == 0 ||
                effectiveTs >= state.lastCallbackTs + emergencyCooldownSeconds;

            if (!isImmediateEscalation && !emergencyCooldownPassed) {
                totalCooldownSuppressions += 1;
                emit CooldownSuppressed(
                    user,
                    ActionTier.EMERGENCY_FREEZE,
                    healthBps,
                    effectiveTs,
                    state.lastCallbackTs + emergencyCooldownSeconds
                );
                emit RiskEvaluated(user, ActionTier.EMERGENCY_FREEZE, healthBps, state.warnStreak, false, effectiveTs);
                return;
            }

            state.warnStreak = 0;
            totalEmergencyFreezesRequested += 1;
            _dispatchCallback(user, state, ActionTier.EMERGENCY_FREEZE, healthBps, effectiveTs);
            return;
        }

        // Tier 2: Rebalance Breach -> REBALANCE (subject to wall-clock cooldown)
        if (healthBps < rebalanceThresholdBps) {
            if (
                state.lastCallbackTs != 0 &&
                effectiveTs < state.lastCallbackTs + rebalanceCooldownSeconds
            ) {
                totalCooldownSuppressions += 1;
                emit CooldownSuppressed(
                    user,
                    ActionTier.REBALANCE,
                    healthBps,
                    effectiveTs,
                    state.lastCallbackTs + rebalanceCooldownSeconds
                );
                emit RiskEvaluated(user, ActionTier.REBALANCE, healthBps, state.warnStreak, false, effectiveTs);
                return;
            }

            state.warnStreak = 0;
            _dispatchCallback(user, state, ActionTier.REBALANCE, healthBps, effectiveTs);
            return;
        }

        // Tier 1: Early Warning Zone (rebalanceThresholdBps <= healthBps < warnThresholdBps)
        // Tracks consecutive deteriorating warnings within `escalationWindowSeconds` and auto-escalates to REBALANCE.
        if (state.lastWarnTs > 0 && effectiveTs <= state.lastWarnTs + escalationWindowSeconds) {
            state.warnStreak += 1;
        } else {
            state.warnStreak = 1;
        }
        state.lastWarnTs = effectiveTs;

        if (state.warnStreak >= warnEscalationCount) {
            if (
                state.lastCallbackTs != 0 &&
                effectiveTs < state.lastCallbackTs + rebalanceCooldownSeconds
            ) {
                totalCooldownSuppressions += 1;
                state.lastTier = ActionTier.WARN;
                emit CooldownSuppressed(
                    user,
                    ActionTier.REBALANCE,
                    healthBps,
                    effectiveTs,
                    state.lastCallbackTs + rebalanceCooldownSeconds
                );
                emit RiskEvaluated(user, ActionTier.WARN, healthBps, state.warnStreak, false, effectiveTs);
                return;
            }

            state.warnStreak = 0;
            _dispatchCallback(user, state, ActionTier.REBALANCE, healthBps, effectiveTs);
            return;
        }

        state.lastTier = ActionTier.WARN;
        emit RiskEvaluated(user, ActionTier.WARN, healthBps, state.warnStreak, false, effectiveTs);
    }

    // -------------------------------------------------------------------------
    // Subscription & Configuration Management (Owner Only)
    // -------------------------------------------------------------------------

    /**
     * @notice Configures target vault addresses and registers the live event subscription on `SYSTEM`.
     */
    function configureVaultAndSubscribe(
        address originVault_,
        address callbackVault_
    ) external onlyOwner {
        if (originVault_ == address(0) || callbackVault_ == address(0)) revert ZeroAddress();
        if (subscribed) revert VaultAlreadySubscribed();

        originVault = originVault_;
        callbackVault = callbackVault_;
        _subscribeCurrent();
    }

    /**
     * @notice Unsubscribes from the currently watched vault (allows clean migration or shutdown).
     */
    function unsubscribeCurrentVault() external onlyOwner {
        if (!subscribed) revert VaultNotSubscribed();

        SYSTEM.unsubscribe(
            originChainId,
            originVault,
            HEALTH_FACTOR_TOPIC0,
            REACTIVE_IGNORE,
            REACTIVE_IGNORE,
            REACTIVE_IGNORE
        );
        subscribed = false;
        emit VaultUnsubscribed(originChainId, originVault);
    }

    function updateThresholds(
        uint256 warnBps_,
        uint256 rebalanceBps_,
        uint256 freezeBps_,
        uint256 targetBps_
    ) external onlyOwner {
        if (
            freezeBps_ < 10_000 ||
            freezeBps_ >= rebalanceBps_ ||
            rebalanceBps_ >= warnBps_ ||
            warnBps_ >= targetBps_ ||
            targetBps_ > 30_000
        ) {
            revert InvalidThresholds();
        }
        warnThresholdBps = warnBps_;
        rebalanceThresholdBps = rebalanceBps_;
        freezeThresholdBps = freezeBps_;
        targetHealthBps = targetBps_;
        emit ThresholdsUpdated(warnBps_, rebalanceBps_, freezeBps_, targetBps_);
    }

    function updateCooldowns(
        uint256 rebalanceCooldownSec_,
        uint256 emergencyCooldownSec_,
        uint256 escalationWindowSec_,
        uint256 warnEscalationCount_
    ) external onlyOwner {
        if (
            rebalanceCooldownSec_ == 0 ||
            rebalanceCooldownSec_ > 3600 ||
            emergencyCooldownSec_ == 0 ||
            emergencyCooldownSec_ > rebalanceCooldownSec_ ||
            escalationWindowSec_ < rebalanceCooldownSec_ ||
            warnEscalationCount_ < 2 ||
            warnEscalationCount_ > 10
        ) {
            revert InvalidCooldownConfig();
        }
        rebalanceCooldownSeconds = rebalanceCooldownSec_;
        emergencyCooldownSeconds = emergencyCooldownSec_;
        escalationWindowSeconds = escalationWindowSec_;
        warnEscalationCount = warnEscalationCount_;
        emit CooldownsUpdated(
            rebalanceCooldownSec_,
            emergencyCooldownSec_,
            escalationWindowSec_,
            warnEscalationCount_
        );
    }

    function updateCallbackGasLimit(uint64 newGasLimit_) external onlyOwner {
        if (newGasLimit_ < MIN_CALLBACK_GAS_LIMIT || newGasLimit_ > MAX_CALLBACK_GAS_LIMIT) {
            revert InvalidGasLimit(newGasLimit_);
        }
        callbackGasLimit = newGasLimit_;
        emit CallbackGasLimitUpdated(newGasLimit_);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedStateChanged(paused_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        address prev = owner;
        owner = newOwner;
        emit OwnershipTransferred(prev, newOwner);
    }

    /// @notice Settles any outstanding Reactive system debt from this contract's lREACT balance.
    function coverDebt() external {
        _coverDebt();
    }

    function rescueNative(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _pay(to, amount);
        emit NativeRescued(to, amount);
    }

    // -------------------------------------------------------------------------
    // View Helpers
    // -------------------------------------------------------------------------

    function getUserRiskState(address user) external view returns (UserRiskState memory) {
        return _userStates[user];
    }

    function systemDebt() external view returns (uint256) {
        return SYSTEM.debt(address(this));
    }

    // -------------------------------------------------------------------------
    // Internal Helpers
    // -------------------------------------------------------------------------

    function _subscribeCurrent() internal {
        SYSTEM.subscribe(
            originChainId,
            originVault,
            HEALTH_FACTOR_TOPIC0,
            REACTIVE_IGNORE,
            REACTIVE_IGNORE,
            REACTIVE_IGNORE
        );
        subscribed = true;
        emit VaultSubscribed(originChainId, originVault, destChainId, callbackVault);
    }

    function _dispatchCallback(
        address user,
        UserRiskState storage state,
        ActionTier tier,
        uint256 healthBps,
        uint256 effectiveTs
    ) internal {
        uint256 nonce = state.actionNonce + 1;
        state.actionNonce = nonce;
        state.lastTier = tier;
        state.lastCallbackTs = effectiveTs;
        state.totalCallbacksTriggered += 1;
        totalCallbacksRequested += 1;

        // First argument MUST be address(0); Reactive Omni overwrites it with address(this) on delivery.
        bytes memory payload = abi.encodeWithSignature(
            "executeEmergencyDeleverage(address,address,uint256,uint256,uint256,uint8)",
            address(0),
            user,
            targetHealthBps,
            effectiveTs,
            nonce,
            uint8(tier)
        );

        SYSTEM.requestCallbackV_1_0(
            ISystemContract.CallbackConfiguration_V_1_0({
                chainId: destChainId,
                recipient: callbackVault,
                gasLimit: callbackGasLimit,
                payload: payload
            })
        );

        emit ShieldCallbackDispatched(
            user,
            tier,
            healthBps,
            targetHealthBps,
            nonce,
            effectiveTs,
            destChainId,
            callbackVault
        );
        emit RiskEvaluated(user, tier, healthBps, 0, true, effectiveTs);
    }
}
