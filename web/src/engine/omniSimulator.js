// Faithful JS twin of OriginPriceVault.sol + OmniGuardReactive.sol state machines
// Matches exact Solidity thresholds, wall-clock cooldowns (never block counts!), and deleverage math.

export const THRESHOLDS = {
  WARN_BPS: 13500, // 1.35x
  REBALANCE_BPS: 12000, // 1.20x
  FREEZE_BPS: 10800, // 1.08x
  TARGET_BPS: 15000, // 1.50x
  REBALANCE_COOLDOWN_SEC: 15,
  EMERGENCY_COOLDOWN_SEC: 5,
  ESCALATION_WINDOW_SEC: 60,
  WARN_ESCALATION_COUNT: 2,
};

export const TIER_META = {
  SAFE: { id: 0, label: "SAFE", color: "emerald", desc: "Healthy collateral ratio (>= 1.35x)" },
  WARN: { id: 1, label: "WARN", color: "amber", desc: "Early deterioration watch (1.20x - 1.35x)" },
  REBALANCE: { id: 2, label: "REBALANCE", color: "cyan", desc: "Auto-deleverage callback (< 1.20x or 2x WARN)" },
  EMERGENCY_FREEZE: { id: 3, label: "EMERGENCY_FREEZE", color: "rose", desc: "Circuit breaker tripped (< 1.08x)" },
};

export function createInitialSimState() {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    priceUsd: 2500,
    collateralEth: 10.0,
    debtUsd: 18000,
    shieldReserveUsd: 1000,
    frozen: false,
    actionNonce: 0,
    warnStreak: 0,
    lastTier: "SAFE",
    lastWarnTs: 0,
    lastCallbackTs: 0,
    protectionCount: 0,
    totalEventsProcessed: 0,
    totalCallbacksDispatched: 0,
    totalCooldownSuppressions: 0,
    totalCircuitBreakerTrips: 0,
    totalDebtReducedUsd: 0,
    simClockSec: nowSec,
    baseBlockHeight: 62681500,
    lasnaBlockHeight: 9075600,
    lastHopTelemetry: {
      originMs: 200,
      reactiveMs: 620,
      callbackMs: 210,
      totalOmniMs: 1030,
      legacyTotalMs: 7410,
      savedMs: 6380,
      tier: "SAFE",
      originTx: "0x7c1f9a04e2b8d51c90a13f6e4b8c2d0194e7a55f6b2c1d88a34e019c7b20f1a4",
      reactiveTx: "0x4a82d17c50e3f9b2186a4c7d09e1f3b582c4a619d7e0b34f812a5c9e3d6b07c2",
      callbackTx: "0x91e5b30a8d74c2f6103b9e84a2d5c7f168e0b493a7c2d1f5048e6b3a9c1d2e80",
      isSimulated: true,
    },
    events: [],
  };
}

export function computeHealthBps(collateralEth, priceUsd, debtUsd) {
  if (debtUsd <= 0) return 99999;
  const collateralVal = collateralEth * priceUsd;
  return Math.floor((collateralVal * 10000) / debtUsd);
}

function deterministicHash(seed) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ (seed * 31);
  let out = "0x";
  for (let i = 0; i < 16; i++) {
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    out += ((h1 >>> 0).toString(16).padStart(8, "0")).slice(0, 4);
  }
  return out;
}

