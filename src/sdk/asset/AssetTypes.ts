// src/sdk/asset/AssetTypes.ts
// Asset type configurations — default PIL terms, pricing tier, and CDR vault type
// for each intelligence asset category in NEXAR.

import { parseEther, zeroAddress } from "viem";
import {
  AssetTier,
  BASE_PRICES,
  STORY_CONTRACTS,
  TOKENS,
  MAX_COMPUTE_UNITS,
} from "../../core/config.js";

export interface AssetTypeConfig {
  tier:           AssetTier;
  label:          string;
  mediaType:      string;
  vaultType:      "secret" | "file";
  maxSecretBytes: number;
  defaultPIL: {
    commercialUse:         boolean;
    commercialRevShare:    number;   // plain 0-100 percentage (Story SDK expects this)
    derivativesAllowed:    boolean;
    derivativesReciprocal: boolean;
    transferable:          boolean;
    defaultMintingFee:     bigint;
    currency:              `0x${string}`;
    royaltyPolicy:         `0x${string}`;
  };
  defaultBasePrice: string;
  maxComputeUnits:  number;
}

export const ASSET_TYPE_CONFIGS: Record<AssetTier, AssetTypeConfig> = {

  [AssetTier.DATASET]: {
    tier:           AssetTier.DATASET,
    label:          "dataset",
    mediaType:      "application/octet-stream",
    vaultType:      "file",
    maxSecretBytes: 1024,
    defaultPIL: {
      commercialUse:         true,
      commercialRevShare:    15,    // 15%
      derivativesAllowed:    true,
      derivativesReciprocal: true,
      transferable:          true,
      defaultMintingFee:     parseEther(BASE_PRICES.DATASET),
      currency:              TOKENS.WIP,
      royaltyPolicy:         STORY_CONTRACTS.RoyaltyPolicyLAP as `0x${string}`,
    },
    defaultBasePrice: BASE_PRICES.DATASET,
    maxComputeUnits:  MAX_COMPUTE_UNITS,
  },

  [AssetTier.MODEL]: {
    tier:           AssetTier.MODEL,
    label:          "model",
    mediaType:      "application/octet-stream",
    vaultType:      "file",
    maxSecretBytes: 1024,
    defaultPIL: {
      commercialUse:         true,
      commercialRevShare:    20,    // 20%
      derivativesAllowed:    true,
      derivativesReciprocal: true,
      transferable:          true,
      defaultMintingFee:     parseEther(BASE_PRICES.MODEL),
      currency:              TOKENS.WIP,
      royaltyPolicy:         STORY_CONTRACTS.RoyaltyPolicyLAP as `0x${string}`,
    },
    defaultBasePrice: BASE_PRICES.MODEL,
    maxComputeUnits:  MAX_COMPUTE_UNITS,
  },

  [AssetTier.STRATEGY]: {
    tier:           AssetTier.STRATEGY,
    label:          "strategy",
    mediaType:      "text/plain",
    vaultType:      "secret",
    maxSecretBytes: 1024,
    defaultPIL: {
      commercialUse:         true,
      commercialRevShare:    10,    // 10%
      derivativesAllowed:    true,
      derivativesReciprocal: true,
      transferable:          true,
      defaultMintingFee:     parseEther(BASE_PRICES.STRATEGY),
      currency:              TOKENS.WIP,
      royaltyPolicy:         STORY_CONTRACTS.RoyaltyPolicyLAP as `0x${string}`,
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
      commercialRevShare:    5,     // 5%
      derivativesAllowed:    false, // inference only — outputs only, no derivatives
      derivativesReciprocal: false,
      transferable:          false, // non-transferable inference license
      defaultMintingFee:     parseEther(BASE_PRICES.INFERENCE),
      currency:              TOKENS.WIP,
      royaltyPolicy:         STORY_CONTRACTS.RoyaltyPolicyLAP as `0x${string}`,
    },
    defaultBasePrice: BASE_PRICES.INFERENCE,
    maxComputeUnits:  MAX_COMPUTE_UNITS,
  },

  [AssetTier.PROMPT]: {
    tier:           AssetTier.PROMPT,
    label:          "prompt",
    mediaType:      "text/plain",
    vaultType:      "secret",
    maxSecretBytes: 1024,
    defaultPIL: {
      commercialUse:         true,
      commercialRevShare:    8,     // 8%
      derivativesAllowed:    true,
      derivativesReciprocal: true,
      transferable:          true,
      defaultMintingFee:     parseEther(BASE_PRICES.PROMPT),
      currency:              TOKENS.WIP,
      royaltyPolicy:         STORY_CONTRACTS.RoyaltyPolicyLAP as `0x${string}`,
    },
    defaultBasePrice: BASE_PRICES.PROMPT,
    maxComputeUnits:  MAX_COMPUTE_UNITS,
  },
};

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
