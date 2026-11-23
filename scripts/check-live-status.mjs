/**
 * Live RPC & Deployer Status Checker for Base Sepolia (84532) and Reactive Lasna (5318007).
 * Never prints private keys.
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
const SYSTEM_CONTRACT = "0x8888888888888888888888888888888888888888";
const BASE_CALLBACK_PROXY = "0x476F44b11F5C942c58f4c8E3d0300E5710743585";
const BASE_LREACT_FAUCET = "0x2afaFD298b23b62760711756088F75B7409f5967";

async function main() {
  const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);
  const lasnaProvider = new ethers.JsonRpcProvider(LASNA_RPC);

  const [baseNet, baseBlock, lasnaNet, lasnaBlock, sysCode, proxyCode, faucetCode] =
    await Promise.all([
      baseProvider.getNetwork(),
      baseProvider.getBlockNumber(),
      lasnaProvider.getNetwork(),
      lasnaProvider.getBlockNumber(),
      lasnaProvider.getCode(SYSTEM_CONTRACT),
      baseProvider.getCode(BASE_CALLBACK_PROXY),
      baseProvider.getCode(BASE_LREACT_FAUCET),
    ]);

  console.log("=== Reactive Omni Live Testnet Status ===");
  console.log(`Base Sepolia      chainId=${baseNet.chainId} block=#${baseBlock}`);
  console.log(`Reactive Lasna    chainId=${lasnaNet.chainId} block=#${lasnaBlock}`);
  console.log(`Lasna SYSTEM      ${SYSTEM_CONTRACT} bytecode=${sysCode.length > 2 ? "LIVE" : "MISSING"}`);
  console.log(`Base Proxy        ${BASE_CALLBACK_PROXY} bytecode=${proxyCode.length > 2 ? "LIVE" : "MISSING"}`);
  console.log(`Base lREACT Bridge ${BASE_LREACT_FAUCET} bytecode=${faucetCode.length > 2 ? "LIVE" : "MISSING"}`);

  const pk = process.env.DEPLOYER_PRIVATE_KEY || "";
  if (pk.startsWith("0x") && pk.length === 66) {
    const addr = new ethers.Wallet(pk).address;
    const [baseBal, lasnaBal] = await Promise.all([
      baseProvider.getBalance(addr),
      lasnaProvider.getBalance(addr),
    ]);
    console.log("\n=== Deployer Balances ===");
    console.log(`Deployer Address: ${addr}`);
    console.log(`Base Sepolia ETH: ${ethers.formatEther(baseBal)} ETH`);
    console.log(`Reactive lREACT:  ${ethers.formatEther(lasnaBal)} lREACT`);
  } else {
    console.log("\nNo deployer key configured in .env. Run `npm run wallet:new`.");
  }

  const depPath = path.join(rootDir, "deployments", "live.json");
  if (fs.existsSync(depPath)) {
    const dep = JSON.parse(fs.readFileSync(depPath, "utf8"));
    console.log("\n=== Recorded Deployment (deployments/live.json) ===");
    console.log(JSON.stringify(dep, null, 2));
  }
}

main().catch((err) => {
  console.error("Status check failed:", err.message);
  process.exit(1);
});
