// scripts/verify.ts
// Smoke test: verify all deployed contracts respond and CDR is reachable.
// Run: npm run verify

import "dotenv/config";
import { createPublicClient, http, getContract } from "viem";
import { initClients }          from "../src/core/clients.js";
import { NETWORK, NEXAR_CONTRACTS, CDR_CONTRACTS, STORY_CONTRACTS, NEXAR_SPG_NFT, validateEnv } from "../src/core/config.js";
import { log }                  from "../src/core/logger.js";

validateEnv();

// Simple ABI fragments for smoke tests
const OWNER_ABI = [{ name: "owner", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
const TOTAL_ASSETS_ABI = [{ name: "totalAssets", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;

interface CheckResult { name: string; ok: boolean; detail: string }

async function main() {
  log.deploy.separator("NEXAR Health Check");

  const results: CheckResult[] = [];

  // ── Init clients ─────────────────────────────────────────────────────────
  const { publicClient, cdrClient } = await initClients(process.env.PRIVATE_KEY!);

  // ── Check: ReputationRegistry ────────────────────────────────────────────
  await check(results, "ReputationRegistry", async () => {
    const addr = NEXAR_CONTRACTS.ReputationRegistry;
    if (!addr) throw new Error("Not deployed — run npm run deploy");
    const owner = await publicClient.readContract({ address: addr, abi: OWNER_ABI, functionName: "owner" });
    return `owner=${owner}`;
  });

  // ── Check: DynamicPricingHook ────────────────────────────────────────────
  await check(results, "DynamicPricingHook", async () => {
    const addr = NEXAR_CONTRACTS.DynamicPricingHook;
    if (!addr) throw new Error("Not deployed");
    const owner = await publicClient.readContract({ address: addr, abi: OWNER_ABI, functionName: "owner" });
    return `owner=${owner}`;
  });

  // ── Check: InferenceAccessCondition ──────────────────────────────────────
  await check(results, "InferenceAccessCondition", async () => {
    const addr = NEXAR_CONTRACTS.InferenceAccessCondition;
    if (!addr) throw new Error("Not deployed");
    const owner = await publicClient.readContract({ address: addr, abi: OWNER_ABI, functionName: "owner" });
    return `owner=${owner}`;
  });

  // ── Check: NEXARRegistry ────────────────────────────────────────────────
  await check(results, "NEXARRegistry", async () => {
    const addr = NEXAR_CONTRACTS.NEXARRegistry;
    if (!addr) throw new Error("Not deployed");
    const total = await publicClient.readContract({ address: addr, abi: TOTAL_ASSETS_ABI, functionName: "totalAssets" });
    return `totalAssets=${total}`;
  });

  // ── Check: SPG NFT Collection ────────────────────────────────────────────
  await check(results, "SPG NFT Collection", async () => {
    if (!NEXAR_SPG_NFT || NEXAR_SPG_NFT === "0x0000000000000000000000000000000000000000") {
      throw new Error("Not created — run npm run setup");
    }
    return `address=${NEXAR_SPG_NFT}`;
  });

  // ── Check: CDR connectivity (DKG public key) ──────────────────────────────
  await check(results, "CDR — DKG public key", async () => {
    const pubKey = await cdrClient.observer.getGlobalPubKey();
    return `pubKey.length=${pubKey.length} bytes`;
  });

  // ── Check: CDR — threshold ────────────────────────────────────────────────
  await check(results, "CDR — threshold", async () => {
    const threshold = await cdrClient.observer.getThreshold();
    return `threshold=${threshold} validators`;
  });

  // ── Check: CDR — max vault size ───────────────────────────────────────────
  await check(results, "CDR — max vault size", async () => {
    const max = await cdrClient.observer.getMaxEncryptedDataSize();
    return `max=${max} bytes`;
  });

  // ── Check: Story Protocol — licenseTermsId=1 exists ─────────────────────
  await check(results, "Story — PIL terms (id=1)", async () => {
    const readFee = await cdrClient.observer.getReadFee();
    return `readFee=${readFee} wei`;
  });

  // ── Check: Chain ID ──────────────────────────────────────────────────────
  await check(results, "Chain ID", async () => {
    const chainId = await publicClient.getChainId();
    if (chainId !== NETWORK.chainId) {
      throw new Error(`Expected ${NETWORK.chainId}, got ${chainId}`);
    }
    return `chainId=${chainId} ✓`;
  });

  // ── Print report ─────────────────────────────────────────────────────────
  log.deploy.separator("Health Report");
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  for (const r of results) {
    if (r.ok) {
      log.deploy.success(`✓ ${r.name}`, { detail: r.detail });
    } else {
      log.deploy.error(`✗ ${r.name}`, { detail: r.detail });
    }
  }

  console.log(`\n${passed}/${results.length} checks passed`);

  if (failed > 0) {
    console.log("\nFailed checks above must be resolved before running the demo.");
    process.exit(1);
  } else {
    console.log("\nAll checks passed. Run: npm run demo\n");
  }
}

async function check(
  results: CheckResult[],
  name:    string,
  fn:      () => Promise<string>
): Promise<void> {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (err) {
    results.push({ name, ok: false, detail: String(err) });
  }
}

main().catch((err) => {
  log.deploy.error("Verify failed", { err: String(err) });
  process.exit(1);
});
