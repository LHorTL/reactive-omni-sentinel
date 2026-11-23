/**
 * Local end-to-end 3-hop deployment & proof script on Hardhat Network.
 * Installs MockOmniSystemContract at the real Reactive Omni SYSTEM address (0x8888...8888)
 * and demonstrates the full Origin -> Reactive -> Callback loop with gas & math proof.
 */
const { ethers, network } = require("hardhat");

const SYSTEM_ADDR = "0x8888888888888888888888888888888888888888";
const BASE_SEPOLIA_CHAIN_ID = 84532n;

async function main() {
  const [deployer, alice] = await ethers.getSigners();

  const MockSystem = await ethers.getContractFactory("MockOmniSystemContract");
  const deployedSys = await MockSystem.deploy();
  await deployedSys.waitForDeployment();
  await network.provider.send("hardhat_setCode", [
    SYSTEM_ADDR,
    await ethers.provider.getCode(await deployedSys.getAddress()),
  ]);
  const systemContract = await ethers.getContractAt("MockOmniSystemContract", SYSTEM_ADDR);

  const MockProxy = await ethers.getContractFactory("MockOmniCallbackProxy");
  const callbackProxy = await MockProxy.deploy();
  await callbackProxy.waitForDeployment();

  const ReactiveFactory = await ethers.getContractFactory("OmniGuardReactive");
  const reactive = await ReactiveFactory.deploy(
    BASE_SEPOLIA_CHAIN_ID,
    BASE_SEPOLIA_CHAIN_ID,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    500000n,
    { value: ethers.parseEther("1.0") }
  );
  await reactive.waitForDeployment();

  const VaultFactory = await ethers.getContractFactory("OriginPriceVault");
  const vault = await VaultFactory.deploy(
    await callbackProxy.getAddress(),
    await reactive.getAddress(),
    ethers.parseUnits("2500", 18),
    15n,
    { value: ethers.parseEther("0.5") }
  );
  await vault.waitForDeployment();

  await reactive.configureVaultAndSubscribe(await vault.getAddress(), await vault.getAddress());

  // Run full 3-hop protection demonstration
  await vault.connect(alice).openOrTopUpPosition(ethers.parseEther("10"), ethers.parseUnits("1000", 18));
  await vault.connect(alice).borrow(ethers.parseUnits("18000", 18));

  const hfBeforeDrop = await vault.getHealthFactorBps(alice.address);
  const priceTx = await vault.connect(deployer).updateOraclePrice(ethers.parseUnits("2100", 18), [alice.address]);
  const priceReceipt = await priceTx.wait();
  const hfAfterDrop = await vault.getHealthFactorBps(alice.address);

  const topic0 = ethers.id("HealthFactorChanged(address,uint256,uint256,uint256,uint256)");
  const log = priceReceipt.logs.find((l) => l.topics[0] === topic0);

  const reactTx = await systemContract.trigger(await reactive.getAddress(), {
    chainId: BASE_SEPOLIA_CHAIN_ID,
    contractAddress: await vault.getAddress(),
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
  });
  await reactTx.wait();

  const cb = await systemContract.getPendingCallback(0);
  const cbTx = await callbackProxy.deliverCallback(
    { chainId: cb.chainId, recipient: cb.recipient, gasLimit: cb.gasLimit, payload: cb.payload },
    true
  );
  const cbReceipt = await cbTx.wait();
  const hfRestored = await vault.getHealthFactorBps(alice.address);

  console.log("=== OmniGuard Local 3-Hop Reactive Omni Proof ===");
  console.log("SYSTEM Contract:    ", SYSTEM_ADDR);
  console.log("OmniGuardReactive:  ", await reactive.getAddress());
  console.log("OriginPriceVault:   ", await vault.getAddress());
  console.log("CallbackProxy:      ", await callbackProxy.getAddress());
  console.log(`Health Factor Flow:  ${Number(hfBeforeDrop) / 10000}x -> ${Number(hfAfterDrop) / 10000}x (breach) -> ${Number(hfRestored) / 10000}x (restored!)`);
  console.log(`Callback Gas Used:   ${cbReceipt.gasUsed.toString()} gas (limit: 500,000)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
