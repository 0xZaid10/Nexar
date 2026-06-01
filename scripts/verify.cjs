// scripts/verify.cjs
// Smoke test all deployed contracts + CDR connectivity.
// Run: node scripts/verify.cjs

require("dotenv").config();
const { createPublicClient, http } = require("viem");
const { privateKeyToAccount }      = require("viem/accounts");
const { CDRClient, initWasm }      = require("@piplabs/cdr-sdk");

const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!PRIVATE_KEY) { console.error("PRIVATE_KEY not set"); process.exit(1); }

const RPC_URL    = process.env.RPC_URL    || "https://aeneid.storyrpc.io";
const CDR_API    = process.env.CDR_API_URL || "http://172.192.41.96:1317";

const OWNER_ABI = [{ name:"owner", type:"function", stateMutability:"view", inputs:[], outputs:[{type:"address"}] }];
const TOTAL_ABI = [{ name:"totalAssets", type:"function", stateMutability:"view", inputs:[], outputs:[{type:"uint256"}] }];

const CONTRACTS = {
  ReputationRegistry:       process.env.REPUTATION_REGISTRY_ADDR,
  DynamicPricingHook:       process.env.DYNAMIC_PRICING_HOOK_ADDR,
  InferenceAccessCondition: process.env.INFERENCE_CONDITION_ADDR,
  TimedAccessCondition:     process.env.TIMED_CONDITION_ADDR,
  NEXARRegistry:            process.env.NEXAR_REGISTRY_ADDR,
};

const SPG_NFT = process.env.NEXAR_SPG_NFT_ADDR;

async function check(name, fn) {
  try {
    const detail = await fn();
    console.log(`  ✔  ${name.padEnd(32)} ${detail}`);
    return true;
  } catch (err) {
    console.log(`  ✗  ${name.padEnd(32)} ${err.message?.slice(0,60) ?? err}`);
    return false;
  }
}

async function main() {
  console.log("══════════════════════════════════════════");
  console.log("  NEXAR Health Check — Aeneid");
  console.log("══════════════════════════════════════════\n");

  const account      = privateKeyToAccount(`0x${PRIVATE_KEY.replace(/^0x/,"")}`);
  const publicClient = createPublicClient({ transport: http(RPC_URL) });

  await initWasm();
  const cdrClient = new CDRClient({ network:"testnet", publicClient, apiUrl: CDR_API });

  let passed = 0, total = 0;

  const run = async (name, fn) => {
    total++;
    if (await check(name, fn)) passed++;
  };

  // Chain
  await run("Chain ID", async () => {
    const id = await publicClient.getChainId();
    if (id !== 1315) throw new Error(`Expected 1315, got ${id}`);
    return `${id} ✓`;
  });

  // Contracts
  for (const [name, addr] of Object.entries(CONTRACTS)) {
    await run(name, async () => {
      if (!addr || addr === "0x0000000000000000000000000000000000000000")
        throw new Error("Not deployed — run node scripts/deploy.cjs");
      if (name === "NEXARRegistry") {
        const total = await publicClient.readContract({ address: addr, abi: TOTAL_ABI, functionName:"totalAssets" });
        return `totalAssets=${total}`;
      }
      const owner = await publicClient.readContract({ address: addr, abi: OWNER_ABI, functionName:"owner" });
      return `owner=${owner.slice(0,10)}...`;
    });
  }

  // SPG NFT
  await run("SPG NFT Collection", async () => {
    if (!SPG_NFT || SPG_NFT === "0x0000000000000000000000000000000000000000")
      throw new Error("Not created — run node scripts/setup.cjs");
    return SPG_NFT.slice(0,10) + "...";
  });

  // CDR
  await run("CDR — DKG public key", async () => {
    const key = await cdrClient.observer.getGlobalPubKey();
    return `${key.length} bytes`;
  });

  await run("CDR — threshold", async () => {
    const t = await cdrClient.observer.getThreshold();
    return `${t} validators`;
  });

  await run("CDR — max vault size", async () => {
    const m = await cdrClient.observer.getMaxEncryptedDataSize();
    return `${m} bytes`;
  });

  await run("CDR — read fee", async () => {
    const f = await cdrClient.observer.getReadFee();
    return `${f} wei`;
  });

  console.log(`\n  ${passed}/${total} checks passed`);
  console.log("══════════════════════════════════════════");

  if (passed < total) {
    console.log("  Fix failing checks before running demo.");
    process.exit(1);
  } else {
    console.log("  All good. Run: node demo/run.cjs");
  }
}

main().catch((err) => {
  console.error("Verify failed:", err.message || err);
  process.exit(1);
});
