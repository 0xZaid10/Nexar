// src/licensing/PILBuilder.ts
// Build and validate PIL (Programmable IP License) terms.
// Provides preset flavors matching PIL Flavors from:
//   concepts/programmable-ip-license/pil-flavors.md
// All field names confirmed from sdk-reference/license.md LicenseTerms type.

import { parseEther, zeroAddress } from "viem";
import { STORY_CONTRACTS, TOKENS } from "../core/config.js";
import { NexarError }             from "../core/errors.js";
import type { PILConfig }          from "../core/types.js";

// ─── LicenseTerms type (mirrors Story SDK LicenseTerms) ──────────────────────

export interface LicenseTerms {
  transferable:              boolean;
  royaltyPolicy:             `0x${string}`;
  defaultMintingFee:         bigint;
  expiration:                bigint;
  commercialUse:             boolean;
  commercialAttribution:     boolean;
  commercializerChecker:     `0x${string}`;
  commercializerCheckerData: `0x${string}`;
  commercialRevShare:        number;       // Story units: 10_000_000 = 10%
  commercialRevCeiling:      bigint;
  derivativesAllowed:        boolean;
  derivativesAttribution:    boolean;
  derivativesApproval:       boolean;
  derivativesReciprocal:     boolean;
  derivativeRevCeiling:      bigint;
  currency:                  `0x${string}`;
  uri:                       string;
}

export interface LicensingConfig {
  isSet:              boolean;
  mintingFee:         bigint;
  licensingHook:      `0x${string}`;
  hookData:           `0x${string}`;
  commercialRevShare: number;
  disabled:           boolean;
  expectMinimumGroupRewardShare: number;
  expectGroupRewardPool:         `0x${string}`;
}

// ─── PIL term conversion helpers ──────────────────────────────────────────────

/**
 * Convert percentage (0–100) to Story rev share units (0–100_000_000).
 * e.g. 15 → 15_000_000
 */
export function pctToStoryUnits(pct: number): number {
  if (pct < 0 || pct > 100) {
    throw new NexarError("INVALID_PARAMS", `Rev share must be 0–100, got ${pct}`);
  }
  return Math.round(pct * 1_000_000);
}

/**
 * Convert Story rev share units back to percentage.
 * e.g. 15_000_000 → 15
 */
export function storyUnitsToPct(units: number): number {
  return units / 1_000_000;
}

// ─── PILBuilder ───────────────────────────────────────────────────────────────

export class PILBuilder {

  /**
   * Build full LicenseTerms from a PILConfig.
   * Confirmed field names from sdk-reference/license.md LicenseTerms type.
   */
  build(config: PILConfig): LicenseTerms {
    this.validate(config);

    return {
      transferable:              config.transferable,
      royaltyPolicy:             config.commercial
        ? STORY_CONTRACTS.RoyaltyPolicyLAP
        : zeroAddress as `0x${string}`,
      defaultMintingFee:         parseEther(config.mintingFee),
      expiration:                config.expiration ?? 0n,
      commercialUse:             config.commercial,
      commercialAttribution:     config.commercial,
      commercializerChecker:     zeroAddress as `0x${string}`,
      commercializerCheckerData: "0x",
      commercialRevShare:        pctToStoryUnits(config.revShare),
      commercialRevCeiling:      0n,
      derivativesAllowed:        config.derivatives,
      derivativesAttribution:    config.derivatives,
      derivativesApproval:       false,
      derivativesReciprocal:     config.derivatives,
      derivativeRevCeiling:      0n,
      currency:                  TOKENS.WIP,
      uri:                       "",
    };
  }

  // ─── PIL Flavors (from concepts/programmable-ip-license/pil-flavors.md) ────

  /**
   * Non-Commercial Social Remixing (licenseTermsId = 1 on-chain).
   * Free remixing with attribution. No commercialization.
   */
  nonCommercial(): LicenseTerms {
    return {
      transferable:              true,
      royaltyPolicy:             zeroAddress as `0x${string}`,
      defaultMintingFee:         0n,
      expiration:                0n,
      commercialUse:             false,
      commercialAttribution:     false,
      commercializerChecker:     zeroAddress as `0x${string}`,
      commercializerCheckerData: "0x",
      commercialRevShare:        0,
      commercialRevCeiling:      0n,
      derivativesAllowed:        true,
      derivativesAttribution:    true,
      derivativesApproval:       false,
      derivativesReciprocal:     true,
      derivativeRevCeiling:      0n,
      currency:                  zeroAddress as `0x${string}`,
      uri:                       "",
    };
  }

