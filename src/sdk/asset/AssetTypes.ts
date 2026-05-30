// src/sdk/asset/AssetTypes.ts
// Asset type configurations — default PIL terms, pricing tier, and CDR vault type
// for each intelligence asset category in NEXAR.

import { parseEther, zeroAddress } from "viem";
import {
  AssetTier,
  REV_SHARE,
  BASE_PRICES,
  STORY_CONTRACTS,
  TOKENS,
  MAX_COMPUTE_UNITS,
} from "../../core/config.js";

// ─── Asset type config ────────────────────────────────────────────────────────

export interface AssetTypeConfig {
  tier:         AssetTier;
  label:        string;         // human-readable
  mediaType:    string;         // MIME type for SAS
  vaultType:    "secret" | "file"; // on-chain secret vs IPFS file
  maxSecretBytes: number;       // max bytes if vaultType=secret (CDR limit: 1024)
  defaultPIL: {
    commercialUse:         boolean;
    commercialRevShare:    number;  // Story units (e.g. 15_000_000 = 15%)
    derivativesAllowed:    boolean;
    derivativesReciprocal: boolean;
    transferable:          boolean;
    defaultMintingFee:     bigint;  // in WIP (18 decimals)
    currency:              `0x${string}`;
    royaltyPolicy:         `0x${string}`;
  };
  defaultBasePrice: string;     // WIP string for DynamicPricingHook
  inferenceTermsId?: bigint;    // set after deployment for INFERENCE tier
  maxComputeUnits:  number;
}

// ─── Configurations per tier ──────────────────────────────────────────────────

export const ASSET_TYPE_CONFIGS: Record<AssetTier, AssetTypeConfig> = {

  [AssetTier.DATASET]: {
    tier:           AssetTier.DATASET,
    label:          "dataset",
    mediaType:      "application/octet-stream",
    vaultType:      "file",       // datasets are large — always file vault
    maxSecretBytes: 1024,
    defaultPIL: {
      commercialUse:         true,
      commercialRevShare:    REV_SHARE.DATASET,   // 15_000_000 = 15%
      derivativesAllowed:    true,
      derivativesReciprocal: true,
      transferable:          true,
      defaultMintingFee:     parseEther(BASE_PRICES.DATASET),
      currency:              TOKENS.WIP,
      royaltyPolicy:         STORY_CONTRACTS.RoyaltyPolicyLAP,
    },
    defaultBasePrice: BASE_PRICES.DATASET,
    maxComputeUnits:  MAX_COMPUTE_UNITS,
  },

  [AssetTier.MODEL]: {
    tier:           AssetTier.MODEL,
    label:          "model",
    mediaType:      "application/octet-stream",
    vaultType:      "file",       // model weights are large — always file vault
    maxSecretBytes: 1024,
    defaultPIL: {
      commercialUse:         true,
      commercialRevShare:    REV_SHARE.MODEL,     // 20_000_000 = 20%
      derivativesAllowed:    true,
      derivativesReciprocal: true,
      transferable:          true,
      defaultMintingFee:     parseEther(BASE_PRICES.MODEL),
      currency:              TOKENS.WIP,
      royaltyPolicy:         STORY_CONTRACTS.RoyaltyPolicyLAP,
    },
    defaultBasePrice: BASE_PRICES.MODEL,
    maxComputeUnits:  MAX_COMPUTE_UNITS,
  },

  [AssetTier.STRATEGY]: {
    tier:           AssetTier.STRATEGY,
    label:          "strategy",
    mediaType:      "text/plain",
    vaultType:      "secret",     // strategies are small (<1KB) — on-chain vault
    maxSecretBytes: 1024,
    defaultPIL: {
      commercialUse:         true,
      commercialRevShare:    REV_SHARE.STRATEGY,  // 10_000_000 = 10%
      derivativesAllowed:    true,
      derivativesReciprocal: true,
      transferable:          true,
      defaultMintingFee:     parseEther(BASE_PRICES.STRATEGY),
      currency:              TOKENS.WIP,
      royaltyPolicy:         STORY_CONTRACTS.RoyaltyPolicyLAP,
    },
    defaultBasePrice: BASE_PRICES.STRATEGY,
    maxComputeUnits:  MAX_COMPUTE_UNITS,
  },

  [AssetTier.INFERENCE]: {
    tier:           AssetTier.INFERENCE,
    label:          "inference",
    mediaType:      "application/octet-stream",
    vaultType:      "file",
    maxSecretBytes: 1024,
    defaultPIL: {
      commercialUse:         true,
      commercialRevShare:    REV_SHARE.INFERENCE, // 5_000_000 = 5%
      derivativesAllowed:    false,               // inference = outputs only
      derivativesReciprocal: false,
      transferable:          false,               // non-transferable inference license
      defaultMintingFee:     parseEther(BASE_PRICES.INFERENCE),
      currency:              TOKENS.WIP,
      royaltyPolicy:         STORY_CONTRACTS.RoyaltyPolicyLAP,
    },
    defaultBasePrice: BASE_PRICES.INFERENCE,
    maxComputeUnits:  MAX_COMPUTE_UNITS,
  },

  [AssetTier.PROMPT]: {
    tier:           AssetTier.PROMPT,
    label:          "prompt",
    mediaType:      "text/plain",
    vaultType:      "secret",     // prompts are small (<1KB)
    maxSecretBytes: 1024,
    defaultPIL: {
      commercialUse:         true,
      commercialRevShare:    REV_SHARE.PROMPT,    // 8_000_000 = 8%
      derivativesAllowed:    true,
      derivativesReciprocal: true,
      transferable:          true,
      defaultMintingFee:     parseEther(BASE_PRICES.PROMPT),
      currency:              TOKENS.WIP,
      royaltyPolicy:         STORY_CONTRACTS.RoyaltyPolicyLAP,
    },
    defaultBasePrice: BASE_PRICES.PROMPT,
    maxComputeUnits:  MAX_COMPUTE_UNITS,
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function getAssetTypeConfig(tier: AssetTier): AssetTypeConfig {
  const config = ASSET_TYPE_CONFIGS[tier];
  if (!config) throw new Error(`Unknown asset tier: ${tier}`);
  return config;
}

export function isFileVault(tier: AssetTier): boolean {
  return ASSET_TYPE_CONFIGS[tier].vaultType === "file";
}

export function isSecretVault(tier: AssetTier): boolean {
  return ASSET_TYPE_CONFIGS[tier].vaultType === "secret";
}
