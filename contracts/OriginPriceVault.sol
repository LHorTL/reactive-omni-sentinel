// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Pausable } from "@openzeppelin/contracts/utils/Pausable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { IPayable } from "./reactive-lib/interfaces/IPayable.sol";
import { AbstractCallback } from "./reactive-lib/base/AbstractCallback.sol";

/**
 * @title OriginPriceVault
 * @notice Base Sepolia (84532) lending & treasury vault with sub-second Reactive Omni automated liquidation protection.
 * @dev Emits `HealthFactorChanged` on price updates or debt mutations. `OmniGuardReactive` on Reactive Lasna (5318007)
 *      subscribes to those logs and triggers `executeEmergencyDeleverage(...)` via the official Reactive Omni Callback
 *      Proxy (`0x476F44b11F5C942c58f4c8E3d0300E5710743585` on Base Sepolia).
 *
 *      CRITICAL BASE SEPOLIA DESIGN:
 *      Base Sepolia produces 200ms blocks (~5 blocks/sec). Every cooldown, freshness check, and timestamp guard in
 *      this contract strictly uses `block.timestamp` (wall-clock seconds) and NEVER `block.number`.
 */
contract OriginPriceVault is AbstractCallback, Ownable, Pausable, ReentrancyGuard {
    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    uint256 public constant PRICE_PRECISION = 1e18;
    uint256 public constant BPS_DENOMINATOR = 10_000;
    uint256 public constant MIN_BORROW_HEALTH_BPS = 13_000; // 1.30x minimum HF after user borrow/withdraw
    uint256 public constant MIN_TARGET_HEALTH_BPS = 12_000; // 1.20x minimum callback deleverage target
    uint256 public constant MAX_TARGET_HEALTH_BPS = 30_000; // 3.00x maximum callback deleverage target
    uint256 public constant MAX_BATCH_EMIT_USERS = 25;
    uint256 public constant FUTURE_TIMESTAMP_SKEW = 30; // seconds tolerance for cross-chain clock drift

    uint8 public constant TIER_SAFE = 0;
    uint8 public constant TIER_WARN = 1;
    uint8 public constant TIER_REBALANCE = 2;
    uint8 public constant TIER_EMERGENCY_FREEZE = 3;

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error InvalidPrice();
    error InvalidTargetBps(uint256 targetBps);
    error InvalidTier(uint8 tier);
    error PositionNotFound(address user);
    error PositionFrozen(address user);
    error PositionAlreadyFrozen(address user);
    error PositionNotFrozen(address user);
    error HealthFactorTooLow(uint256 resultingBps, uint256 minRequiredBps);
    error InsufficientCollateral(uint256 requested, uint256 available);
    error NonceAlreadyProcessed(address user, uint256 nonce);
    error NonMonotonicNonce(address user, uint256 nonce, uint256 lastNonce);
    error StaleCallback(uint256 triggerTs, uint256 currentTs, uint256 maxDelay);
    error FutureTimestamp(uint256 triggerTs, uint256 currentTs);
    error CooldownActive(address user, uint256 nextAllowedTs, uint256 currentTs);
    error UnauthorizedOracle(address caller);
    error UnauthorizedGuardian(address caller);
    error BatchTooLarge(uint256 length, uint256 maxLength);
    error InvalidDelayConfig(uint256 value);

    // -------------------------------------------------------------------------
    // Data Structures
    // -------------------------------------------------------------------------

    struct Position {
        uint256 collateralAmount; // 18 decimals (e.g. ETH units)
        uint256 debtUsd; // 18 decimals (USD debt)
        uint256 shieldReserveUsd; // 18 decimals (pre-funded USD shield tapped before collateral)
        uint256 lastProtectedAt; // block.timestamp of last callback protection
        uint256 protectionCount; // total callbacks executed for this user
        uint8 lastActionTier; // last executed protection tier
        bool frozen; // circuit breaker flag blocking new borrows/withdrawals
        bool exists;
    }

    struct DeleverageResult {
        uint256 previousHealthBps;
        uint256 restoredHealthBps;
        uint256 repaidFromShieldUsd;
        uint256 collateralSold;
        uint256 totalDebtReduced;
    }

    // -------------------------------------------------------------------------
    // State Variables
    // -------------------------------------------------------------------------

    /// @notice Current collateral asset USD price scaled by 1e18 (e.g., 2500e18 = $2,500).
    uint256 public collateralPriceUsd;

    /// @notice Authorized oracle feed address allowed to push price updates.
    address public priceOracle;

    /// @notice Emergency guardian allowed to pause or unfreeze positions.
    address public guardian;

    /// @notice Minimum wall-clock seconds between non-emergency REBALANCE callbacks per user.
    uint256 public vaultCooldownSeconds;

    /// @notice Maximum allowed age (in seconds) of a non-emergency callback trigger timestamp.
    uint256 public maxCallbackDelaySeconds;

    /// @notice Aggregate telemetry counters for judges & dashboard inspection.
    uint256 public totalProtectionsExecuted;
    uint256 public totalCircuitBreakerTrips;
    uint256 public totalDebtReducedUsd;

    mapping(address => Position) private _positions;
    mapping(address => uint256) public lastProcessedNonce;
    mapping(address => mapping(uint256 => bool)) public processedNonces;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @notice Origin event monitored by `OmniGuardReactive` on Reactive Lasna.
    event HealthFactorChanged(
        address indexed user,
        uint256 healthBps,
        uint256 collateral,
        uint256 debt,
        uint256 timestamp
    );

    event OraclePriceUpdated(
        uint256 indexed previousPriceUsd,
        uint256 indexed newPriceUsd,
        address indexed updater,
        uint256 timestamp
    );

    event PositionUpdated(
        address indexed user,
        uint256 collateralAmount,
        uint256 debtUsd,
        uint256 shieldReserveUsd,
        uint256 timestamp
    );

    event EmergencyDeleverageExecuted(
        address indexed user,
        address indexed reactiveSender,
        uint8 indexed tier,
        uint256 actionNonce,
        uint256 previousHealthBps,
        uint256 restoredHealthBps,
        uint256 repaidFromShieldUsd,
        uint256 collateralSold,
        uint256 triggerTs,
        uint256 executedTs
    );

    event CircuitBreakerTripped(
        address indexed user,
        uint256 previousHealthBps,
        uint256 restoredHealthBps,
        uint256 actionNonce,
        uint256 timestamp
    );

    event PositionUnfrozen(address indexed user, address indexed actor, uint256 healthBps, uint256 timestamp);
    event OracleUpdated(address indexed newOracle);
    event GuardianUpdated(address indexed newGuardian);
    event VaultCooldownUpdated(uint256 newCooldownSeconds);
    event MaxCallbackDelayUpdated(uint256 newMaxDelaySeconds);
    event NativeRescued(address indexed to, uint256 amount);

    // -------------------------------------------------------------------------
    // Modifiers
    // -------------------------------------------------------------------------

    modifier onlyOracleOrOwner() {
        if (msg.sender != priceOracle && msg.sender != owner()) {
            revert UnauthorizedOracle(msg.sender);
        }
        _;
    }

    modifier onlyGuardianOrOwner() {
        if (msg.sender != guardian && msg.sender != owner()) {
            revert UnauthorizedGuardian(msg.sender);
        }
        _;
    }

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /**
     * @param callbackProxy_ Official Reactive Omni Callback Proxy on this chain
     *        (Base Sepolia: 0x476F44b11F5C942c58f4c8E3d0300E5710743585).
     * @param reactiveSentinel_ Deployed `OmniGuardReactive` contract address on Reactive Lasna (5318007).
     * @param initialPriceUsd_ Initial collateral price in 18-decimal USD (e.g., 2500e18).
     * @param vaultCooldownSeconds_ Wall-clock seconds cooldown between rebalance callbacks (e.g., 15).
     */
    constructor(
        IPayable callbackProxy_,
        address reactiveSentinel_,
        uint256 initialPriceUsd_,
        uint256 vaultCooldownSeconds_
    ) payable AbstractCallback(callbackProxy_, reactiveSentinel_) Ownable(msg.sender) {
        if (address(callbackProxy_) == address(0) || reactiveSentinel_ == address(0)) {
            revert ZeroAddress();
        }
        if (initialPriceUsd_ == 0) {
            revert InvalidPrice();
        }

        collateralPriceUsd = initialPriceUsd_;
        priceOracle = msg.sender;
        guardian = msg.sender;
        vaultCooldownSeconds = vaultCooldownSeconds_;
        maxCallbackDelaySeconds = 300;
    }

    // -------------------------------------------------------------------------
    // Position Management (Origin Actions)
    // -------------------------------------------------------------------------

    /**
     * @notice Opens a vault position or tops up collateral & USD shield reserve.
     * @dev Topping up is intentionally permitted even when a position is frozen so users can restore health.
     */
    function openOrTopUpPosition(
        uint256 collateralDelta,
        uint256 shieldReserveDelta
    ) external whenNotPaused {
        if (collateralDelta == 0 && shieldReserveDelta == 0) {
            revert ZeroAmount();
        }

        Position storage pos = _positions[msg.sender];
        pos.exists = true;
        pos.collateralAmount += collateralDelta;
        pos.shieldReserveUsd += shieldReserveDelta;

        emit PositionUpdated(
            msg.sender,
            pos.collateralAmount,
            pos.debtUsd,
            pos.shieldReserveUsd,
            block.timestamp
        );

        if (pos.debtUsd > 0) {
            _emitHealthFactor(msg.sender, pos);
        }
    }

    /**
     * @notice Borrows synthetic USD debt against deposited collateral.
     */
    function borrow(uint256 debtDeltaUsd) external whenNotPaused {
        if (debtDeltaUsd == 0) revert ZeroAmount();

        Position storage pos = _positions[msg.sender];
        if (!pos.exists) revert PositionNotFound(msg.sender);
        if (pos.frozen) revert PositionFrozen(msg.sender);

        pos.debtUsd += debtDeltaUsd;

        uint256 healthBps = _computeHealthBps(pos.collateralAmount, pos.debtUsd);
        if (healthBps < MIN_BORROW_HEALTH_BPS) {
            revert HealthFactorTooLow(healthBps, MIN_BORROW_HEALTH_BPS);
        }

        emit PositionUpdated(
            msg.sender,
            pos.collateralAmount,
            pos.debtUsd,
            pos.shieldReserveUsd,
            block.timestamp
        );
        _emitHealthFactor(msg.sender, pos);
    }

    /**
     * @notice Withdraws collateral while maintaining minimum safe health factor.
     */
    function withdrawCollateral(uint256 collateralDelta) external whenNotPaused {
        if (collateralDelta == 0) revert ZeroAmount();

        Position storage pos = _positions[msg.sender];
        if (!pos.exists) revert PositionNotFound(msg.sender);
        if (pos.frozen) revert PositionFrozen(msg.sender);
        if (collateralDelta > pos.collateralAmount) {
            revert InsufficientCollateral(collateralDelta, pos.collateralAmount);
        }

        pos.collateralAmount -= collateralDelta;

        if (pos.debtUsd > 0) {
            uint256 healthBps = _computeHealthBps(pos.collateralAmount, pos.debtUsd);
            if (healthBps < MIN_BORROW_HEALTH_BPS) {
                revert HealthFactorTooLow(healthBps, MIN_BORROW_HEALTH_BPS);
            }
        }

        emit PositionUpdated(
            msg.sender,
            pos.collateralAmount,
            pos.debtUsd,
            pos.shieldReserveUsd,
            block.timestamp
        );

        if (pos.debtUsd > 0) {
            _emitHealthFactor(msg.sender, pos);
        }
    }

    /**
     * @notice Repays part or all of the caller's USD debt.
     */
    function repayDebt(uint256 repayUsd) external whenNotPaused {
        if (repayUsd == 0) revert ZeroAmount();

        Position storage pos = _positions[msg.sender];
        if (!pos.exists) revert PositionNotFound(msg.sender);

        uint256 actualRepay = repayUsd > pos.debtUsd ? pos.debtUsd : repayUsd;
        pos.debtUsd -= actualRepay;

        emit PositionUpdated(
            msg.sender,
            pos.collateralAmount,
            pos.debtUsd,
            pos.shieldReserveUsd,
            block.timestamp
        );
        _emitHealthFactor(msg.sender, pos);
    }

    /**
     * @notice Updates the collateral oracle price and emits `HealthFactorChanged` for affected users.
     * @dev Bounded batch size prevents gas exhaustion DoS. Emits logs picked up immediately by Reactive Lasna.
     */
    function updateOraclePrice(
        uint256 newPriceUsd,
        address[] calldata usersToEmit
    ) external onlyOracleOrOwner whenNotPaused {
        if (newPriceUsd == 0) revert InvalidPrice();
        if (usersToEmit.length > MAX_BATCH_EMIT_USERS) {
            revert BatchTooLarge(usersToEmit.length, MAX_BATCH_EMIT_USERS);
        }

        uint256 previousPrice = collateralPriceUsd;
        collateralPriceUsd = newPriceUsd;

        emit OraclePriceUpdated(previousPrice, newPriceUsd, msg.sender, block.timestamp);

        for (uint256 i = 0; i < usersToEmit.length; ++i) {
            address user = usersToEmit[i];
            Position storage pos = _positions[user];
            if (pos.exists && pos.debtUsd > 0) {
                _emitHealthFactor(user, pos);
            }
        }
    }

    /**
     * @notice Permissionless health pulse emitter for any active indebted position.
     */
    function checkAndEmitHealthFactor(address user) external whenNotPaused {
        Position storage pos = _positions[user];
        if (!pos.exists) revert PositionNotFound(user);
        _emitHealthFactor(user, pos);
    }

    // -------------------------------------------------------------------------
    // Reactive Omni Callback Execution (Authenticated Cross-Chain Entry Point)
    // -------------------------------------------------------------------------

    /**
     * @notice Executes automated deleveraging and/or circuit-breaker freeze triggered by `OmniGuardReactive`.
     * @dev Strictly authenticated by BOTH:
     *      1. `onlyServiceProvider` (msg.sender MUST be the chain's Reactive Omni Callback Proxy)
     *      2. `onlyCallbackSender(reactiveSender)` (injected 1st arg MUST equal `_CALLBACK_SENDER`)
     *      Plus idempotent monotonic nonce guard, wall-clock timestamp cooldown, and `nonReentrant`.
     * @param reactiveSender Injected by Reactive Omni Callback Proxy (address of `OmniGuardReactive`).
     * @param user Target vault position owner to protect.
     * @param targetBps Desired restored health factor in basis points (e.g. 15000 = 1.50x).
     * @param triggerTs Origin event `block.timestamp` when the breach was detected.
     * @param actionNonce Strictly increasing per-user action nonce from `OmniGuardReactive`.
     * @param tier Escalation tier: `2` = REBALANCE, `3` = EMERGENCY_FREEZE.
     */
    function executeEmergencyDeleverage(
        address reactiveSender,
        address user,
        uint256 targetBps,
        uint256 triggerTs,
        uint256 actionNonce,
        uint8 tier
    )
        external
        onlyServiceProvider
        onlyCallbackSender(reactiveSender)
        whenNotPaused
        nonReentrant
    {
        if (user == address(0)) revert ZeroAddress();
        if (tier != TIER_REBALANCE && tier != TIER_EMERGENCY_FREEZE) {
            revert InvalidTier(tier);
        }
        if (targetBps < MIN_TARGET_HEALTH_BPS || targetBps > MAX_TARGET_HEALTH_BPS) {
            revert InvalidTargetBps(targetBps);
        }

        Position storage pos = _positions[user];
        if (!pos.exists) revert PositionNotFound(user);

        // Idempotency + strict monotonic nonce check (blocks replay and out-of-order stale callbacks)
        if (actionNonce == 0 || actionNonce <= lastProcessedNonce[user]) {
            revert NonMonotonicNonce(user, actionNonce, lastProcessedNonce[user]);
        }
        if (processedNonces[user][actionNonce]) {
            revert NonceAlreadyProcessed(user, actionNonce);
        }

        // Timestamp freshness & wall-clock cooldown check (100% block.timestamp, NEVER block.number!)
        if (triggerTs > block.timestamp + FUTURE_TIMESTAMP_SKEW) {
            revert FutureTimestamp(triggerTs, block.timestamp);
        }
        if (tier == TIER_REBALANCE) {
            if (block.timestamp > triggerTs + maxCallbackDelaySeconds) {
                revert StaleCallback(triggerTs, block.timestamp, maxCallbackDelaySeconds);
            }
            if (
                pos.lastProtectedAt != 0 &&
                block.timestamp < pos.lastProtectedAt + vaultCooldownSeconds
            ) {
                revert CooldownActive(user, pos.lastProtectedAt + vaultCooldownSeconds, block.timestamp);
            }
        } else {
            // TIER_EMERGENCY_FREEZE bypasses rebalance cooldown when escalating an unfrozen vault,
            // but refuses redundant freezes on an already-frozen position.
            if (pos.frozen) {
                revert PositionAlreadyFrozen(user);
            }
        }

        // Commit nonce & timestamps BEFORE financial mutation (CEI discipline)
        processedNonces[user][actionNonce] = true;
        lastProcessedNonce[user] = actionNonce;

        DeleverageResult memory res = _applyDeleverage(pos, targetBps);

        pos.lastProtectedAt = block.timestamp;
        pos.protectionCount += 1;
        pos.lastActionTier = tier;

        totalProtectionsExecuted += 1;
        totalDebtReducedUsd += res.totalDebtReduced;

        if (tier == TIER_EMERGENCY_FREEZE) {
            pos.frozen = true;
            totalCircuitBreakerTrips += 1;
            emit CircuitBreakerTripped(
                user,
                res.previousHealthBps,
                res.restoredHealthBps,
                actionNonce,
                block.timestamp
            );
        }

        emit EmergencyDeleverageExecuted(
            user,
            reactiveSender,
            tier,
            actionNonce,
            res.previousHealthBps,
            res.restoredHealthBps,
            res.repaidFromShieldUsd,
            res.collateralSold,
            triggerTs,
            block.timestamp
        );
    }

    function _applyDeleverage(
        Position storage pos,
        uint256 targetBps
    ) internal returns (DeleverageResult memory res) {
        res.previousHealthBps = _computeHealthBps(pos.collateralAmount, pos.debtUsd);
        if (pos.debtUsd == 0 || res.previousHealthBps >= targetBps) {
            res.restoredHealthBps = res.previousHealthBps;
            return res;
        }

        uint256 collateralValUsd = _collateralValueUsd(pos.collateralAmount);
        uint256 debtReducedFromCollateralUsd = 0;

        // Step A: Consume pre-funded USD shield reserve first so user retains collateral upside.
        uint256 maxDebtAtTarget = Math.mulDiv(collateralValUsd, BPS_DENOMINATOR, targetBps);
        if (pos.debtUsd > maxDebtAtTarget) {
            uint256 neededShieldRepay = pos.debtUsd - maxDebtAtTarget;
            res.repaidFromShieldUsd = neededShieldRepay <= pos.shieldReserveUsd
                ? neededShieldRepay
                : pos.shieldReserveUsd;

            if (res.repaidFromShieldUsd > 0) {
                pos.shieldReserveUsd -= res.repaidFromShieldUsd;
                pos.debtUsd -= res.repaidFromShieldUsd;
            }
        }

        // Step B: If still under target health factor, perform overflow-safe self-deleverage.
        // Derivation: (C - x) * 10000 / (D - x) = T  =>  x = D - (C - D) * 10000 / (T - 10000)
        uint256 postShieldHealthBps = _computeHealthBps(pos.collateralAmount, pos.debtUsd);
        if (pos.debtUsd > 0 && postShieldHealthBps < targetBps && pos.collateralAmount > 0) {
            uint256 deleverageUsd;
            if (collateralValUsd > pos.debtUsd) {
                uint256 equityUsd = collateralValUsd - pos.debtUsd;
                uint256 targetDebtRemainder = Math.mulDiv(
                    equityUsd,
                    BPS_DENOMINATOR,
                    targetBps - BPS_DENOMINATOR
                );
                deleverageUsd = pos.debtUsd > targetDebtRemainder
                    ? pos.debtUsd - targetDebtRemainder
                    : 0;
            } else {
                // Underwater position: liquidate remaining collateral to minimize bad debt without underflow.
                deleverageUsd = collateralValUsd;
            }

            if (deleverageUsd > 0) {
                uint256 sold = Math.mulDiv(
                    deleverageUsd,
                    PRICE_PRECISION,
                    collateralPriceUsd,
                    Math.Rounding.Ceil
                );
                if (sold > pos.collateralAmount) {
                    sold = pos.collateralAmount;
                }

                uint256 soldValueUsd = _collateralValueUsd(sold);
                debtReducedFromCollateralUsd = soldValueUsd > pos.debtUsd
                    ? pos.debtUsd
                    : soldValueUsd;

                pos.collateralAmount -= sold;
                pos.debtUsd -= debtReducedFromCollateralUsd;
                res.collateralSold = sold;
            }
        }

        res.totalDebtReduced = res.repaidFromShieldUsd + debtReducedFromCollateralUsd;
        res.restoredHealthBps = _computeHealthBps(pos.collateralAmount, pos.debtUsd);
    }

    // -------------------------------------------------------------------------
    // Recovery, Billing & Governance Controls
    // -------------------------------------------------------------------------

    /**
     * @notice Unfreezes a circuit-broken position once safe (or immediately by guardian/owner).
     */
    function unfreezePosition(address user) external whenNotPaused {
        Position storage pos = _positions[user];
        if (!pos.exists) revert PositionNotFound(user);
        if (!pos.frozen) revert PositionNotFrozen(user);

        uint256 healthBps = _computeHealthBps(pos.collateralAmount, pos.debtUsd);
        if (msg.sender != owner() && msg.sender != guardian) {
            if (msg.sender != user) revert UnauthorizedGuardian(msg.sender);
            if (healthBps < MIN_BORROW_HEALTH_BPS) {
                revert HealthFactorTooLow(healthBps, MIN_BORROW_HEALTH_BPS);
            }
        }

        pos.frozen = false;
        emit PositionUnfrozen(user, msg.sender, healthBps, block.timestamp);
        if (pos.debtUsd > 0) {
            _emitHealthFactor(user, pos);
        }
    }

    /// @notice Settles any outstanding callback proxy debt from this vault's native balance.
    function coverDebt() external nonReentrant {
        _coverDebt();
    }

    function pause() external onlyGuardianOrOwner {
        _pause();
    }

    function unpause() external onlyGuardianOrOwner {
        _unpause();
    }

    function setPriceOracle(address newOracle) external onlyOwner {
        if (newOracle == address(0)) revert ZeroAddress();
        priceOracle = newOracle;
        emit OracleUpdated(newOracle);
    }

    function setGuardian(address newGuardian) external onlyOwner {
        if (newGuardian == address(0)) revert ZeroAddress();
        guardian = newGuardian;
        emit GuardianUpdated(newGuardian);
    }

    function setVaultCooldown(uint256 newCooldownSeconds) external onlyOwner {
        if (newCooldownSeconds > 3600) revert InvalidDelayConfig(newCooldownSeconds);
        vaultCooldownSeconds = newCooldownSeconds;
        emit VaultCooldownUpdated(newCooldownSeconds);
    }

    function setMaxCallbackDelay(uint256 newMaxDelaySeconds) external onlyOwner {
        if (newMaxDelaySeconds < 10 || newMaxDelaySeconds > 86_400) {
            revert InvalidDelayConfig(newMaxDelaySeconds);
        }
        maxCallbackDelaySeconds = newMaxDelaySeconds;
        emit MaxCallbackDelayUpdated(newMaxDelaySeconds);
    }

    function rescueNative(address payable to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _pay(to, amount);
        emit NativeRescued(to, amount);
    }

    // -------------------------------------------------------------------------
    // View Helpers
    // -------------------------------------------------------------------------

    function getPosition(address user) external view returns (Position memory) {
        return _positions[user];
    }

    function getHealthFactorBps(address user) external view returns (uint256) {
        Position storage pos = _positions[user];
        if (!pos.exists) return type(uint256).max;
        return _computeHealthBps(pos.collateralAmount, pos.debtUsd);
    }

    function getCollateralValueUsd(address user) external view returns (uint256) {
        return _collateralValueUsd(_positions[user].collateralAmount);
    }

    function callbackDebt() external view returns (uint256) {
        return _SERVICE_PROVIDER.debt(address(this));
    }

    // -------------------------------------------------------------------------
    // Internal Math & Event Helpers
    // -------------------------------------------------------------------------

    function _collateralValueUsd(uint256 collateralAmount) internal view returns (uint256) {
        return Math.mulDiv(collateralAmount, collateralPriceUsd, PRICE_PRECISION);
    }

    function _computeHealthBps(uint256 collateralAmount, uint256 debtUsd) internal view returns (uint256) {
        if (debtUsd == 0) return type(uint256).max;
        uint256 collateralValUsd = _collateralValueUsd(collateralAmount);
        return Math.mulDiv(collateralValUsd, BPS_DENOMINATOR, debtUsd);
    }

    function _emitHealthFactor(address user, Position storage pos) internal {
        uint256 collateralValUsd = _collateralValueUsd(pos.collateralAmount);
        uint256 healthBps = _computeHealthBps(pos.collateralAmount, pos.debtUsd);
        emit HealthFactorChanged(user, healthBps, collateralValUsd, pos.debtUsd, block.timestamp);
    }
}
