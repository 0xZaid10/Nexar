// scripts/deploy.ts
// Deploy all NEXAR custom contracts to Story Aeneid testnet.
// Run: npm run deploy
//
// Deployment order (dependency-aware):
//   1. ReputationRegistry        (no deps)
//   2. DynamicPricingHook        (depends on ReputationRegistry)
//   3. InferenceAccessCondition  (no deps)
//   4. NEXARRegistry            (no deps)
//
// After deploy, addresses are printed — copy them into .env

import "dotenv/config";
import { ethers }                 from "ethers";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount }    from "viem/accounts";
import { log }                    from "../src/core/logger.js";
import { NETWORK, validateEnv }   from "../src/core/config.js";
import { writeFileSync }          from "node:fs";

validateEnv();

// ─── Provider + signer (ethers for Hardhat artifacts) ─────────────────────────

const provider = new ethers.JsonRpcProvider(NETWORK.rpc);
const signer   = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

// ─── Load compiled artifacts ──────────────────────────────────────────────────

async function loadArtifact(name: string) {
  const { default: artifact } = await import(
    `../artifacts/contracts/${name}.sol/${name}.json`,
    { assert: { type: "json" } }
  );
  return artifact;
}

// ─── Deploy a single contract ─────────────────────────────────────────────────

async function deploy(
  name:           string,
  constructorArgs:unknown[] = []
): Promise<string> {
  log.deploy.info(`Deploying ${name}...`, { args: constructorArgs.map(String).join(", ") });

  const artifact = await loadArtifact(name);
  const factory  = new ethers.ContractFactory(artifact.abi, artifact.bytecode, signer);
  const contract = await factory.deploy(...constructorArgs);

  await contract.waitForDeployment();

  const address = await contract.getAddress();
  log.deploy.success(`${name} deployed`, { address });
  return address;
}

// ─── Main deploy sequence ─────────────────────────────────────────────────────

async function main() {
  log.deploy.separator("NEXAR Contract Deployment");
  log.deploy.info("Network", { rpc: NETWORK.rpc, chainId: NETWORK.chainId.toString() });
  log.deploy.info("Deployer", { address: signer.address });

  // Check deployer balance
  const balance = await provider.getBalance(signer.address);
  log.deploy.info("Deployer balance", {
    ip: ethers.formatEther(balance) + " $IP",
  });
  if (balance < ethers.parseEther("0.1")) {
    throw new Error("Insufficient balance — fund deployer with at least 0.1 $IP from faucet");
  }

  // ── 1. ReputationRegistry ───────────────────────────────────────────────────
  const reputationRegistryAddr = await deploy("ReputationRegistry");

  // ── 2. DynamicPricingHook (depends on ReputationRegistry) ──────────────────
  const dynamicPricingHookAddr = await deploy("DynamicPricingHook", [reputationRegistryAddr]);

  // ── 3. InferenceAccessCondition ────────────────────────────────────────────
  const inferenceConditionAddr = await deploy("InferenceAccessCondition");

  // ── 4. NEXARRegistry ──────────────────────────────────────────────────────
  const nexarRegistryAddr = await deploy("NEXARRegistry");

  // ── 5. Authorize DynamicPricingHook in ReputationRegistry ──────────────────
  log.deploy.info("Authorizing DynamicPricingHook as recorder in ReputationRegistry...");
  const repArtifact  = await loadArtifact("ReputationRegistry");
  const repContract  = new ethers.Contract(reputationRegistryAddr, repArtifact.abi, signer);
  const authTx       = await repContract.setRecorder(dynamicPricingHookAddr, true);
  await authTx.wait();
  log.deploy.success("DynamicPricingHook authorized as recorder", { txHash: authTx.hash });

  // ── Summary ─────────────────────────────────────────────────────────────────
  const envBlock = `
# NEXAR Custom Contracts — deployed ${new Date().toISOString()}
REPUTATION_REGISTRY_ADDR=${reputationRegistryAddr}
DYNAMIC_PRICING_HOOK_ADDR=${dynamicPricingHookAddr}
INFERENCE_CONDITION_ADDR=${inferenceConditionAddr}
NEXAR_REGISTRY_ADDR=${nexarRegistryAddr}
`.trim();

  log.deploy.separator("Deployment Complete");
  log.deploy.success("All contracts deployed");
  console.log("\n" + envBlock + "\n");
  console.log("Copy the above lines into your .env file, then run: npm run setup");

  // Write to .env.deployed for convenience
  writeFileSync(".env.deployed", envBlock + "\n");
  log.deploy.info("Addresses saved to .env.deployed");

  return {
    ReputationRegistry:       reputationRegistryAddr,
    DynamicPricingHook:       dynamicPricingHookAddr,
    InferenceAccessCondition: inferenceConditionAddr,
    NEXARRegistry:           nexarRegistryAddr,
  };
}

main().catch((err) => {
  log.deploy.error("Deployment failed", { err: String(err) });
  process.exit(1);
});
