// src/core/config.ts
// Single source of truth for all addresses, constants, and configuration.
// Every module imports from here — never hardcode addresses elsewhere.

import "dotenv/config";

// ─── Network ─────────────────────────────────────────────────────────────────

export const NETWORK = {
  chainId:    1315,
  name:       "Aeneid Testnet",
  rpc:        process.env.RPC_URL        || "https://aeneid.storyrpc.io",
  cdrApiUrl:  process.env.CDR_API_URL    || "http://172.192.41.96:1317",
  explorer:   "https://aeneid.storyscan.io",
  ipExplorer: "https://aeneid.explorer.story.foundation",
  faucet:     "https://aeneid.faucet.story.foundation",
} as const;

// ─── Story Protocol Core (Aeneid) ────────────────────────────────────────────

export const STORY_CONTRACTS = {
  IPAssetRegistry:     "0x77319B4031e6eF1250907aa00018B8B1c67a244b",
  LicensingModule:     "0x04fbd8a2e56dd85CFD5500A4A4DfA955B9f1dE6f",
  LicenseToken:        "0xFe3838BFb30B34170F00030B52eA4893d8aAC6bC",
  PILicenseTemplate:   "0x2E896b0b2Fdb7457499B56AAaA4AE55BCB4Cd316",
  RoyaltyModule:       "0xD2f60c40fEbccf6311f8B47c4f2Ec6b040400086",
  RoyaltyPolicyLAP:    "0xBe54FB168b3c982b7AaE60dB6CF75Bd8447b390E",
  RoyaltyPolicyLRP:    "0x9156e603C949481883B1d3355c6f1132D191fC41",
  GroupingModule:      "0x69D3a7aa9edb72Bc226E745A7cCdd50D947b69Ac",
  EvenSplitGroupPool:  "0xf96f2c30b41Cb6e0290de43C8528ae83d4f33F89",
  AccessController:    "0xcCF37d0a503Ee1D4C11208672e622ed3DFB2275a",
  DisputeModule:       "0x9b7A9c70AFF961C799110954fc06F3093aeb94C5",
  LicenseRegistry:     "0x529a750E02d8E2f15649c13D69a465286a780e24",
  ModuleRegistry:      "0x022DBAAeA5D8fB31a0Ad793335e39Ced5D631fa5",
  CoreMetadataModule:  "0x6E81a25C99C6e8430aeC7353325EB138aFE5DC16",
} as const;

// ─── SPG Periphery (Aeneid) ───────────────────────────────────────────────────

export const SPG_CONTRACTS = {
  RegistrationWorkflows:              "0xbe39E1C756e921BD25DF86e7AAa31106d1eb0424",
  LicenseAttachmentWorkflows:         "0xcC2E862bCee5B6036Db0de6E06Ae87e524a79fd8",
  DerivativeWorkflows:                "0x9e2d496f72C547C2C535B167e06ED8729B374a4f",
  GroupingWorkflows:                  "0xD7c0beb3aa4DCD4723465f1ecAd045676c24CDCd",
  RoyaltyWorkflows:                   "0x9515faE61E0c0447C6AC6dEe5628A2097aFE1890",
  RoyaltyTokenDistributionWorkflows:  "0xa38f42B8d33809917f23997B8423054aAB97322C",
} as const;

// ─── CDR Contracts (Aeneid) ───────────────────────────────────────────────────

export const CDR_CONTRACTS = {
  Core:               "0xCcCcCC0000000000000000000000000000000004",
  OwnerWriteCondition:"0x4C9bFC96d7092b590D497A191826C3dA2277c34B",
  LicenseReadCondition:"0xC0640AD4CF2CaA9914C8e5C44234359a9102f7a3",
} as const;

// ─── NEXAR Custom Contracts (set after deploy) ───────────────────────────────

