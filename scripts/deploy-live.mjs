/**
 * Live Reactive Omni 3-Step Deployment Script:
 *   1. Deploy OmniGuardReactive on Reactive Lasna (Chain ID 5318007), funded with lREACT
 *   2. Deploy OriginPriceVault on Base Sepolia (Chain ID 84532), binding immutable _CALLBACK_SENDER & funded with ETH
 *   3. Call OmniGuardReactive.configureVaultAndSubscribe(vault, vault) on Reactive Lasna
 *
 * Writes deployment metadata to `deployments/live.json` (zero secrets!).
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const BASE_CHAIN_ID = 84532n;
const LASNA_CHAIN_ID = 5318007n;
const BASE_RPC = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
const LASNA_RPC = process.env.REACTIVE_LASNA_RPC || "https://lasna-rpc.rnk.dev/";
const BASE_CALLBACK_PROXY =
  process.env.BASE_SEPOLIA_CALLBACK_PROXY || "0x476F44b11F5C942c58f4c8E3d0300E5710743585";

function loadArtifact(contractName) {
  const artifactPath = path.join(
    rootDir,
    "artifacts",
    "contracts",
    `${contractName}.sol`,
    `${contractName}.json`
  );
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Missing artifact ${artifactPath}. Run \`npm run compile\` first.`);
  }
  return JSON.parse(fs.readFileSync(artifactPath, "utf8"));
}

function syncWebLiveConfig(record) {
  const webConfigPath = path.join(rootDir, "web", "src", "config", "networks.js");
  if (!fs.existsSync(webConfigPath)) return;
  const src = fs.readFileSync(webConfigPath, "utf8");
  const updatedBlock = `export const LIVE_DEPLOYMENT = {
  deployed: true,
  originVault: ${JSON.stringify(record.originPriceVault || "")},
  reactiveSentinel: ${JSON.stringify(record.omniGuardReactive || "")},
  sampleOriginTx: ${JSON.stringify(record.liveLoopProof?.originTx || "")},
  sampleReactiveTx: ${JSON.stringify(record.liveLoopProof?.reactiveTx || "")},
  sampleCallbackTx: ${JSON.stringify(record.liveLoopProof?.callbackTx || "")},
};`;
  const replaced = src.replace(/export const LIVE_DEPLOYMENT = \{[\s\S]*?\};/, updatedBlock);
  fs.writeFileSync(webConfigPath, replaced, "utf8");
}

async function main() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY || "";
  if (!pk.startsWith("0x") || pk.length !== 66) {
    throw new Error("Missing DEPLOYER_PRIVATE_KEY in .env. Run `npm run wallet:new` first.");
  }

  const reactiveFund = ethers.parseEther(process.env.REACTIVE_INITIAL_FUND_LREACT || "0.5");
  const vaultFund = ethers.parseEther(process.env.VAULT_CALLBACK_RESERVE_ETH || "0.015");

  const lasnaProvider = new ethers.JsonRpcProvider(LASNA_RPC);
  const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);

  const [baseNet, lasnaNet] = await Promise.all([
    baseProvider.getNetwork(),
    lasnaProvider.getNetwork(),
  ]);
  if (baseNet.chainId !== BASE_CHAIN_ID) {
    throw new Error(`Expected Base Sepolia chainId ${BASE_CHAIN_ID}, got ${baseNet.chainId}`);
  }
  if (lasnaNet.chainId !== LASNA_CHAIN_ID) {
    throw new Error(`Expected Reactive Lasna chainId ${LASNA_CHAIN_ID}, got ${lasnaNet.chainId}`);
  }

  const lasnaWallet = new ethers.Wallet(pk, lasnaProvider);
  const baseWallet = new ethers.Wallet(pk, baseProvider);

  const [lasnaBal, baseBal] = await Promise.all([
    lasnaProvider.getBalance(lasnaWallet.address),
    baseProvider.getBalance(baseWallet.address),
  ]);

  console.log(`Deployer:          ${lasnaWallet.address}`);
  console.log(`Base Sepolia ETH:  ${ethers.formatEther(baseBal)} ETH`);
  console.log(`Reactive lREACT:   ${ethers.formatEther(lasnaBal)} lREACT`);

  if (lasnaBal < reactiveFund + ethers.parseEther("0.05")) {
    throw new Error(
      `Insufficient Lasna lREACT. Need ~${ethers.formatEther(reactiveFund + ethers.parseEther("0.05"))} lREACT; have ${ethers.formatEther(lasnaBal)}. Run \`npm run faucet:bridge\` after funding Base Sepolia ETH.`
    );
  }
  if (baseBal < vaultFund + ethers.parseEther("0.005")) {
    throw new Error(
      `Insufficient Base Sepolia ETH. Need ~${ethers.formatEther(vaultFund + ethers.parseEther("0.005"))} ETH; have ${ethers.formatEther(baseBal)}.`
    );
  }

  const reactiveArtifact = loadArtifact("OmniGuardReactive");
  const vaultArtifact = loadArtifact("OriginPriceVault");

  const lasnaFee = await lasnaProvider.getFeeData();
  const lasnaTip =
    lasnaFee.maxPriorityFeePerGas && lasnaFee.maxPriorityFeePerGas > 0n
      ? lasnaFee.maxPriorityFeePerGas
      : 1_000_000_000n;
  const lasnaMaxFee =
    lasnaFee.maxFeePerGas && lasnaFee.maxFeePerGas >= lasnaTip
      ? lasnaFee.maxFeePerGas
      : (lasnaFee.gasPrice || 100_000_000_000n) + lasnaTip;
  const lasnaOverrides = {
    maxPriorityFeePerGas: lasnaTip,
    maxFeePerGas: lasnaMaxFee,
  };

  // Step 1: Deploy OmniGuardReactive on Reactive Lasna (5318007)
  console.log("\n[1/3] Deploying OmniGuardReactive on Reactive Lasna (5318007)...");
  const ReactiveFactory = new ethers.ContractFactory(
    reactiveArtifact.abi,
    reactiveArtifact.bytecode,
    lasnaWallet
  );
  const reactive = await ReactiveFactory.deploy(
    BASE_CHAIN_ID,
    BASE_CHAIN_ID,
    ethers.ZeroAddress,
    ethers.ZeroAddress,
    500000n,
    { value: reactiveFund, ...lasnaOverrides }
  );
  const reactiveDeployTx = reactive.deploymentTransaction();
  await reactive.waitForDeployment();
  const reactiveAddr = await reactive.getAddress();
  console.log(`  OmniGuardReactive: ${reactiveAddr}`);
  console.log(`  Deploy TX:         https://lasna.reactscan.net/tx/${reactiveDeployTx.hash}`);

  // Step 2: Deploy OriginPriceVault on Base Sepolia (84532)
  console.log("\n[2/3] Deploying OriginPriceVault on Base Sepolia (84532)...");
  const VaultFactory = new ethers.ContractFactory(
    vaultArtifact.abi,
    vaultArtifact.bytecode,
    baseWallet
  );
  const vault = await VaultFactory.deploy(
    BASE_CALLBACK_PROXY,
    reactiveAddr,
    ethers.parseUnits("2500", 18),
    15n,
    { value: vaultFund }
  );
  const vaultDeployTx = vault.deploymentTransaction();
  await vault.waitForDeployment();
  const vaultAddr = await vault.getAddress();
  console.log(`  OriginPriceVault:  ${vaultAddr}`);
  console.log(`  Deploy TX:         https://sepolia.basescan.org/tx/${vaultDeployTx.hash}`);

  // Step 3: Subscribe OmniGuardReactive to OriginPriceVault on Reactive Lasna
  console.log("\n[3/3] Calling configureVaultAndSubscribe() on Reactive Lasna...");
  const subTx = await reactive.configureVaultAndSubscribe(vaultAddr, vaultAddr, lasnaOverrides);
  await subTx.wait();
  console.log(`  Subscribe TX:      https://lasna.reactscan.net/tx/${subTx.hash}`);

  const deploymentsDir = path.join(rootDir, "deployments");
  fs.mkdirSync(deploymentsDir, { recursive: true });
  const record = {
    deployedAt: new Date().toISOString(),
    deployer: lasnaWallet.address,
    originChainId: Number(BASE_CHAIN_ID),
    reactiveChainId: Number(LASNA_CHAIN_ID),
    callbackProxy: BASE_CALLBACK_PROXY,
    systemContract: "0x8888888888888888888888888888888888888888",
    omniGuardReactive: reactiveAddr,
    originPriceVault: vaultAddr,
    txs: {
      reactiveDeploy: reactiveDeployTx.hash,
      vaultDeploy: vaultDeployTx.hash,
      subscribe: subTx.hash,
    },
  };
  fs.writeFileSync(path.join(deploymentsDir, "live.json"), JSON.stringify(record, null, 2));
  syncWebLiveConfig(record);
  console.log("\nSaved deployment manifest to deployments/live.json and synced web/src/config/networks.js.");
  console.log("Next: run `npm run trigger:live` to execute and record the live 3-hop loop!");
}

main().catch((err) => {
  console.error("Live deployment failed:", err.message);
  process.exit(1);
});
