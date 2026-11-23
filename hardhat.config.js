require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";
const accounts = PRIVATE_KEY && PRIVATE_KEY.startsWith("0x") && PRIVATE_KEY.length === 66 ? [PRIVATE_KEY] : [];

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.29",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    baseSepolia: {
      url: process.env.BASE_SEPOLIA_RPC || "https://sepolia.base.org",
      chainId: 84532,
      accounts,
    },
    unichainSepolia: {
      url: process.env.UNICHAIN_SEPOLIA_RPC || "https://sepolia.unichain.org",
      chainId: 1301,
      accounts,
    },
    ethereumSepolia: {
      url: process.env.ETHEREUM_SEPOLIA_RPC || "https://ethereum-sepolia-rpc.publicnode.com",
      chainId: 11155111,
      accounts,
    },
    reactiveLasna: {
      url: process.env.REACTIVE_LASNA_RPC || "https://lasna-rpc.rnk.dev/",
      chainId: 5318007,
      accounts,
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};
