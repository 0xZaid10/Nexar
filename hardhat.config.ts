import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-ethers";
import dotenv from "dotenv";

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.warn("⚠️  PRIVATE_KEY not set in .env — deploy tasks will fail");
}

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: {
        enabled: true,
        runs: 20000,
      },
      viaIR: true,
    },
  },

  networks: {
    // Story Aeneid Testnet — Chain ID 1315
    aeneid: {
      url:      process.env.RPC_URL || "https://aeneid.storyrpc.io",
      chainId:  1315,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      gas:      "auto",
      gasPrice: "auto",
    },

    // Story Mainnet — Chain ID 1514
    mainnet: {
      url:      "https://mainnet.storyrpc.io",
      chainId:  1514,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
      gas:      "auto",
      gasPrice: "auto",
    },

    // Local hardhat network for unit tests
    hardhat: {
      chainId: 31337,
    },
  },

  // Contract artifacts output dir
  paths: {
    sources:   "./contracts",
    tests:     "./test",
    cache:     "./cache",
    artifacts: "./artifacts",
  },

  // Typechain — generates TypeScript types for all contracts
  typechain: {
    outDir: "./typechain-types",
    target: "ethers-v6",
  },

  // Etherscan-compatible block explorer for Story (Blockscout)
  etherscan: {
    apiKey: {
      aeneid:  "placeholder", // Blockscout does not require a real key
      mainnet: "placeholder",
    },
    customChains: [
      {
        network:  "aeneid",
        chainId:  1315,
        urls: {
          apiURL:     "https://aeneid.storyscan.io/api",
          browserURL: "https://aeneid.storyscan.io",
        },
      },
      {
        network:  "mainnet",
        chainId:  1514,
        urls: {
          apiURL:     "https://www.storyscan.io/api",
          browserURL: "https://www.storyscan.io",
        },
      },
    ],
  },
};

export default config;
