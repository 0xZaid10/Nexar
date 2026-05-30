// test/sdk.test.ts
// Tests for Layer 1: Confidential Asset SDK
// Tests: Encryptor, ConditionBuilder, VaultManager (unit), AssetTypes

import { describe, it, expect } from "vitest";
import {
  encrypt,
  decrypt,
  generateKey,
  sha256Hex,
} from "../src/sdk/vault/Encryptor.js";
import {
  ownerOnly,
  licenseGated,
  inferenceOnly,
  encodeLicenseTokenIds,
} from "../src/sdk/vault/ConditionBuilder.js";
import {
  ASSET_TYPE_CONFIGS,
  getAssetTypeConfig,
  isFileVault,
  isSecretVault,
} from "../src/sdk/asset/AssetTypes.js";
import { AssetTier } from "../src/core/config.js";
import { NexarError } from "../src/core/errors.js";

// ─── Encryptor ────────────────────────────────────────────────────────────────

describe("Encryptor", () => {
  it("encrypts and decrypts round-trip correctly", () => {
    const plaintext = new TextEncoder().encode("hello NEXAR world");
    const { encrypted, key } = encrypt(plaintext);
    const decrypted = decrypt(encrypted, key);
    expect(new TextDecoder().decode(decrypted)).toBe("hello NEXAR world");
  });

  it("uses provided key when supplied", () => {
    const plaintext = new TextEncoder().encode("test payload");
    const key       = generateKey();
    const { encrypted, key: returnedKey } = encrypt(plaintext, key);
    expect(returnedKey).toStrictEqual(key);
    const decrypted = decrypt(encrypted, returnedKey);
    expect(new TextDecoder().decode(decrypted)).toBe("test payload");
  });

  it("generates unique keys on each call", () => {
    const k1 = generateKey();
    const k2 = generateKey();
    expect(k1).not.toStrictEqual(k2);
  });

  it("throws on wrong key", () => {
    const plaintext = new TextEncoder().encode("secret");
    const { encrypted } = encrypt(plaintext);
    const wrongKey = generateKey();
    expect(() => decrypt(encrypted, wrongKey)).toThrow(NexarError);
  });

  it("throws on truncated nexartext", () => {
    const { encrypted } = encrypt(new TextEncoder().encode("x"));
    expect(() => decrypt(encrypted.slice(0, 5), generateKey())).toThrow(NexarError);
  });

  it("sha256Hex returns 0x-prefixed 64-char hex", () => {
    const hash = sha256Hex(new TextEncoder().encode("hello"));
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("sha256Hex is deterministic", () => {
    const data = new TextEncoder().encode("deterministic");
    expect(sha256Hex(data)).toBe(sha256Hex(data));
  });

  it("large payload round-trips correctly", () => {
    const big = new Uint8Array(100_000).fill(42);
    const { encrypted, key } = encrypt(big);
    const out = decrypt(encrypted, key);
    expect(out).toStrictEqual(big);
  });
});

// ─── ConditionBuilder ─────────────────────────────────────────────────────────

describe("ConditionBuilder", () => {
  const owner  = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
  const ipId   = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;

  it("ownerOnly returns owner as both conditions", () => {
    const c = ownerOnly({ ownerAddress: owner });
    expect(c.writeConditionAddr.toLowerCase()).toBe(owner.toLowerCase());
    expect(c.readConditionAddr.toLowerCase()).toBe(owner.toLowerCase());
    expect(c.writeConditionData).toBe("0x");
    expect(c.readConditionData).toBe("0x");
  });

  it("licenseGated uses CDR condition contracts", () => {
    const c = licenseGated({ ownerAddress: owner, ipId });
    // Write condition = OwnerWriteCondition
    expect(c.writeConditionAddr).toMatch(/^0x/);
    // Read condition = LicenseReadCondition
    expect(c.readConditionAddr).toMatch(/^0x/);
    // Write data encodes owner address
    expect(c.writeConditionData.length).toBeGreaterThan(2);
    // Read data encodes licenseToken + ipId
    expect(c.readConditionData.length).toBeGreaterThan(2);
  });

  it("inferenceOnly uses InferenceAccessCondition address", () => {
    const c = inferenceOnly({
      ownerAddress:            owner,
      ipId,
      inferenceLicenseTermsId: 1n,
      maxComputeUnits:         10,
    });
    expect(c.writeConditionAddr).toMatch(/^0x/);
    expect(c.readConditionAddr).toBe(c.writeConditionAddr);
    expect(c.readConditionData.length).toBeGreaterThan(2);
  });

  it("encodeLicenseTokenIds encodes array correctly", () => {
    const encoded = encodeLicenseTokenIds([1n, 2n, 3n]);
    expect(encoded).toMatch(/^0x/);
    expect(encoded.length).toBeGreaterThan(2);
  });

  it("encodeLicenseTokenIds with empty array returns short hex", () => {
    const encoded = encodeLicenseTokenIds([]);
    expect(encoded).toMatch(/^0x/);
  });
});

// ─── AssetTypes ───────────────────────────────────────────────────────────────

describe("AssetTypes", () => {
  it("all 5 tiers are configured", () => {
    expect(Object.keys(ASSET_TYPE_CONFIGS)).toHaveLength(5);
  });

  it("DATASET tier is file vault", () => {
    expect(isFileVault(AssetTier.DATASET)).toBe(true);
    expect(isSecretVault(AssetTier.DATASET)).toBe(false);
  });

  it("MODEL tier is file vault", () => {
    expect(isFileVault(AssetTier.MODEL)).toBe(true);
  });

  it("STRATEGY tier is secret vault", () => {
    expect(isSecretVault(AssetTier.STRATEGY)).toBe(true);
    expect(isFileVault(AssetTier.STRATEGY)).toBe(false);
  });

  it("PROMPT tier is secret vault", () => {
    expect(isSecretVault(AssetTier.PROMPT)).toBe(true);
  });

  it("INFERENCE tier is file vault", () => {
    expect(isFileVault(AssetTier.INFERENCE)).toBe(true);
  });

  it("getAssetTypeConfig returns correct config", () => {
    const cfg = getAssetTypeConfig(AssetTier.DATASET);
    expect(cfg.tier).toBe(AssetTier.DATASET);
    expect(cfg.defaultPIL.commercialUse).toBe(true);
    expect(cfg.defaultPIL.commercialRevShare).toBe(15_000_000);
  });

  it("all tiers have positive rev share for commercial", () => {
    [AssetTier.DATASET, AssetTier.MODEL, AssetTier.STRATEGY, AssetTier.INFERENCE, AssetTier.PROMPT]
      .forEach((tier) => {
        const cfg = getAssetTypeConfig(tier);
        if (cfg.defaultPIL.commercialUse) {
          expect(cfg.defaultPIL.commercialRevShare).toBeGreaterThan(0);
        }
      });
  });
});