  /**
   * Commercial Use — pay to use, attribution required, no remixing.
   * @param mintingFeePct  - Minting fee as WIP string e.g. "0.1"
   * @param revSharePct    - Revenue share percentage (0–100)
   */
  commercialUse(mintingFee: string, revSharePct: number = 0): LicenseTerms {
    return {
      transferable:              true,
      royaltyPolicy:             STORY_CONTRACTS.RoyaltyPolicyLAP,
      defaultMintingFee:         parseEther(mintingFee),
      expiration:                0n,
      commercialUse:             true,
      commercialAttribution:     true,
      commercializerChecker:     zeroAddress as `0x${string}`,
      commercializerCheckerData: "0x",
      commercialRevShare:        pctToStoryUnits(revSharePct),
      commercialRevCeiling:      0n,
      derivativesAllowed:        false,
      derivativesAttribution:    false,
      derivativesApproval:       false,
      derivativesReciprocal:     false,
      derivativeRevCeiling:      0n,
      currency:                  TOKENS.WIP,
      uri:                       "",
    };
  }

  /**
   * Commercial Remix — pay to use + create remixes, share revenue upstream.
   * This is the primary NEXAR license flavor for datasets, models, strategies.
   * @param mintingFee   - WIP string e.g. "0.1"
   * @param revSharePct  - Revenue share percentage (0–100)
   */
  commercialRemix(mintingFee: string, revSharePct: number): LicenseTerms {
    return {
      transferable:              true,
      royaltyPolicy:             STORY_CONTRACTS.RoyaltyPolicyLAP,
      defaultMintingFee:         parseEther(mintingFee),
      expiration:                0n,
      commercialUse:             true,
      commercialAttribution:     true,
      commercializerChecker:     zeroAddress as `0x${string}`,
      commercializerCheckerData: "0x",
      commercialRevShare:        pctToStoryUnits(revSharePct),
      commercialRevCeiling:      0n,
      derivativesAllowed:        true,
      derivativesAttribution:    true,
      derivativesApproval:       false,
      derivativesReciprocal:     true,
      derivativeRevCeiling:      0n,
      currency:                  TOKENS.WIP,
      uri:                       "",
    };
  }

  /**
   * Inference-only license — commercial, non-transferable, no derivatives.
   * Used for inference vault access: users get outputs, not data.
   */
  inferenceOnly(mintingFee: string, revSharePct: number = 5): LicenseTerms {
    return {
      transferable:              false,   // non-transferable inference license
      royaltyPolicy:             STORY_CONTRACTS.RoyaltyPolicyLAP,
      defaultMintingFee:         parseEther(mintingFee),
      expiration:                0n,
      commercialUse:             true,
      commercialAttribution:     true,
      commercializerChecker:     zeroAddress as `0x${string}`,
      commercializerCheckerData: "0x",
      commercialRevShare:        pctToStoryUnits(revSharePct),
      commercialRevCeiling:      0n,
      derivativesAllowed:        false,   // no derivatives from inference outputs
      derivativesAttribution:    false,
      derivativesApproval:       false,
      derivativesReciprocal:     false,
      derivativeRevCeiling:      0n,
      currency:                  TOKENS.WIP,
      uri:                       "",
    };
  }

  // ─── LicensingConfig builder ──────────────────────────────────────────────

  /**
   * Build a LicensingConfig that points at the DynamicPricingHook.
   * Confirmed from sdk-reference/license.md setLicensingConfig params.
   */
  buildLicensingConfig(params: {
    hookAddress:   `0x${string}`;
    mintingFee:    string;         // WIP string
    revSharePct:   number;         // 0–100
    disabled?:     boolean;
  }): LicensingConfig {
    return {
      isSet:              true,
      mintingFee:         parseEther(params.mintingFee),
      licensingHook:      params.hookAddress,
      hookData:           "0x",
      commercialRevShare: pctToStoryUnits(params.revSharePct),
      disabled:           params.disabled ?? false,
      expectMinimumGroupRewardShare: 0,
      expectGroupRewardPool:         zeroAddress as `0x${string}`,
    };
  }

  // ─── Validation ───────────────────────────────────────────────────────────

  validate(config: PILConfig): void {
    if (config.revShare < 0 || config.revShare > 100) {
      throw new NexarError("INVALID_PARAMS", `revShare must be 0–100, got ${config.revShare}`);
    }
    if (!config.mintingFee || isNaN(Number(config.mintingFee))) {
      throw new NexarError("INVALID_PARAMS", `Invalid mintingFee: ${config.mintingFee}`);
    }
    if (!config.commercial && config.revShare > 0) {
      throw new NexarError("INVALID_PARAMS", "Non-commercial license cannot have revShare > 0");
    }
  }
}