export const NEXAR_CONTRACTS = {
  ReputationRegistry:       (process.env.REPUTATION_REGISTRY_ADDR  || "") as `0x${string}`,
  DynamicPricingHook:       (process.env.DYNAMIC_PRICING_HOOK_ADDR  || "") as `0x${string}`,
  InferenceAccessCondition: (process.env.INFERENCE_CONDITION_ADDR   || "") as `0x${string}`,
  TimedAccessCondition:     (process.env.TIMED_CONDITION_ADDR       || "") as `0x${string}`,
  NEXARRegistry:            (process.env.NEXAR_REGISTRY_ADDR        || "") as `0x${string}`,
} as const;

// ─── SPG NFT Collection ───────────────────────────────────────────────────────

export const NEXAR_SPG_NFT = (process.env.NEXAR_SPG_NFT_ADDR || "") as `0x${string}`;

// ─── Tokens ───────────────────────────────────────────────────────────────────

export const TOKENS = {
  WIP:    "0x1514000000000000000000000000000000000000" as `0x${string}`,
  MERC20: "0xF2104833d386a2734a4eB3B8ad6FC6812F29E38E" as `0x${string}`,
} as const;

// ─── Asset Tiers ──────────────────────────────────────────────────────────────
// Must match DynamicPricingHook.sol and NEXARRegistry.sol constants

export enum AssetTier {
  DATASET   = 0,
  MODEL     = 1,
  STRATEGY  = 2,
  INFERENCE = 3,
  PROMPT    = 4,
}

export const ASSET_TIER_LABELS: Record<AssetTier, string> = {
  [AssetTier.DATASET]:   "dataset",
  [AssetTier.MODEL]:     "model",
  [AssetTier.STRATEGY]:  "strategy",
  [AssetTier.INFERENCE]: "inference",
  [AssetTier.PROMPT]:    "prompt",
};

// ─── PIL Rev Share ────────────────────────────────────────────────────────────
// Story unit: 10_000_000 = 10%. Range: 0 – 100_000_000

export const REV_SHARE = {
  DATASET:   15_000_000, // 15%
  MODEL:     20_000_000, // 20%
  STRATEGY:  10_000_000, // 10%
  INFERENCE:  5_000_000, //  5%
  PROMPT:     8_000_000, //  8%
  POOL:      10_000_000, // 10% for group IPs
} as const;

// ─── Base Prices (WIP, as string for parseEther) ──────────────────────────────

export const BASE_PRICES = {
  DATASET:   "0.1",
  MODEL:     "0.5",
  STRATEGY:  "0.2",
  INFERENCE: "0.05",
  PROMPT:    "0.08",
} as const;

// ─── Compute Quota ────────────────────────────────────────────────────────────

export const MAX_COMPUTE_UNITS = 10; // per inference license

// ─── Session TTL defaults (seconds) ──────────────────────────────────────────

export const SESSION_TTL = {
  SHORT:  60 * 60 * 2,       //  2 hours
  MEDIUM: 60 * 60 * 48,      // 48 hours (film NDA use case)
  LONG:   60 * 60 * 24 * 30, // 30 days
} as const;

// ─── CDR timeouts ─────────────────────────────────────────────────────────────

export const CDR_TIMEOUT_MS = 120_000; // 2 minutes — recommended by docs

// ─── Misc ─────────────────────────────────────────────────────────────────────

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;

// Validate required env vars at startup
export function validateEnv(): void {
  const required = ["PRIVATE_KEY", "JWT_SECRET"];
  const missing  = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

// Validate NEXAR contracts are deployed (called after deploy step)
export function validateDeployedContracts(): void {
  const entries = Object.entries(NEXAR_CONTRACTS) as [string, string][];
  const missing = entries.filter(([, v]) => !v || v === "");
  if (missing.length > 0) {
    throw new Error(
      `NEXAR contracts not deployed yet. Missing: ${missing.map(([k]) => k).join(", ")}. Run: npm run deploy`
    );
  }
}
