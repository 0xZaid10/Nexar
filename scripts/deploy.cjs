// scripts/deploy.cjs
// Deploy all NEXAR custom contracts to Story Aeneid testnet.
// Run: node scripts/deploy.cjs
// Plain CJS — no TypeScript loader needed.

require("dotenv").config();
const { ethers } = require("ethers");
const fs         = require("fs");
const path       = require("path");

const RPC_URL    = process.env.RPC_URL    || "https://aeneid.storyrpc.io";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error("ERROR: PRIVATE_KEY not set in .env");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer   = new ethers.Wallet(`0x${PRIVATE_KEY.replace(/^0x/, "")}`, provider);

function loadArtifact(contractName) {
  const p = path.join(__dirname, "..", "artifacts", "contracts",
    `${contractName}.sol`, `${contractName}.json`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function deploy(name, args = []) {
  console.log(`\nDeploying ${name}...`);
  const artifact = loadArtifact(name);
  const factory  = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  const address  = await contract.getAddress();
  console.log(`✔  ${name}: ${address}`);
  return address;
}

async function main() {
  console.log("══════════════════════════════════════════");
  console.log("  NEXAR Contract Deployment — Aeneid");
  console.log("══════════════════════════════════════════");
  console.log(`RPC:      ${RPC_URL}`);
  console.log(`Deployer: ${signer.address}`);

  const balance = await provider.getBalance(signer.address);
  console.log(`Balance:  ${ethers.formatEther(balance)} $IP`);

  if (balance < ethers.parseEther("0.1")) {
    console.error("ERROR: Need at least 0.1 $IP to deploy");
    process.exit(1);
  }

  // 1. ReputationRegistry
  const reputationRegistry = await deploy("ReputationRegistry");

  // 2. DynamicPricingHook (needs ReputationRegistry address)
  const dynamicPricingHook = await deploy("DynamicPricingHook", [reputationRegistry]);

  // 3. InferenceAccessCondition
  const inferenceCondition = await deploy("InferenceAccessCondition");

  // 4. NEXARRegistry
  const nexarRegistry = await deploy("NEXARRegistry");

  // 5. TimedAccessCondition
  const timedCondition = await deploy("TimedAccessCondition");

  // 5. Authorize DynamicPricingHook as recorder in ReputationRegistry
  console.log("\nAuthorizing DynamicPricingHook as recorder...");
  const repArtifact = loadArtifact("ReputationRegistry");
  const repContract = new ethers.Contract(reputationRegistry, repArtifact.abi, signer);
  const tx = await repContract.setRecorder(dynamicPricingHook, true);
  await tx.wait();
  console.log(`✔  DynamicPricingHook authorized — tx: ${tx.hash}`);

  // Print .env block
  const envBlock = `
# NEXAR Deployed Contracts — ${new Date().toISOString()}
REPUTATION_REGISTRY_ADDR=${reputationRegistry}
DYNAMIC_PRICING_HOOK_ADDR=${dynamicPricingHook}
INFERENCE_CONDITION_ADDR=${inferenceCondition}
NEXAR_REGISTRY_ADDR=${nexarRegistry}
TIMED_CONDITION_ADDR=${timedCondition}
`.trim();

  console.log("\n══════════════════════════════════════════");
  console.log("  Deployment Complete — copy into .env:");
  console.log("══════════════════════════════════════════");
  console.log(envBlock);

  fs.writeFileSync(".env.deployed", envBlock + "\n");
  console.log("\n✔  Addresses saved to .env.deployed");
  console.log("Next: add them to .env then run: node scripts/setup.cjs");
}

main().catch((err) => {
  console.error("\nDeployment failed:", err.message || err);
  process.exit(1);
});
