/**
 * Bridges Base Sepolia ETH -> Reactive Lasna lREACT via official ReactiveFaucetL1 contract
 * (0x2afaFD298b23b62760711756088F75B7409f5967, rate: 1 ETH -> 100 lREACT, max 5 ETH/tx).
 */
import "dotenv/config";
import { ethers } from "ethers";

const BASE_RPC = process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org";
const LASNA_RPC = process.env.REACTIVE_LASNA_RPC || "https://lasna-rpc.rnk.dev/";
const FAUCET_ADDR =
  process.env.BASE_SEPOLIA_LREACT_FAUCET || "0x2afaFD298b23b62760711756088F75B7409f5967";

const FAUCET_ABI = ["function request(address receiver) external payable"];

async function main() {
  const pk = process.env.DEPLOYER_PRIVATE_KEY || "";
  if (!pk.startsWith("0x") || pk.length !== 66) {
    throw new Error("Missing DEPLOYER_PRIVATE_KEY in .env. Run `npm run wallet:new` first.");
  }

  const amountEth = process.env.LREACT_BRIDGE_ETH || "0.02";
  if (Number(amountEth) <= 0 || Number(amountEth) > 1.0) {
    throw new Error("LREACT_BRIDGE_ETH must be between 0 and 1.0 ETH (well below Reactive 5 ETH cap).");
  }

  const baseProvider = new ethers.JsonRpcProvider(BASE_RPC);
  const lasnaProvider = new ethers.JsonRpcProvider(LASNA_RPC);
  const [baseNet, lasnaNet] = await Promise.all([
    baseProvider.getNetwork(),
    lasnaProvider.getNetwork(),
  ]);
  if (baseNet.chainId !== 84532n) {
    throw new Error(`Expected Base Sepolia chainId 84532, got ${baseNet.chainId}`);
  }
  if (lasnaNet.chainId !== 5318007n) {
    throw new Error(`Expected Reactive Lasna chainId 5318007, got ${lasnaNet.chainId}`);
  }
  const wallet = new ethers.Wallet(pk, baseProvider);

  const [baseBal, lasnaBefore] = await Promise.all([
    baseProvider.getBalance(wallet.address),
    lasnaProvider.getBalance(wallet.address),
  ]);

  const valueWei = ethers.parseEther(amountEth);
  console.log(`Deployer:         ${wallet.address}`);
  console.log(`Base Sepolia ETH: ${ethers.formatEther(baseBal)} ETH`);
  console.log(`Lasna lREACT:     ${ethers.formatEther(lasnaBefore)} lREACT`);

  if (baseBal < valueWei + ethers.parseEther("0.002")) {
    throw new Error(
      `Insufficient Base Sepolia ETH. Need at least ${(Number(amountEth) + 0.002).toFixed(4)} ETH; currently ${ethers.formatEther(baseBal)} ETH.`
    );
  }

  console.log(`Calling ReactiveFaucetL1.request(${wallet.address}) with ${amountEth} ETH (-> ${Number(amountEth) * 100} lREACT)...`);
  const faucet = new ethers.Contract(FAUCET_ADDR, FAUCET_ABI, wallet);
  const tx = await faucet.request(wallet.address, { value: valueWei });
  console.log(`Base Sepolia Bridge TX: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`Confirmed in block #${receipt.blockNumber}. Waiting for Lasna lREACT credit...`);

  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const nowBal = await lasnaProvider.getBalance(wallet.address);
    if (nowBal > lasnaBefore) {
      console.log(`SUCCESS! Lasna lREACT balance increased to ${ethers.formatEther(nowBal)} lREACT.`);
      return;
    }
  }

  console.log("Bridge TX confirmed on Base Sepolia. Check Lasna balance again shortly with `npm run status:live`.");
}

main().catch((err) => {
  console.error("Bridge failed:", err.message);
  process.exit(1);
});
