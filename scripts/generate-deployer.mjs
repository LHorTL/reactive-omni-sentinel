/**
 * Generates a fresh deployer EOA and stores DEPLOYER_PRIVATE_KEY inside git-ignored `.env`.
 * SECURITY: Never prints any private key to stdout or logs.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const envPath = path.join(rootDir, ".env");
const examplePath = path.join(rootDir, ".env.example");

function main() {
  let content = fs.existsSync(envPath)
    ? fs.readFileSync(envPath, "utf8")
    : fs.readFileSync(examplePath, "utf8");

  const existingMatch = content.match(/^DEPLOYER_PRIVATE_KEY=(0x[a-fA-F0-9]{64})$/m);
  if (existingMatch) {
    const existingWallet = new ethers.Wallet(existingMatch[1]);
    console.log("Deployer already configured in .env (private key NOT printed).");
    console.log("Public Deployer Address:", existingWallet.address);
    return;
  }

  const wallet = ethers.Wallet.createRandom();
  if (/^DEPLOYER_PRIVATE_KEY=.*$/m.test(content)) {
    content = content.replace(/^DEPLOYER_PRIVATE_KEY=.*$/m, `DEPLOYER_PRIVATE_KEY=${wallet.privateKey}`);
  } else {
    content += `\nDEPLOYER_PRIVATE_KEY=${wallet.privateKey}\n`;
  }

  fs.writeFileSync(envPath, content, { encoding: "utf8", mode: 0o600 });
  console.log("Fresh deployer wallet generated and saved to git-ignored .env (private key redacted).");
  console.log("Public Deployer Address:", wallet.address);
  console.log("\nNext steps to go live on Base Sepolia (84532) + Reactive Lasna (5318007):");
  console.log("  1. Fund this address with ~0.05 Base Sepolia ETH from a public faucet:");
  console.log("     - Coinbase CDP Faucet: https://portal.cdp.coinbase.com/products/faucet");
  console.log("     - Alchemy Base Sepolia Faucet: https://www.alchemy.com/faucets/base-sepolia");
  console.log("     - QuickNode Faucet: https://faucet.quicknode.com/base/sepolia");
  console.log("  2. Bridge 0.02 Base Sepolia ETH -> 2.0 Lasna lREACT automatically:");
  console.log("     npm run faucet:bridge");
  console.log("  3. Deploy OmniGuardReactive (Lasna) + OriginPriceVault (Base Sepolia) & subscribe:");
  console.log("     npm run deploy:live");
  console.log("  4. Trigger & record the real 3-hop Origin -> Reactive -> Callback TX loop:");
  console.log("     npm run trigger:live");
}

main();
