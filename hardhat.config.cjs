// hardhat.config.cjs
require("dotenv").config();
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");

const PRIVATE_KEY = process.env.PRIVATE_KEY;

/** @type {import('hardhat/config').HardhatUserConfig} */
module.exports = {
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: { enabled: true, runs: 20000 },
      viaIR: true,
    },
  },

  networks: {
    aeneid: {
      url:      process.env.RPC_URL || "https://aeneid.storyrpc.io",
      chainId:  1315,
      accounts: PRIVATE_KEY ? [`0x${PRIVATE_KEY.replace(/^0x/, "")}`] : [],
    },
    mainnet: {
      url:      "https://mainnet.storyrpc.io",
      chainId:  1514,
      accounts: PRIVATE_KEY ? [`0x${PRIVATE_KEY.replace(/^0x/, "")}`] : [],
    },
    hardhat: { chainId: 31337 },
  },

  paths: {
    sources:   "./contracts",
    tests:     "./test/contracts",
    cache:     "./cache",
    artifacts: "./artifacts",
  },
};
