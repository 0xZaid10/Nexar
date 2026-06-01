// src/sdk/vault/ConditionBuilder.ts
// Builds ABI-encoded write/read conditions for CDR vaults.
// Abstracts all encodeAbiParameters calls so callers never touch raw encoding.
// Confirmed addresses and patterns from:
//   sdk-reference/cdr/uploader.md
//   developers/cdr-sdk/ip-asset-vaults.md

import { encodeAbiParameters } from "viem";
import {
  CDR_CONTRACTS,
  NEXAR_CONTRACTS,
  STORY_CONTRACTS,
  type HexAddress,
} from "../../core/index.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BuiltCondition {
  writeConditionAddr: `0x${string}`;
  readConditionAddr:  `0x${string}`;
  writeConditionData: `0x${string}`;
  readConditionData:  `0x${string}`;
  accessAuxData:      `0x${string}`;
}

export interface LicenseGatedParams {
  ownerAddress: HexAddress;  // who can write (the uploader)
  ipId:         HexAddress;  // Story IP Asset ID to gate reads on
}

export interface InferenceOnlyParams {
  ownerAddress:             HexAddress;
  ipId:                     HexAddress;
  inferenceLicenseTermsId:  bigint;
  maxComputeUnits:          number;
}

export interface TimedParams {
  ownerAddress:    HexAddress;
  ipId:            HexAddress;
  expiryTimestamp: bigint;
}

export interface OwnerOnlyParams {
  ownerAddress: HexAddress;
}

// ─── Access aux data encoders ─────────────────────────────────────────────────

/**
 * Encode accessAuxData for license-gated vault reads.
 * Confirmed from developers/cdr-sdk/ip-asset-vaults.md:
 *   accessAuxData = abi.encode(uint256[] licenseTokenIds)
 */
export function encodeLicenseTokenIds(licenseTokenIds: bigint[]): `0x${string}` {
  return encodeAbiParameters(
    [{ type: "uint256[]" }],
    [licenseTokenIds]
  );
}

/**
 * Encode accessAuxData for inference-only vault reads.
 * Same encoding as license-gated — inference license token IDs.
 */
export function encodeInferenceTokenIds(licenseTokenIds: bigint[]): `0x${string}` {
  return encodeLicenseTokenIds(licenseTokenIds);
}

// ─── Condition builders ───────────────────────────────────────────────────────

/**
 * Owner-only vault: only the uploading address can read/write.
 * Uses EOA address as both conditions with skipConditionValidation.
 * From sdk-reference/cdr/uploader.md allocate() example.
 */
export function ownerOnly(params: OwnerOnlyParams): BuiltCondition {
  const writeConditionData = encodeAbiParameters(
    [{ type: "address" }],
    [params.ownerAddress]
  );
  return {
    writeConditionAddr: CDR_CONTRACTS.OwnerWriteCondition,
    readConditionAddr:  CDR_CONTRACTS.OwnerWriteCondition,
    writeConditionData,
    readConditionData:  writeConditionData,
    accessAuxData:      "0x",
  };
}

/**
 * License-gated vault: owner writes, license token holders read.
 * This is the core NEXAR pattern — Story license token = CDR decryption key.
 *
 * Confirmed from sdk-reference/cdr/uploader.md uploadCDR() example:
 *   writeConditionAddr: OwnerWriteCondition (0x4C9b...)
 *   readConditionAddr:  LicenseReadCondition (0xC064...)
 *   writeConditionData: abi.encode(address owner)
 *   readConditionData:  abi.encode(address licenseToken, address ipId)
 */
export function licenseGated(params: LicenseGatedParams): BuiltCondition {
  const writeConditionData = encodeAbiParameters(
    [{ type: "address" }],
    [params.ownerAddress]
  );

  const readConditionData = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }],
    [STORY_CONTRACTS.LicenseToken, params.ipId]
  );

  return {
    writeConditionAddr: CDR_CONTRACTS.OwnerWriteCondition,
    readConditionAddr:  CDR_CONTRACTS.LicenseReadCondition,
    writeConditionData,
    readConditionData,
    accessAuxData:      "0x",
  };
}

/**
 * Inference-only vault: owner writes, inference license + quota enforced on read.
 * Uses our custom InferenceAccessCondition contract.
 * Callers get outputs only — raw data never exposed.
 *
 * writeConditionData: abi.encode(address owner)
 * readConditionData:  abi.encode(address licenseToken, address ipId,
 *                               uint256 inferenceLicenseTermsId, uint256 maxComputeUnits)
 */
export function inferenceOnly(params: InferenceOnlyParams): BuiltCondition {
  const writeConditionData = encodeAbiParameters(
    [{ type: "address" }],
    [params.ownerAddress]
  );

  const readConditionData = encodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "uint256" },
      { type: "uint256" },
    ],
    [
      STORY_CONTRACTS.LicenseToken,
      params.ipId,
      params.inferenceLicenseTermsId,
      BigInt(params.maxComputeUnits),
    ]
  );

  return {
    writeConditionAddr: CDR_CONTRACTS.OwnerWriteCondition,
    readConditionAddr:  NEXAR_CONTRACTS.InferenceAccessCondition,
    writeConditionData,
    readConditionData,
    accessAuxData:      "0x",
  };
}

/**
 * Timed vault: license-gated with on-chain expiry enforced at the protocol level.
 * Uses TimedAccessCondition contract — expiry checked by CDR validators themselves.
 * After expiryTimestamp, the vault is permanently inaccessible — no server involved.
 *
 * writeConditionData: abi.encode(address owner)
 * readConditionData:  abi.encode(address licenseToken, address ipId, uint256 expiryTimestamp)
 */
export function timed(params: TimedParams): BuiltCondition & { expiryTimestamp: bigint } {
  const writeConditionData = encodeAbiParameters(
    [{ type: "address" }],
    [params.ownerAddress]
  );

  const readConditionData = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint256" }],
    [STORY_CONTRACTS.LicenseToken, params.ipId, params.expiryTimestamp]
  );

  return {
    writeConditionAddr: CDR_CONTRACTS.OwnerWriteCondition,
    readConditionAddr:  CDR_CONTRACTS.OwnerWriteCondition,
    writeConditionData,
    readConditionData,
    accessAuxData:      "0x",
    expiryTimestamp:    params.expiryTimestamp,
  };
}

/**
 * Custom condition: caller provides raw condition addresses and data.
 * For advanced use cases not covered by the built-in patterns.
 */
export function custom(params: {
  writeConditionAddr: `0x${string}`;
  readConditionAddr:  `0x${string}`;
  writeConditionData: `0x${string}`;
  readConditionData:  `0x${string}`;
  accessAuxData?:     `0x${string}`;
}): BuiltCondition {
  return {
    writeConditionAddr: params.writeConditionAddr,
    readConditionAddr:  params.readConditionAddr,
    writeConditionData: params.writeConditionData,
    readConditionData:  params.readConditionData,
    accessAuxData:      params.accessAuxData ?? "0x",
  };
}