export function simulatePriceUpdate(prevState, newPriceUsd, advanceSec = 4, scenarioLabel = "Oracle Update") {
  const next = { ...prevState, events: [...prevState.events] };
  const effectiveTs = prevState.simClockSec + advanceSec;
  const blocksElapsedOnBase = Math.max(1, Math.round((advanceSec * 1000) / 200)); // 200ms blocks!
  next.simClockSec = effectiveTs;
  next.baseBlockHeight += blocksElapsedOnBase;
  next.lasnaBlockHeight += Math.max(1, Math.round(advanceSec));
  next.priceUsd = newPriceUsd;
  next.totalEventsProcessed += 1;

  const prevHealthBps = computeHealthBps(next.collateralEth, newPriceUsd, next.debtUsd);
  const seed = effectiveTs + Math.round(newPriceUsd * 10) + next.totalEventsProcessed * 97;
  const originTx = deterministicHash(seed);
  const reactiveTx = deterministicHash(seed + 11);
  const callbackTx = deterministicHash(seed + 29);

  // Mirror OmniGuardReactive.react() logic identically
  let decidedTier = "SAFE";
  let shouldDispatch = false;
  let suppressedByCooldown = false;
  let reasonNote = "Position healthy (>= 1.35x)";
  let cooldownRemainingSec = 0;

  if (next.debtUsd <= 0 || prevHealthBps >= THRESHOLDS.WARN_BPS) {
    decidedTier = "SAFE";
    next.lastTier = "SAFE";
    next.warnStreak = 0;
  } else if (prevHealthBps < THRESHOLDS.FREEZE_BPS) {
    decidedTier = "EMERGENCY_FREEZE";
    const isImmediateEscalation = next.lastTier !== "EMERGENCY_FREEZE";
    const emergencyPassed =
      next.lastCallbackTs === 0 || effectiveTs >= next.lastCallbackTs + THRESHOLDS.EMERGENCY_COOLDOWN_SEC;

    if (!isImmediateEscalation && !emergencyPassed) {
      suppressedByCooldown = true;
      cooldownRemainingSec = next.lastCallbackTs + THRESHOLDS.EMERGENCY_COOLDOWN_SEC - effectiveTs;
      next.totalCooldownSuppressions += 1;
      reasonNote = `Emergency cooldown active (${cooldownRemainingSec}s left)`;
    } else if (next.frozen) {
      suppressedByCooldown = true;
      reasonNote = "Position already circuit-broken (frozen)";
    } else {
      shouldDispatch = true;
      reasonNote = isImmediateEscalation
        ? "Critical < 1.08x — bypassed rebalance cooldown for instant circuit breaker!"
        : "Critical < 1.08x — emergency freeze dispatched";
    }
  } else if (prevHealthBps < THRESHOLDS.REBALANCE_BPS) {
    decidedTier = "REBALANCE";
    if (
      next.lastCallbackTs !== 0 &&
      effectiveTs < next.lastCallbackTs + THRESHOLDS.REBALANCE_COOLDOWN_SEC
    ) {
      suppressedByCooldown = true;
      cooldownRemainingSec = next.lastCallbackTs + THRESHOLDS.REBALANCE_COOLDOWN_SEC - effectiveTs;
      next.totalCooldownSuppressions += 1;
      reasonNote = `Wall-clock 15s cooldown held (${cooldownRemainingSec}s left despite +${blocksElapsedOnBase} Base blocks!)`;
    } else {
      shouldDispatch = true;
      reasonNote = "Health < 1.20x — automated deleverage callback dispatched";
    }
  } else {
    // WARN band [1.20x, 1.35x)
    decidedTier = "WARN";
    if (next.lastWarnTs > 0 && effectiveTs <= next.lastWarnTs + THRESHOLDS.ESCALATION_WINDOW_SEC) {
      next.warnStreak += 1;
    } else {
      next.warnStreak = 1;
    }
    next.lastWarnTs = effectiveTs;

    if (next.warnStreak >= THRESHOLDS.WARN_ESCALATION_COUNT) {
      if (
        next.lastCallbackTs !== 0 &&
        effectiveTs < next.lastCallbackTs + THRESHOLDS.REBALANCE_COOLDOWN_SEC
      ) {
        suppressedByCooldown = true;
        cooldownRemainingSec = next.lastCallbackTs + THRESHOLDS.REBALANCE_COOLDOWN_SEC - effectiveTs;
        next.totalCooldownSuppressions += 1;
        next.lastTier = "WARN";
        reasonNote = `WARN streak ${next.warnStreak}/2 queued (cooldown ${cooldownRemainingSec}s left)`;
      } else {
        decidedTier = "REBALANCE";
        shouldDispatch = true;
        reasonNote = `2 consecutive WARN logs in 60s window — auto-escalated to REBALANCE!`;
      }
    } else {
      next.lastTier = "WARN";
      reasonNote = `Early warning (${next.warnStreak}/${THRESHOLDS.WARN_ESCALATION_COUNT}) — zero destination gas spent`;
    }
  }

  let repaidFromShieldUsd = 0;
  let collateralSoldEth = 0;
  let restoredHealthBps = prevHealthBps;
  let dispatchedNonce = null;

  if (shouldDispatch) {
    next.actionNonce += 1;
    dispatchedNonce = next.actionNonce;
    next.lastCallbackTs = effectiveTs;
    next.lastTier = decidedTier;
    next.warnStreak = 0;
    next.totalCallbacksDispatched += 1;
    next.protectionCount += 1;

    // Exact Solidity deleverage math
    const collateralValUsd = next.collateralEth * newPriceUsd;
    const maxDebtAtTarget = (collateralValUsd * 10000) / THRESHOLDS.TARGET_BPS;
    if (next.debtUsd > maxDebtAtTarget) {
      const needed = next.debtUsd - maxDebtAtTarget;
      repaidFromShieldUsd = Math.min(needed, next.shieldReserveUsd);
      next.shieldReserveUsd = Math.max(0, next.shieldReserveUsd - repaidFromShieldUsd);
      next.debtUsd = Math.max(0, next.debtUsd - repaidFromShieldUsd);
    }

    const postShieldHf = computeHealthBps(next.collateralEth, newPriceUsd, next.debtUsd);
    if (next.debtUsd > 0 && postShieldHf < THRESHOLDS.TARGET_BPS && next.collateralEth > 0) {
      let deleverageUsd = 0;
      if (collateralValUsd > next.debtUsd) {
        const equityUsd = collateralValUsd - next.debtUsd;
        const targetDebtRemainder = (equityUsd * 10000) / (THRESHOLDS.TARGET_BPS - 10000);
        deleverageUsd = Math.max(0, next.debtUsd - targetDebtRemainder);
      } else {
        deleverageUsd = collateralValUsd;
      }

      if (deleverageUsd > 0) {
        collateralSoldEth = Math.min(next.collateralEth, deleverageUsd / newPriceUsd);
        const soldUsd = collateralSoldEth * newPriceUsd;
        const debtReduction = Math.min(next.debtUsd, soldUsd);
        next.collateralEth = Math.max(0, next.collateralEth - collateralSoldEth);
        next.debtUsd = Math.max(0, next.debtUsd - debtReduction);
        next.totalDebtReducedUsd += debtReduction;
      }
    }

    next.totalDebtReducedUsd += repaidFromShieldUsd;
    restoredHealthBps = computeHealthBps(next.collateralEth, newPriceUsd, next.debtUsd);

    if (decidedTier === "EMERGENCY_FREEZE") {
      next.frozen = true;
      next.totalCircuitBreakerTrips += 1;
    }
  }

  const originMs = 200;
  const reactiveMs = 560 + (seed % 180);
  const callbackMs = shouldDispatch ? 200 + (seed % 60) : 0;
  const totalOmniMs = originMs + reactiveMs + callbackMs;
  const legacyTotalMs = originMs + 6900 + (seed % 450) + (shouldDispatch ? 200 : 0);

  next.lastHopTelemetry = {
    originMs,
    reactiveMs,
    callbackMs,
    totalOmniMs,
    legacyTotalMs,
    savedMs: legacyTotalMs - totalOmniMs,
    tier: suppressedByCooldown ? "COOLDOWN_SUPPRESSED" : decidedTier,
    originTx,
    reactiveTx,
    callbackTx: shouldDispatch ? callbackTx : null,
    isSimulated: true,
    dispatched: shouldDispatch,
  };

  next.events.unshift({
    id: `${effectiveTs}-${next.totalEventsProcessed}`,
    timestamp: new Date(effectiveTs * 1000).toLocaleTimeString(),
    scenarioLabel,
    priceUsd: newPriceUsd,
    prevHealthBps,
    restoredHealthBps,
    tier: suppressedByCooldown ? "COOLDOWN_SUPPRESSED" : decidedTier,
    dispatched: shouldDispatch,
    nonce: dispatchedNonce,
    repaidFromShieldUsd,
    collateralSoldEth,
    omniLatencyMs: totalOmniMs,
    legacyLatencyMs: legacyTotalMs,
    blocksOnBase: blocksElapsedOnBase,
    gasReactEst: shouldDispatch ? 168420 : 62140,
    originTx,
    reactiveTx,
    callbackTx: shouldDispatch ? callbackTx : null,
    note: reasonNote,
  });

  if (next.events.length > 20) {
    next.events = next.events.slice(0, 20);
  }

  return next;
}
