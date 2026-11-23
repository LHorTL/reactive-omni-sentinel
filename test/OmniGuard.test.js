const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const SYSTEM_ADDR = "0x8888888888888888888888888888888888888888";
const BASE_SEPOLIA_CHAIN_ID = 84532n;
const UNICHAIN_SEPOLIA_CHAIN_ID = 1301n;
const REACTIVE_IGNORE =
  "0xa65f96fc951c35ead38878e0f0b7a3c744a6f5ccc1476b313353ce31712313ad";
const INITIAL_PRICE = ethers.parseUnits("2500", 18); // $2,500 / ETH
const DEFAULT_COOLDOWN = 15n; // 15 seconds (wall-clock, NOT blocks!)
const DEFAULT_GAS_LIMIT = 500000n;

describe("OmniGuard — Reactive Omni Sub-Second Liquidation Shield & Circuit Breaker", function () {
  let owner, guardian, oracle, alice, bob, attacker;
  let systemContract, callbackProxy, reactive, vault;

  const healthFactorTopic0 = ethers.id(
    "HealthFactorChanged(address,uint256,uint256,uint256,uint256)"
  );

  async function installSystemContract() {
    const MockSystem = await ethers.getContractFactory("MockOmniSystemContract");
    const deployedMock = await MockSystem.deploy();
    await deployedMock.waitForDeployment();
    const runtimeCode = await ethers.provider.getCode(await deployedMock.getAddress());
    await network.provider.send("hardhat_setCode", [SYSTEM_ADDR, runtimeCode]);
    return await ethers.getContractAt("MockOmniSystemContract", SYSTEM_ADDR);
  }

  function buildLogRecordFromReceipt(receipt, vaultAddress, chainId = BASE_SEPOLIA_CHAIN_ID) {
    const matchingLogs = receipt.logs.filter(
      (l) =>
        l.address.toLowerCase() === vaultAddress.toLowerCase() &&
        l.topics[0].toLowerCase() === healthFactorTopic0.toLowerCase()
    );
    expect(matchingLogs.length).to.be.greaterThan(0, "No HealthFactorChanged log found");
    const log = matchingLogs[matchingLogs.length - 1];
    return {
      chainId,
      contractAddress: vaultAddress,
      topic0: BigInt(log.topics[0]),
      topic1: BigInt(log.topics[1]),
      topic2: 0n,
      topic3: 0n,
      data: log.data,
      blockNumber: BigInt(log.blockNumber),
      opCode: 3n,
      blockHash: BigInt(log.blockHash),
      txHash: BigInt(log.transactionHash),
      logIndex: BigInt(log.index),
    };
  }

  async function relayOriginToDestination(receipt, strictRevert = true) {
    const vaultAddr = await vault.getAddress();
    const logRecord = buildLogRecordFromReceipt(receipt, vaultAddr);
    const beforeCallbacks = await systemContract.pendingCallbackCount();
    const reactiveTx = await systemContract.trigger(await reactive.getAddress(), logRecord);
    const reactiveReceipt = await reactiveTx.wait();
    const afterCallbacks = await systemContract.pendingCallbackCount();

    let deliveryReceipt = null;
    if (afterCallbacks > beforeCallbacks) {
      const cb = await systemContract.getPendingCallback(afterCallbacks - 1n);
      const deliverTx = await callbackProxy.deliverCallback(
        {
          chainId: cb.chainId,
          recipient: cb.recipient,
          gasLimit: cb.gasLimit,
          payload: cb.payload,
        },
        strictRevert
      );
      deliveryReceipt = await deliverTx.wait();
    }

    return {
      reactiveReceipt,
      deliveryReceipt,
      callbackDispatched: afterCallbacks > beforeCallbacks,
      callbackIndex: afterCallbacks > beforeCallbacks ? afterCallbacks - 1n : null,
    };
  }

  async function advanceTime(seconds) {
    await network.provider.send("evm_increaseTime", [Number(seconds)]);
    await network.provider.send("evm_mine");
  }

  beforeEach(async function () {
    [owner, guardian, oracle, alice, bob, attacker] = await ethers.getSigners();
    systemContract = await installSystemContract();
    await systemContract.resetForTest();

    const MockProxy = await ethers.getContractFactory("MockOmniCallbackProxy");
    callbackProxy = await MockProxy.deploy();
    await callbackProxy.waitForDeployment();

    // Official Reactive Omni 2-step deployment order:
    // 1. Deploy OmniGuardReactive on Reactive Lasna (address(0) vaults initially)
    const ReactiveFactory = await ethers.getContractFactory("OmniGuardReactive");
    reactive = await ReactiveFactory.deploy(
      BASE_SEPOLIA_CHAIN_ID,
      BASE_SEPOLIA_CHAIN_ID,
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      DEFAULT_GAS_LIMIT,
      { value: ethers.parseEther("1.0") }
    );
    await reactive.waitForDeployment();

    // 2. Deploy OriginPriceVault on Base Sepolia binding immutable _CALLBACK_SENDER = reactive
    const VaultFactory = await ethers.getContractFactory("OriginPriceVault");
    vault = await VaultFactory.deploy(
      await callbackProxy.getAddress(),
      await reactive.getAddress(),
      INITIAL_PRICE,
      DEFAULT_COOLDOWN,
      { value: ethers.parseEther("0.5") }
    );
    await vault.waitForDeployment();

    // 3. Configure & subscribe vault on OmniGuardReactive
    await reactive.configureVaultAndSubscribe(
      await vault.getAddress(),
      await vault.getAddress()
    );

    await vault.setGuardian(guardian.address);
    await vault.setPriceOracle(oracle.address);
  });

  // =========================================================================
  // 1. Deployment & Subscription Lifecycle
  // =========================================================================

  describe("1. Deployment & Reactive Omni Subscription Lifecycle", function () {
    it("binds immutable _CALLBACK_SENDER and registers exact SYSTEM.subscribe parameters", async function () {
      expect(await vault._SERVICE_PROVIDER()).to.equal(await callbackProxy.getAddress());
      expect(await vault._CALLBACK_SENDER()).to.equal(await reactive.getAddress());
      expect(await reactive._SERVICE_PROVIDER()).to.equal(SYSTEM_ADDR);
      expect(await reactive.subscribed()).to.equal(true);

      const subCount = await systemContract.subscriptionCount();
      expect(subCount).to.equal(1n);
      const sub = await systemContract.subscriptions(0);
      expect(sub.subscriber).to.equal(await reactive.getAddress());
      expect(sub.chainId).to.equal(BASE_SEPOLIA_CHAIN_ID);
      expect(sub.contractAddress).to.equal(await vault.getAddress());
      expect(sub.topic0).to.equal(BigInt(healthFactorTopic0));
      expect(sub.topic1).to.equal(BigInt(REACTIVE_IGNORE));
      expect(sub.active).to.equal(true);
    });

    it("rejects invalid constructor arguments on both contracts", async function () {
      const ReactiveFactory = await ethers.getContractFactory("OmniGuardReactive");
      await expect(
        ReactiveFactory.deploy(0, BASE_SEPOLIA_CHAIN_ID, ethers.ZeroAddress, ethers.ZeroAddress, 500000)
      ).to.be.revertedWithCustomError(ReactiveFactory, "InvalidChainId");

      await expect(
        ReactiveFactory.deploy(
          BASE_SEPOLIA_CHAIN_ID,
          BASE_SEPOLIA_CHAIN_ID,
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          99999 // below 150k safety floor & 100k Reactive min
        )
      ).to.be.revertedWithCustomError(ReactiveFactory, "InvalidGasLimit");

      const VaultFactory = await ethers.getContractFactory("OriginPriceVault");
      await expect(
        VaultFactory.deploy(ethers.ZeroAddress, await reactive.getAddress(), INITIAL_PRICE, 15)
      ).to.be.revertedWithCustomError(VaultFactory, "ZeroAddress");

      await expect(
        VaultFactory.deploy(await callbackProxy.getAddress(), ethers.ZeroAddress, INITIAL_PRICE, 15)
      ).to.be.revertedWithCustomError(VaultFactory, "ZeroAddress");

      await expect(
        VaultFactory.deploy(await callbackProxy.getAddress(), await reactive.getAddress(), 0, 15)
      ).to.be.revertedWithCustomError(VaultFactory, "InvalidPrice");
    });

    it("supports clean unsubscribe and owner-only re-subscription", async function () {
      await expect(
        reactive.connect(attacker).unsubscribeCurrentVault()
      ).to.be.revertedWithCustomError(reactive, "OnlyOwner");

      await expect(reactive.unsubscribeCurrentVault())
        .to.emit(reactive, "VaultUnsubscribed")
        .withArgs(BASE_SEPOLIA_CHAIN_ID, await vault.getAddress());

      expect(await reactive.subscribed()).to.equal(false);
      const sub = await systemContract.subscriptions(0);
      expect(sub.active).to.equal(false);

      await expect(
        reactive.configureVaultAndSubscribe(await vault.getAddress(), await vault.getAddress())
      ).to.emit(reactive, "VaultSubscribed");
      expect(await reactive.subscribed()).to.equal(true);
    });

    it("prevents duplicate configureVaultAndSubscribe while already subscribed", async function () {
      await expect(
        reactive.configureVaultAndSubscribe(await vault.getAddress(), await vault.getAddress())
      ).to.be.revertedWithCustomError(reactive, "VaultAlreadySubscribed");
    });
  });

  // =========================================================================
  // 2. Full 3-Hop Origin -> Reactive -> Callback Execution Loop
  // =========================================================================

  describe("2. End-to-End 3-Hop Reactive Omni Protection Loop", function () {
    it("executes REBALANCE using Shield Reserve FIRST (zero ETH collateral sold!)", async function () {
      // Alice deposits 10 ETH ($25,000) + $5,000 Shield Reserve, borrows $18,000 (HF = 1.3888x)
      await vault
        .connect(alice)
        .openOrTopUpPosition(ethers.parseEther("10"), ethers.parseUnits("5000", 18));
      await vault.connect(alice).borrow(ethers.parseUnits("18000", 18));

      // Oracle drops ETH to $2,100 -> Collateral = $21,000, HF = 11,666 bps (< 12,000 REBALANCE)
      const priceTx = await vault
        .connect(oracle)
        .updateOraclePrice(ethers.parseUnits("2100", 18), [alice.address]);
      const priceReceipt = await priceTx.wait();

      const result = await relayOriginToDestination(priceReceipt);
      expect(result.callbackDispatched).to.equal(true);

      // Shield reserve absorbs the entire $4,000 debt reduction ($18,000 -> $14,000 -> HF = 1.5000x)
      const pos = await vault.getPosition(alice.address);
      expect(pos.collateralAmount).to.equal(ethers.parseEther("10")); // 0 collateral liquidated!
      expect(pos.debtUsd).to.equal(ethers.parseUnits("14000", 18));
      expect(pos.shieldReserveUsd).to.equal(ethers.parseUnits("1000", 18));
      expect(pos.frozen).to.equal(false);
      expect(pos.protectionCount).to.equal(1n);
      expect(await vault.getHealthFactorBps(alice.address)).to.equal(15000n);
    });

    it("executes hybrid REBALANCE (Shield Reserve + exact self-deleverage math to >= 1.50x)", async function () {
      // Alice deposits 10 ETH ($25,000) + $1,000 Shield Reserve, borrows $18,000
      await vault
        .connect(alice)
        .openOrTopUpPosition(ethers.parseEther("10"), ethers.parseUnits("1000", 18));
      await vault.connect(alice).borrow(ethers.parseUnits("18000", 18));

      // ETH drops to $2,100 -> Collateral = $21,000, Debt = $18,000 (HF = 1.1666x)
      // Step A: Shield covers $1,000 -> Debt = $17,000
      // Step B: Self-deleverage sells $9,000 worth of ETH -> C' = $12,000, D' = $8,000 -> HF' = 1.5000x
      const priceTx = await vault
        .connect(oracle)
        .updateOraclePrice(ethers.parseUnits("2100", 18), [alice.address]);
      const result = await relayOriginToDestination(await priceTx.wait());
      expect(result.callbackDispatched).to.equal(true);

      const pos = await vault.getPosition(alice.address);
      expect(pos.shieldReserveUsd).to.equal(0n);
      expect(await vault.getHealthFactorBps(alice.address)).to.be.gte(15000n);
      expect(pos.debtUsd).to.be.lte(ethers.parseUnits("8000", 18));
      expect(pos.collateralAmount).to.be.lt(ethers.parseEther("10"));
      expect(pos.collateralAmount).to.be.gt(ethers.parseEther("5.7"));
    });

    it("runs stateful multi-tier escalation: SAFE -> WARN(1) -> WARN(2)->REBALANCE -> EMERGENCY_FREEZE", async function () {
      await vault
        .connect(alice)
        .openOrTopUpPosition(ethers.parseEther("10"), ethers.parseUnits("500", 18));
      await vault.connect(alice).borrow(ethers.parseUnits("18000", 18));

      // Step 1: SAFE ($2,500 -> HF = 13,888 bps >= 13,500) -> NO callback
      let tx = await vault.connect(oracle).updateOraclePrice(ethers.parseUnits("2500", 18), [alice.address]);
      let res = await relayOriginToDestination(await tx.wait());
      expect(res.callbackDispatched).to.equal(false);
      let state = await reactive.getUserRiskState(alice.address);
      expect(state.lastTier).to.equal(0n); // SAFE
      expect(state.warnStreak).to.equal(0n);

      // Step 2: First WARN ($2,350 -> HF = 13,055 bps in [12000, 13500)) -> Streak=1, NO callback
      await advanceTime(2);
      tx = await vault.connect(oracle).updateOraclePrice(ethers.parseUnits("2350", 18), [alice.address]);
      res = await relayOriginToDestination(await tx.wait());
      expect(res.callbackDispatched).to.equal(false);
      state = await reactive.getUserRiskState(alice.address);
      expect(state.lastTier).to.equal(1n); // WARN
      expect(state.warnStreak).to.equal(1n);

      // Step 3: Second consecutive WARN within 60s window ($2,250 -> HF = 12,500 bps) -> Auto-escalates to REBALANCE!
      await advanceTime(5);
      tx = await vault.connect(oracle).updateOraclePrice(ethers.parseUnits("2250", 18), [alice.address]);
      res = await relayOriginToDestination(await tx.wait());
      expect(res.callbackDispatched).to.equal(true);
      state = await reactive.getUserRiskState(alice.address);
      expect(state.lastTier).to.equal(2n); // REBALANCE
      expect(state.actionNonce).to.equal(1n);
      expect(await vault.getHealthFactorBps(alice.address)).to.be.gte(15000n);

      // Step 4: Immediate catastrophic flash crash 2 seconds later (STILL inside 15s rebalance cooldown!)
      // Drops ETH 35% to $1,460 -> HF drops below 1.08x -> EMERGENCY_FREEZE bypasses cooldown!
      await advanceTime(2);
      tx = await vault.connect(oracle).updateOraclePrice(ethers.parseUnits("1460", 18), [alice.address]);
      res = await relayOriginToDestination(await tx.wait());
      expect(res.callbackDispatched).to.equal(true);

      const pos = await vault.getPosition(alice.address);
      expect(pos.frozen).to.equal(true);
      expect(pos.lastActionTier).to.equal(3n); // EMERGENCY_FREEZE
      expect(await vault.totalCircuitBreakerTrips()).to.equal(1n);
      expect(await reactive.totalEmergencyFreezesRequested()).to.equal(1n);
    });

    it("enforces circuit-breaker freeze on borrow/withdraw while allowing recovery top-up and unfreeze", async function () {
      await vault.connect(alice).openOrTopUpPosition(ethers.parseEther("10"), 0);
      await vault.connect(alice).borrow(ethers.parseUnits("18000", 18));

      // Flash crash to $1,900 -> HF = 10,555 bps < 10,800 -> EMERGENCY_FREEZE
      const tx = await vault.connect(oracle).updateOraclePrice(ethers.parseUnits("1900", 18), [alice.address]);
      await relayOriginToDestination(await tx.wait());

      expect((await vault.getPosition(alice.address)).frozen).to.equal(true);

      // Frozen position blocks new borrows & collateral withdrawals
      await expect(
        vault.connect(alice).borrow(ethers.parseUnits("100", 18))
      ).to.be.revertedWithCustomError(vault, "PositionFrozen");
      await expect(
        vault.connect(alice).withdrawCollateral(ethers.parseEther("0.1"))
      ).to.be.revertedWithCustomError(vault, "PositionFrozen");

      // User CAN still top up collateral to recover
      await vault.connect(alice).openOrTopUpPosition(ethers.parseEther("5"), 0);
      expect(await vault.getHealthFactorBps(alice.address)).to.be.gte(15000n);

      // Unrelated attacker cannot unfreeze Alice's vault
      await expect(
        vault.connect(attacker).unfreezePosition(alice.address)
      ).to.be.revertedWithCustomError(vault, "UnauthorizedGuardian");

      // Alice can self-unfreeze now that HF >= 1.30x
      await expect(vault.connect(alice).unfreezePosition(alice.address))
        .to.emit(vault, "PositionUnfrozen");
      expect((await vault.getPosition(alice.address)).frozen).to.equal(false);
    });

    it("routes cross-chain callbacks cleanly (Base Sepolia 84532 -> Unichain Sepolia 1301)", async function () {
      const ReactiveFactory = await ethers.getContractFactory("OmniGuardReactive");
      const crossChainReactive = await ReactiveFactory.deploy(
        BASE_SEPOLIA_CHAIN_ID,
        UNICHAIN_SEPOLIA_CHAIN_ID,
        await vault.getAddress(),
        bob.address, // simulated remote Unichain callback receiver
        DEFAULT_GAS_LIMIT,
        { value: ethers.parseEther("0.5") }
      );
      await crossChainReactive.waitForDeployment();

      await vault.connect(alice).openOrTopUpPosition(ethers.parseEther("10"), 0);
      await vault.connect(alice).borrow(ethers.parseUnits("18000", 18));
      const tx = await vault.connect(oracle).updateOraclePrice(ethers.parseUnits("2100", 18), [alice.address]);
      const logRecord = buildLogRecordFromReceipt(await tx.wait(), await vault.getAddress());

      const beforeCount = await systemContract.pendingCallbackCount();
      await systemContract.trigger(await crossChainReactive.getAddress(), logRecord);
      const afterCount = await systemContract.pendingCallbackCount();

      expect(afterCount).to.equal(beforeCount + 1n);
      const cb = await systemContract.getPendingCallback(afterCount - 1n);
      expect(cb.chainId).to.equal(UNICHAIN_SEPOLIA_CHAIN_ID);
      expect(cb.recipient).to.equal(bob.address);
      expect(cb.reactiveSender).to.equal(await crossChainReactive.getAddress());
    });
  });

  // =========================================================================
  // 3. Base Sepolia 200ms Block-Rate Safety & Timestamp Cooldowns
  // =========================================================================

  describe("3. Base Sepolia 200ms Block Safety & Wall-Clock Timestamp Cooldowns", function () {
    it("enforces wall-clock 15s cooldown even after mining 100 rapid blocks (200ms block-safe!)", async function () {
      await vault.connect(alice).openOrTopUpPosition(ethers.parseEther("10"), 0);
      await vault.connect(alice).borrow(ethers.parseUnits("18000", 18));

      // First breach triggers REBALANCE
      let tx = await vault.connect(oracle).updateOraclePrice(ethers.parseUnits("2100", 18), [alice.address]);
      let res = await relayOriginToDestination(await tx.wait());
      expect(res.callbackDispatched).to.equal(true);

      // Simulate 100 rapid Base Sepolia blocks in ~2 seconds! (Mine 100 blocks with 0s/1s gap)
      await network.provider.send("hardhat_mine", ["0x64", "0x0"]); // 100 blocks, 0s timestamp delta!
      await advanceTime(3); // only 3 wall-clock seconds elapsed (< 15s cooldown)

      // Drop price slightly into REBALANCE band again (~1.16x)
      tx = await vault.connect(oracle).updateOraclePrice(ethers.parseUnits("1620", 18), [alice.address]);
      const log2 = buildLogRecordFromReceipt(await tx.wait(), await vault.getAddress());

      // Reactive MUST suppress duplicate callback via CooldownSuppressed
      const beforeCb = await systemContract.pendingCallbackCount();
      await expect(systemContract.trigger(await reactive.getAddress(), log2)).to.emit(
        reactive,
        "CooldownSuppressed"
      );
      expect(await systemContract.pendingCallbackCount()).to.equal(beforeCb);
      expect(await reactive.totalCooldownSuppressions()).to.equal(1n);

      // Advance wall-clock by 14s (total 17s > 15s cooldown) -> just 1 block -> REBALANCE now fires!
      await advanceTime(14);
      tx = await vault.checkAndEmitHealthFactor(alice.address);
      res = await relayOriginToDestination(await tx.wait());
      expect(res.callbackDispatched).to.equal(true);
    });

    it("enforces on-chain vaultCooldownSeconds independently inside OriginPriceVault", async function () {
      await vault.connect(alice).openOrTopUpPosition(ethers.parseEther("10"), 0);
      await vault.connect(alice).borrow(ethers.parseUnits("18000", 18));

      const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const iface = vault.interface;

      // Deliver valid nonce=1 REBALANCE callback directly through proxy
      const payload1 = iface.encodeFunctionData("executeEmergencyDeleverage", [
        await reactive.getAddress(),
        alice.address,
        15000n,
        now,
        1n,
        2,
      ]);
      await callbackProxy.deliverCallback(
        { chainId: BASE_SEPOLIA_CHAIN_ID, recipient: await vault.getAddress(), gasLimit: 500000n, payload: payload1 },
        true
      );

      // Only 5s later (even with a new monotonic nonce=2), Vault itself blocks REBALANCE with CooldownActive
      await advanceTime(5);
      const now2 = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const payload2 = iface.encodeFunctionData("executeEmergencyDeleverage", [
        await reactive.getAddress(),
        alice.address,
        15000n,
        now2,
        2n,
        2,
      ]);
      await expect(
        callbackProxy.deliverCallback(
          { chainId: BASE_SEPOLIA_CHAIN_ID, recipient: await vault.getAddress(), gasLimit: 500000n, payload: payload2 },
          true
        )
      ).to.be.revertedWithCustomError(vault, "CooldownActive");
    });

    it("rejects stale callbacks (> maxCallbackDelaySeconds) and future-dated trigger timestamps", async function () {
      await vault.connect(alice).openOrTopUpPosition(ethers.parseEther("10"), 0);
      await vault.connect(alice).borrow(ethers.parseUnits("18000", 18));

      const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const iface = vault.interface;

      // Stale triggerTs (400 seconds old > 300s default maxCallbackDelaySeconds)
      const stalePayload = iface.encodeFunctionData("executeEmergencyDeleverage", [
        await reactive.getAddress(),
        alice.address,
        15000n,
        now - 400n,
        1n,
        2,
      ]);
      await expect(
        callbackProxy.deliverCallback(
          { chainId: BASE_SEPOLIA_CHAIN_ID, recipient: await vault.getAddress(), gasLimit: 500000n, payload: stalePayload },
          true
        )
      ).to.be.revertedWithCustomError(vault, "StaleCallback");

      // Future triggerTs (+120s > 30s skew tolerance)
      const futurePayload = iface.encodeFunctionData("executeEmergencyDeleverage", [
        await reactive.getAddress(),
        alice.address,
        15000n,
        now + 120n,
        1n,
        2,
      ]);
      await expect(
        callbackProxy.deliverCallback(
          { chainId: BASE_SEPOLIA_CHAIN_ID, recipient: await vault.getAddress(), gasLimit: 500000n, payload: futurePayload },
          true
        )
      ).to.be.revertedWithCustomError(vault, "FutureTimestamp");
    });

    it("gracefully ignores out-of-order stale event timestamps inside react() without reverting", async function () {
      await vault.connect(alice).openOrTopUpPosition(ethers.parseEther("10"), 0);
      await vault.connect(alice).borrow(ethers.parseUnits("18000", 18));

      const tx1 = await vault.connect(oracle).updateOraclePrice(ethers.parseUnits("2500", 18), [alice.address]);
      const log1 = buildLogRecordFromReceipt(await tx1.wait(), await vault.getAddress());

      await advanceTime(10);
      const tx2 = await vault.connect(oracle).updateOraclePrice(ethers.parseUnits("2500", 18), [alice.address]);
      const log2 = buildLogRecordFromReceipt(await tx2.wait(), await vault.getAddress());

      // Deliver newer log2 first, then older log1 out-of-order
      await systemContract.trigger(await reactive.getAddress(), log2);
      await expect(systemContract.trigger(await reactive.getAddress(), log1))
        .to.emit(reactive, "ReactionIgnored")
        .withArgs(ethers.encodeBytes32String("STALE_EVENT_TS"), BASE_SEPOLIA_CHAIN_ID, await vault.getAddress());
    });
  });

  // =========================================================================
  // 4. Adversarial Security & Authentication Tests
  // =========================================================================

  describe("4. Adversarial Security, Auth & Reentrancy Hardening", function () {
    it("blocks unauthorized caller invoking executeEmergencyDeleverage directly (onlyServiceProvider)", async function () {
      await vault.connect(alice).openOrTopUpPosition(ethers.parseEther("10"), 0);
      await vault.connect(alice).borrow(ethers.parseUnits("18000", 18));

      const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      await expect(
        vault
          .connect(attacker)
          .executeEmergencyDeleverage(await reactive.getAddress(), alice.address, 15000n, now, 1n, 2)
      ).to.be.revertedWithCustomError(vault, "NotAuthorized");
    });

    it("blocks spoofed reactiveSender delivered via legitimate CallbackProxy (onlyCallbackSender)", async function () {
      await vault.connect(alice).openOrTopUpPosition(ethers.parseEther("10"), 0);
      await vault.connect(alice).borrow(ethers.parseUnits("18000", 18));

      const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const spoofedPayload = vault.interface.encodeFunctionData("executeEmergencyDeleverage", [
        attacker.address, // SPOOFED reactive contract!
        alice.address,
        15000n,
        now,
        1n,
        2,
      ]);

      await expect(
        callbackProxy.deliverCallback(
          {
            chainId: BASE_SEPOLIA_CHAIN_ID,
            recipient: await vault.getAddress(),
            gasLimit: 500000n,
            payload: spoofedPayload,
          },
          true
        )
      ).to.be.revertedWithCustomError(vault, "CallbackNotAuthorized");
    });

    it("blocks unauthorized caller invoking OmniGuardReactive.react() directly (onlySystem)", async function () {
      const fakeLog = {
        chainId: BASE_SEPOLIA_CHAIN_ID,
        contractAddress: await vault.getAddress(),
        topic0: BigInt(healthFactorTopic0),
        topic1: BigInt(alice.address),
        topic2: 0n,
        topic3: 0n,
        data: ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint256", "uint256", "uint256", "uint256"],
          [11000n, ethers.parseUnits("20000", 18), ethers.parseUnits("18000", 18), 1700000000n]
        ),
        blockNumber: 1n,
        opCode: 3n,
        blockHash: 1n,
        txHash: 1n,
        logIndex: 0n,
      };

      await expect(
        reactive.connect(attacker).react(fakeLog)
      ).to.be.revertedWithCustomError(reactive, "NotAuthorized");
    });

    it("blocks callback replay and non-monotonic nonce injection", async function () {
      await vault.connect(alice).openOrTopUpPosition(ethers.parseEther("10"), 0);
      await vault.connect(alice).borrow(ethers.parseUnits("18000", 18));

      const tx = await vault.connect(oracle).updateOraclePrice(ethers.parseUnits("2100", 18), [alice.address]);
      const res = await relayOriginToDestination(await tx.wait());
      expect(res.callbackDispatched).to.equal(true);

      // Replay exact same callback payload (nonce=1) after cooldown
      await advanceTime(30);
      const cb = await systemContract.getPendingCallback(res.callbackIndex);
      await expect(
        callbackProxy.deliverCallback(
          { chainId: cb.chainId, recipient: cb.recipient, gasLimit: cb.gasLimit, payload: cb.payload },
          true
        )
      ).to.be.revertedWithCustomError(vault, "NonMonotonicNonce");

      // Zero nonce also rejected
      const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const zeroNoncePayload = vault.interface.encodeFunctionData("executeEmergencyDeleverage", [
        await reactive.getAddress(),
        alice.address,
        15000n,
        now,
        0n,
        2,
      ]);
      await expect(
        callbackProxy.deliverCallback(
          { chainId: BASE_SEPOLIA_CHAIN_ID, recipient: await vault.getAddress(), gasLimit: 500000n, payload: zeroNoncePayload },
          true
        )
      ).to.be.revertedWithCustomError(vault, "NonMonotonicNonce");
    });

    it("defends against malicious callback proxy reentrancy during coverDebt() payout", async function () {
      const ReentrantProxy = await ethers.getContractFactory("ReentrantCallbackProxyMock");
      const evilProxy = await ReentrantProxy.deploy();
      await evilProxy.waitForDeployment();

      const VaultFactory = await ethers.getContractFactory("OriginPriceVault");
      const guardedVault = await VaultFactory.deploy(
        await evilProxy.getAddress(),
        await reactive.getAddress(),
        INITIAL_PRICE,
        DEFAULT_COOLDOWN,
        { value: ethers.parseEther("1.0") }
      );
      await guardedVault.waitForDeployment();

      await guardedVault.connect(alice).openOrTopUpPosition(ethers.parseEther("10"), 0);
      await guardedVault.connect(alice).borrow(ethers.parseUnits("18000", 18));

      const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const reentryCalldata = guardedVault.interface.encodeFunctionData("executeEmergencyDeleverage", [
        await reactive.getAddress(),
        alice.address,
        15000n,
        now,
        1n,
        2,
      ]);

      await evilProxy.configureAttack(
        await guardedVault.getAddress(),
        reentryCalldata,
        ethers.parseEther("0.01")
      );

      // coverDebt() pays evilProxy -> evilProxy.receive() attempts re-entering executeEmergencyDeleverage()
      await guardedVault.coverDebt();

      expect(await evilProxy.reentryAttempted()).to.equal(true);
      expect(await evilProxy.reentrySucceeded()).to.equal(false); // ReentrancyGuard blocked it!
      expect((await guardedVault.getPosition(alice.address)).protectionCount).to.equal(0n);
    });

    it("handles wrong chain/vault/topic/malformed-data/paused logs in react() WITHOUT reverting (gas-safe)", async function () {
      const validData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256", "uint256", "uint256"],
        [11000n, ethers.parseUnits("20000", 18), ethers.parseUnits("18000", 18), 1800000000n]
      );

      const baseLog = {
        chainId: BASE_SEPOLIA_CHAIN_ID,
        contractAddress: await vault.getAddress(),
        topic0: BigInt(healthFactorTopic0),
        topic1: BigInt(alice.address),
        topic2: 0n,
        topic3: 0n,
        data: validData,
        blockNumber: 1n,
        opCode: 3n,
        blockHash: 1n,
        txHash: 1n,
        logIndex: 0n,
      };

      // Wrong chain
      await expect(
        systemContract.trigger(await reactive.getAddress(), { ...baseLog, chainId: 999999n })
      )
        .to.emit(reactive, "ReactionIgnored")
        .withArgs(ethers.encodeBytes32String("FILTER_MISMATCH"), 999999n, await vault.getAddress());

      // Malformed truncated data (< 128 bytes)
      await expect(
        systemContract.trigger(await reactive.getAddress(), { ...baseLog, data: "0x1234" })
      )
        .to.emit(reactive, "ReactionIgnored")
        .withArgs(ethers.encodeBytes32String("MALFORMED_DATA"), BASE_SEPOLIA_CHAIN_ID, await vault.getAddress());

      // Zero user address in topic1
      await expect(
        systemContract.trigger(await reactive.getAddress(), { ...baseLog, topic1: 0n })
      )
        .to.emit(reactive, "ReactionIgnored")
        .withArgs(ethers.encodeBytes32String("ZERO_USER"), BASE_SEPOLIA_CHAIN_ID, await vault.getAddress());

      // Paused reactive contract
      await reactive.setPaused(true);
      await expect(systemContract.trigger(await reactive.getAddress(), baseLog))
        .to.emit(reactive, "ReactionIgnored")
        .withArgs(ethers.encodeBytes32String("PAUSED"), BASE_SEPOLIA_CHAIN_ID, await vault.getAddress());

      expect(await systemContract.pendingCallbackCount()).to.equal(0n);
    });

    it("rejects invalid callback tier, out-of-bounds targetBps, and redundant duplicate freeze", async function () {
      await vault.connect(alice).openOrTopUpPosition(ethers.parseEther("10"), 0);
      await vault.connect(alice).borrow(ethers.parseUnits("18000", 18));
      const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);

      // Invalid tier = 1 (WARN is never a valid destination callback)
      const badTier = vault.interface.encodeFunctionData("executeEmergencyDeleverage", [
        await reactive.getAddress(),
        alice.address,
        15000n,
        now,
        1n,
        1,
      ]);
      await expect(
        callbackProxy.deliverCallback(
          { chainId: BASE_SEPOLIA_CHAIN_ID, recipient: await vault.getAddress(), gasLimit: 500000n, payload: badTier },
          true
        )
      ).to.be.revertedWithCustomError(vault, "InvalidTier");

      // Invalid targetBps = 11000 (< 12000 min)
      const badTarget = vault.interface.encodeFunctionData("executeEmergencyDeleverage", [
        await reactive.getAddress(),
        alice.address,
        11000n,
        now,
        1n,
        2,
      ]);
      await expect(
        callbackProxy.deliverCallback(
          { chainId: BASE_SEPOLIA_CHAIN_ID, recipient: await vault.getAddress(), gasLimit: 500000n, payload: badTarget },
          true
        )
      ).to.be.revertedWithCustomError(vault, "InvalidTargetBps");

      // Valid EMERGENCY_FREEZE (nonce=1), then duplicate EMERGENCY_FREEZE (nonce=2) reverts PositionAlreadyFrozen
      const freeze1 = vault.interface.encodeFunctionData("executeEmergencyDeleverage", [
        await reactive.getAddress(),
        alice.address,
        15000n,
        now,
        1n,
        3,
      ]);
      await callbackProxy.deliverCallback(
        { chainId: BASE_SEPOLIA_CHAIN_ID, recipient: await vault.getAddress(), gasLimit: 500000n, payload: freeze1 },
        true
      );

      const freeze2 = vault.interface.encodeFunctionData("executeEmergencyDeleverage", [
        await reactive.getAddress(),
        alice.address,
        15000n,
        now,
        2n,
        3,
      ]);
      await expect(
        callbackProxy.deliverCallback(
          { chainId: BASE_SEPOLIA_CHAIN_ID, recipient: await vault.getAddress(), gasLimit: 500000n, payload: freeze2 },
          true
        )
      ).to.be.revertedWithCustomError(vault, "PositionAlreadyFrozen");
    });

    it("enforces Reactive billing (pay() onlyServiceProvider) and settles debt via coverDebt()", async function () {
      await expect(vault.connect(attacker).pay(100)).to.be.revertedWithCustomError(
        vault,
        "NotAuthorized"
      );
      await expect(reactive.connect(attacker).pay(100)).to.be.revertedWithCustomError(
        reactive,
        "NotAuthorized"
      );

      // Simulate accrued system debt on Reactive + callback debt on Vault
      await systemContract.setDebt(await reactive.getAddress(), ethers.parseEther("0.05"));
      await callbackProxy.setDebt(await vault.getAddress(), ethers.parseEther("0.02"));

      expect(await reactive.systemDebt()).to.equal(ethers.parseEther("0.05"));
      expect(await vault.callbackDebt()).to.equal(ethers.parseEther("0.02"));

      await reactive.coverDebt();
      await vault.coverDebt();

      expect(await reactive.systemDebt()).to.equal(0n);
      expect(await vault.callbackDebt()).to.equal(0n);
    });
  });

  // =========================================================================
  // 5. Edge Cases, Arithmetic Extremes, Governance & Gas Ceiling
  // =========================================================================

  describe("5. Edge Cases, Overflow Safety, Controls & Reactive Gas Budget", function () {
    it("handles extreme underwater crash (HF < 1.00x) cleanly without arithmetic underflow", async function () {
      await vault.connect(alice).openOrTopUpPosition(ethers.parseEther("10"), 0);
      await vault.connect(alice).borrow(ethers.parseUnits("18000", 18));

      // Catastrophic 75% crash ($2,500 -> $600 -> Collateral = $6,000 < Debt = $18,000, HF = 0.33x)
      const tx = await vault.connect(oracle).updateOraclePrice(ethers.parseUnits("600", 18), [alice.address]);
      const res = await relayOriginToDestination(await tx.wait());
      expect(res.callbackDispatched).to.equal(true);

      const pos = await vault.getPosition(alice.address);
      expect(pos.collateralAmount).to.equal(0n); // All collateral seized safely
      expect(pos.debtUsd).to.equal(ethers.parseUnits("12000", 18)); // Reduced by exact $6,000 without underflow
      expect(pos.frozen).to.equal(true); // Circuit breaker tripped!
    });

    it("handles massive treasury scale ($100M+) and zero-debt positions without overflow", async function () {
      // Bob deposits 50,000 ETH ($125,000,000) + $5M shield, borrows $90,000,000
      await vault
        .connect(bob)
        .openOrTopUpPosition(ethers.parseEther("50000"), ethers.parseUnits("5000000", 18));
      await vault.connect(bob).borrow(ethers.parseUnits("90000000", 18));

      // ETH drops to $2,100 -> Collateral = $105M, Debt = $90M, HF = 11,666 bps
      const tx = await vault.connect(oracle).updateOraclePrice(ethers.parseUnits("2100", 18), [bob.address]);
      const res = await relayOriginToDestination(await tx.wait());
      expect(res.callbackDispatched).to.equal(true);
      expect(await vault.getHealthFactorBps(bob.address)).to.be.gte(15000n);

      // Repay all debt -> zero-debt HF = max uint256 and triggers 0 callbacks
      const remaining = (await vault.getPosition(bob.address)).debtUsd;
      const repayTx = await vault.connect(bob).repayDebt(remaining);
      const repayRes = await relayOriginToDestination(await repayTx.wait());
      expect(repayRes.callbackDispatched).to.equal(false);
      expect(await vault.getHealthFactorBps(bob.address)).to.equal(ethers.MaxUint256);
    });

    it("enforces oracle auth, zero-price guard, and bounded batch size (<= 25 users)", async function () {
      await expect(
        vault.connect(attacker).updateOraclePrice(ethers.parseUnits("2000", 18), [])
      ).to.be.revertedWithCustomError(vault, "UnauthorizedOracle");

      await expect(
        vault.connect(oracle).updateOraclePrice(0, [])
      ).to.be.revertedWithCustomError(vault, "InvalidPrice");

      const tooManyUsers = Array.from({ length: 26 }, () => alice.address);
      await expect(
        vault.connect(oracle).updateOraclePrice(ethers.parseUnits("2000", 18), tooManyUsers)
      ).to.be.revertedWithCustomError(vault, "BatchTooLarge");
    });

    it("enforces guardian pause/unpause and owner native rescue across both contracts", async function () {
      await vault.connect(alice).openOrTopUpPosition(ethers.parseEther("10"), 0);
      await vault.connect(alice).borrow(ethers.parseUnits("18000", 18));

      // Guardian pauses vault
      await vault.connect(guardian).pause();
      await expect(
        vault.connect(alice).borrow(ethers.parseUnits("100", 18))
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");

      // Callbacks also halt while vault is paused
      const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const payload = vault.interface.encodeFunctionData("executeEmergencyDeleverage", [
        await reactive.getAddress(),
        alice.address,
        15000n,
        now,
        1n,
        2,
      ]);
      await expect(
        callbackProxy.deliverCallback(
          { chainId: BASE_SEPOLIA_CHAIN_ID, recipient: await vault.getAddress(), gasLimit: 500000n, payload },
          true
        )
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");

      await vault.connect(guardian).unpause();

      // Owner rescue succeeds; attacker rescue fails
      await expect(
        vault.connect(attacker).rescueNative(attacker.address, ethers.parseEther("0.1"))
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");

      const beforeBal = await ethers.provider.getBalance(owner.address);
      await vault.rescueNative(owner.address, ethers.parseEther("0.1"));
      await reactive.rescueNative(owner.address, ethers.parseEther("0.2"));
      const afterBal = await ethers.provider.getBalance(owner.address);
      expect(afterBal).to.be.gt(beforeBal);
    });

    it("validates threshold & cooldown governance bounds on OmniGuardReactive", async function () {
      // Broken threshold ordering rejected
      await expect(
        reactive.updateThresholds(12000, 12000, 10800, 15000)
      ).to.be.revertedWithCustomError(reactive, "InvalidThresholds");

      await expect(
        reactive.updateThresholds(13500, 12000, 9900, 15000) // freeze < 10000
      ).to.be.revertedWithCustomError(reactive, "InvalidThresholds");

      // Valid threshold update succeeds
      await expect(reactive.updateThresholds(14000, 12500, 11000, 16000)).to.emit(
        reactive,
        "ThresholdsUpdated"
      );
      expect(await reactive.targetHealthBps()).to.equal(16000n);

      // Invalid cooldown config rejected
      await expect(reactive.updateCooldowns(0, 300, 60, 2)).to.be.revertedWithCustomError(
        reactive,
        "InvalidCooldownConfig"
      );
      await expect(reactive.updateCooldowns(15, 30, 60, 2)).to.be.revertedWithCustomError(
        reactive,
        "InvalidCooldownConfig"
      );
      await expect(reactive.updateCooldowns(15, 300, 60, 1)).to.be.revertedWithCustomError(
        reactive,
        "InvalidCooldownConfig"
      );

      // Valid cooldown update succeeds
      await expect(reactive.updateCooldowns(20, 600, 90, 3)).to.emit(reactive, "CooldownsUpdated");
    });

    it("skips already-frozen positions in updateOraclePrice and openOrTopUpPosition (zero Lasna drain)", async function () {
      await vault.connect(alice).openOrTopUpPosition(ethers.parseEther("10"), 0);
      await vault.connect(alice).borrow(ethers.parseUnits("18000", 18));

      // Flash crash to $600 -> underwater EMERGENCY_FREEZE (collateral=0, debt=$12,000, frozen=true)
      const crashTx = await vault.connect(oracle).updateOraclePrice(ethers.parseUnits("600", 18), [alice.address]);
      await relayOriginToDestination(await crashTx.wait());
      expect((await vault.getPosition(alice.address)).frozen).to.equal(true);

      // Subsequent oracle price update must NOT emit HealthFactorChanged for frozen Alice
      const nextPriceTx = await vault.connect(oracle).updateOraclePrice(ethers.parseUnits("500", 18), [alice.address]);
      const nextReceipt = await nextPriceTx.wait();
      const emitted = nextReceipt.logs.filter(
        (l) => l.topics[0].toLowerCase() === healthFactorTopic0.toLowerCase()
      );
      expect(emitted.length).to.equal(0);

      // Partial collateral top-up while still frozen must ALSO not emit HealthFactorChanged
      const topUpTx = await vault.connect(alice).openOrTopUpPosition(ethers.parseEther("1"), 0);
      const topUpReceipt = await topUpTx.wait();
      const topUpEmitted = topUpReceipt.logs.filter(
        (l) => l.topics[0].toLowerCase() === healthFactorTopic0.toLowerCase()
      );
      expect(topUpEmitted.length).to.equal(0);
    });

    it("blocks unauthorized callers, frozen/zero-debt positions, and rapid spam on checkAndEmitHealthFactor", async function () {
      await vault.connect(alice).openOrTopUpPosition(ethers.parseEther("10"), 0);

      // Zero-debt position rejected even for authorized caller
      await expect(
        vault.connect(alice).checkAndEmitHealthFactor(alice.address)
      ).to.be.revertedWithCustomError(vault, "ZeroDebtPosition");

      await vault.connect(alice).borrow(ethers.parseUnits("18000", 18));

      // Random attacker cannot spam checkAndEmitHealthFactor to drain Lasna lREACT
      await expect(
        vault.connect(attacker).checkAndEmitHealthFactor(alice.address)
      ).to.be.revertedWithCustomError(vault, "UnauthorizedPulseCaller");

      // Authorized pulse succeeds once
      await expect(vault.connect(alice).checkAndEmitHealthFactor(alice.address)).to.emit(
        vault,
        "HealthFactorChanged"
      );

      // Immediate second pulse inside 15s wall-clock cooldown rejected with PulseCooldownActive
      await advanceTime(5);
      await expect(
        vault.connect(alice).checkAndEmitHealthFactor(alice.address)
      ).to.be.revertedWithCustomError(vault, "PulseCooldownActive");

      // After cooldown expires, pulse succeeds again
      await advanceTime(11);
      await expect(vault.connect(oracle).checkAndEmitHealthFactor(alice.address)).to.emit(
        vault,
        "HealthFactorChanged"
      );

      // Frozen position cannot emit pulses
      const crashTx = await vault.connect(oracle).updateOraclePrice(ethers.parseUnits("1900", 18), [alice.address]);
      await relayOriginToDestination(await crashTx.wait());
      await advanceTime(20);
      await expect(
        vault.connect(alice).checkAndEmitHealthFactor(alice.address)
      ).to.be.revertedWithCustomError(vault, "PositionFrozen");
    });

    it("suppresses repeat EMERGENCY_FREEZE callbacks for 300s retry window and re-arms on unfreezePosition", async function () {
      await vault.connect(alice).openOrTopUpPosition(ethers.parseEther("10"), 0);
      await vault.connect(alice).borrow(ethers.parseUnits("18000", 18));

      // Initial flash crash -> immediate EMERGENCY_FREEZE (nonce=1)
      const crashTx = await vault.connect(oracle).updateOraclePrice(ethers.parseUnits("1900", 18), [alice.address]);
      const crashRes = await relayOriginToDestination(await crashTx.wait());
      expect(crashRes.callbackDispatched).to.equal(true);
      expect((await vault.getPosition(alice.address)).frozen).to.equal(true);

      // Even if a critical log arrives 30s later (< 300s retry window), Reactive suppresses repeat freeze!
      await advanceTime(30);
      const tsNow = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      const repeatedCrashLog = {
        chainId: BASE_SEPOLIA_CHAIN_ID,
        contractAddress: await vault.getAddress(),
        topic0: BigInt(healthFactorTopic0),
        topic1: BigInt(alice.address),
        topic2: 0n,
        topic3: 0n,
        data: ethers.AbiCoder.defaultAbiCoder().encode(
          ["uint256", "uint256", "uint256", "uint256"],
          [9500n, ethers.parseUnits("9500", 18), ethers.parseUnits("10000", 18), tsNow]
        ),
        blockNumber: 10n,
        opCode: 3n,
        blockHash: 10n,
        txHash: 10n,
        logIndex: 0n,
      };
      const beforeCb = await systemContract.pendingCallbackCount();
      await expect(systemContract.trigger(await reactive.getAddress(), repeatedCrashLog)).to.emit(
        reactive,
        "CooldownSuppressed"
      );
      expect(await systemContract.pendingCallbackCount()).to.equal(beforeCb);

      // User tops up collateral and calls unfreezePosition -> emits HealthFactorChanged (SAFE), resetting Reactive state!
      await advanceTime(2);
      await vault.connect(alice).openOrTopUpPosition(ethers.parseEther("10"), 0);
      const unfreezeTx = await vault.connect(alice).unfreezePosition(alice.address);
      const unfreezeRes = await relayOriginToDestination(await unfreezeTx.wait());
      expect(unfreezeRes.callbackDispatched).to.equal(false);
      expect((await reactive.getUserRiskState(alice.address)).lastTier).to.equal(0n); // SAFE

      // New flash crash 2s later ($180 -> HF ~1.04x < 1.08x) immediately re-triggers EMERGENCY_FREEZE (0s delay!)
      await advanceTime(2);
      const crash2Tx = await vault.connect(oracle).updateOraclePrice(ethers.parseUnits("180", 18), [alice.address]);
      const crash2Res = await relayOriginToDestination(await crash2Tx.wait());
      expect(crash2Res.callbackDispatched).to.equal(true);
      expect((await vault.getPosition(alice.address)).frozen).to.equal(true);
      expect(await vault.totalCircuitBreakerTrips()).to.equal(2n);
    });

    it("isolates per-user risk state, nonces, and circuit-breaker freezes across concurrent users", async function () {
      // Alice is leveraged near liquidation; Bob is conservative
      await vault.connect(alice).openOrTopUpPosition(ethers.parseEther("10"), 0);
      await vault.connect(alice).borrow(ethers.parseUnits("18000", 18));

      await vault.connect(bob).openOrTopUpPosition(ethers.parseEther("10"), 0);
      await vault.connect(bob).borrow(ethers.parseUnits("8000", 18));

      // Oracle drops to $1,900 -> Alice HF = 1.055x (EMERGENCY_FREEZE), Bob HF = 2.375x (SAFE)
      const tx = await vault
        .connect(oracle)
        .updateOraclePrice(ethers.parseUnits("1900", 18), [alice.address, bob.address]);
      const receipt = await tx.wait();

      const vaultAddr = await vault.getAddress();
      const matchingLogs = receipt.logs.filter(
        (l) =>
          l.address.toLowerCase() === vaultAddr.toLowerCase() &&
          l.topics[0].toLowerCase() === healthFactorTopic0.toLowerCase()
      );
      expect(matchingLogs.length).to.equal(2);

      // Process both users' logs through Reactive Lasna
      for (const l of matchingLogs) {
        const beforeCb = await systemContract.pendingCallbackCount();
        await systemContract.trigger(await reactive.getAddress(), {
          chainId: BASE_SEPOLIA_CHAIN_ID,
          contractAddress: vaultAddr,
          topic0: BigInt(l.topics[0]),
          topic1: BigInt(l.topics[1]),
          topic2: 0n,
          topic3: 0n,
          data: l.data,
          blockNumber: BigInt(l.blockNumber),
          opCode: 3n,
          blockHash: BigInt(l.blockHash),
          txHash: BigInt(l.transactionHash),
          logIndex: BigInt(l.index),
        });
        const afterCb = await systemContract.pendingCallbackCount();
        if (afterCb > beforeCb) {
          const cb = await systemContract.getPendingCallback(afterCb - 1n);
          await callbackProxy.deliverCallback(
            { chainId: cb.chainId, recipient: cb.recipient, gasLimit: cb.gasLimit, payload: cb.payload },
            true
          );
        }
      }

      // Alice frozen + protected; Bob untouched & still able to borrow
      expect((await vault.getPosition(alice.address)).frozen).to.equal(true);
      expect((await vault.getPosition(bob.address)).frozen).to.equal(false);
      expect((await vault.getPosition(bob.address)).protectionCount).to.equal(0n);
      await expect(vault.connect(bob).borrow(ethers.parseUnits("500", 18))).to.not.be.reverted;
    });

    it("stays well below Reactive Network's 900,000 gas cap during react() callback dispatch", async function () {
      await vault.connect(alice).openOrTopUpPosition(ethers.parseEther("10"), ethers.parseUnits("1000", 18));
      await vault.connect(alice).borrow(ethers.parseUnits("18000", 18));

      const tx = await vault.connect(oracle).updateOraclePrice(ethers.parseUnits("2100", 18), [alice.address]);
      const res = await relayOriginToDestination(await tx.wait());

      expect(res.callbackDispatched).to.equal(true);
      // Reactive Omni caps reactive TXs at 900,000 gas; even including mock storage writes, react() is well under cap!
      const reactGas = await systemContract.lastReactGasUsed();
      expect(reactGas).to.be.lt(550000n);
      expect(res.reactiveReceipt.gasUsed).to.be.lt(650000n);
      // Destination callback fits comfortably inside our 500,000 callbackGasLimit
      expect(res.deliveryReceipt.gasUsed).to.be.lt(250000n);
    });
  });
});
