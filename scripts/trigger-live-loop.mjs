/**
 * Triggers a LIVE 3-Hop Reactive Omni End-to-End Loop on Base Sepolia (84532) <-> Reactive Lasna (5318007)
 * and records all 3 explorer-verifiable TX hashes in `deployments/live.json`.
 */
import "dotenv/config";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const BASE_RPC = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
const LASNA_RPC = process.env.REACTIVE_LASNA_RPC || "https://lasna-rpc.rnk.dev/";

function loadArtifact(contractName) {
  const artifactPath = path.join(
    rootDir,
    "artifacts",
    "contracts",
    `${contractName}.sol`,
    `${contractName}.json`
  );
  return JSON.parse(fs.readFileSync(artifactPath, "utf8"));
}

async function main() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY || "";
  if (!pk.startsWith("0x") || pk.length !== 66) {
    throw new Error("Missing DEPLOYER_PRIVATE_KEY in .env.");
  }

  const livePath = path.join(rootDir, "deployments", "live.json");
  if (!fs.existsSync(livePath)) {
    throw new Error("Missing deployments/live.json. Run `npm run deploy:live` first.");
  }
  const manifest = JSON.parse(fs.readFileSync(livePath, "utf8"));

  const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);
  const lasnaProvider = new ethers.JsonRpcProvider(LASNA_RPC);
  const baseWallet = new ethers.Wallet(pk, baseProvider);

  const vault = new ethers.Contract(
    manifest.originPriceVault,
    loadArtifact("OriginPriceVault").abi,
    baseWallet
  );
  const reactive = new ethers.Contract(
    manifest.omniGuardReactive,
    loadArtifact("OmniGuardReactive").abi,
    lasnaProvider
  );

  const beforeProtections = await vault.totalProtectionsExecuted();
  const beforeCallbacks = await reactive.totalCallbacksRequested();
  const lasnaStartBlock = await lasnaProvider.getBlockNumber();
  const baseStartBlock = await baseProvider.getBlockNumber();

  console.log("[1/4] Setting up leveraged position on Base Sepolia OriginPriceVault...");
  const pos = await vault.getPosition(baseWallet.address);
  if (!pos.exists || pos.debtUsd === 0n) {
    const openTx = await vault.openOrTopUpPosition(
      ethers.parseEther("10"),
      ethers.parseUnits("1000", 18)
    );
    await openTx.wait();
    const borrowTx = await vault.borrow(ethers.parseUnits("18000", 18));
    await borrowTx.wait();
  }

  console.log("[2/4] Emitting oracle price shock ($2,500 -> $2,100) on Base Sepolia (Hop 1)...");
  const t0 = Date.now();
  const originTx = await vault.updateOraclePrice(ethers.parseUnits("2100", 18), [baseWallet.address]);
  const originReceipt = await originTx.wait();
  console.log(`  Hop 1 Origin TX:   https://sepolia.basescan.org/tx/${originTx.hash} (block #${originReceipt.blockNumber})`);

  console.log("[3/4] Waiting for Reactive Lasna OmniGuardReactive.react() (Hop 2)...");
  let reactiveTxHash = null;
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const nowCallbacks = await reactive.totalCallbacksRequested();
    if (nowCallbacks > beforeCallbacks) {
      const logs = await reactive.queryFilter(
        reactive.filters.ShieldCallbackDispatched(baseWallet.address),
        lasnaStartBlock,
        "latest"
      );
      if (logs.length > 0) {
        reactiveTxHash = logs[logs.length - 1].transactionHash;
      }
      console.log(`  Hop 2 Reactive TX: https://lasna.reactscan.net/tx/${reactiveTxHash || "detected"} (${Date.now() - t0} ms)`);
      break;
    }
  }

  console.log("[4/4] Waiting for Base Sepolia CallbackProxy -> executeEmergencyDeleverage() (Hop 3)...");
  let callbackTxHash = null;
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const nowProtections = await vault.totalProtectionsExecuted();
    if (nowProtections > beforeProtections) {
      const logs = await vault.queryFilter(
        vault.filters.EmergencyDeleverageExecuted(baseWallet.address),
        baseStartBlock,
        "latest"
      );
      if (logs.length > 0) {
        callbackTxHash = logs[logs.length - 1].transactionHash;
      }
      const hfAfter = await vault.getHealthFactorBps(baseWallet.address);
      console.log(`  Hop 3 Callback TX: https://sepolia.basescan.org/tx/${callbackTxHash || "detected"} (${Date.now() - t0} ms total)`);
      console.log(`  Restored Health Factor: ${(Number(hfAfter) / 10000).toFixed(4)}x`);
      break;
    }
  }

  manifest.liveLoopProof = {
    recordedAt: new Date().toISOString(),
    originTx: originTx.hash,
    reactiveTx: reactiveTxHash,
    callbackTx: callbackTxHash,
    endToEndWallClockMs: Date.now() - t0,
  };
  fs.writeFileSync(livePath, JSON.stringify(manifest, null, 2));
  console.log("\nUpdated deployments/live.json with live 3-hop proof hashes!");
}

main().catch((err) => {
  console.error("Live loop trigger failed:", err.message);
  process.exit(1);
});
