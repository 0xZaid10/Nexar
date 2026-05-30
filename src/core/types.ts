// src/core/types.ts
// Shared types used across all NEXAR modules.
// Import from here — never redefine types in individual modules.

import type { Address, Hash, PublicClient, WalletClient } from "viem";
import { AssetTier } from "./config.js";

// ─── Primitives ───────────────────────────────────────────────────────────────

export type HexAddress = Address;
export type TxHash     = Hash;

// ─── Client bundle ────────────────────────────────────────────────────────────

export interface NexarClients {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account:      HexAddress;
}

// ─── Asset types ─────────────────────────────────────────────────────────────

/** Mirrors NEXARRegistry.sol AssetRecord */
export interface AssetRecord {
  assetId:      bigint;
  ipId:         HexAddress;
  vaultUuid:    bigint;
  tier:         AssetTier;
  owner:        HexAddress;
  registeredAt: bigint;
  active:       boolean;
  name:         string;
  assetType:    string;
}

/** Mirrors NEXARRegistry.sol PoolRecord */
export interface PoolRecord {
  poolId:     bigint;
  groupIpId:  HexAddress;
  memberIds:  bigint[];
  owner:      HexAddress;
  createdAt:  bigint;
  active:     boolean;
  name:       string;
}

/** Result returned after a full asset registration */
export interface RegisterAssetResult {
  assetId:         bigint;
  ipId:            HexAddress;
  tokenId:         bigint;
  vaultUuid:       bigint;
  licenseTermsId:  bigint;
  txHashes: {
    mintAndRegister: TxHash;
    attachTerms:     TxHash;
    setLicenseConfig:TxHash;
    allocateVault:   TxHash;
    writeVault:      TxHash;
    registerOnChain: TxHash;
  };
}

/** Input params for AssetRegistry.register() */
export interface RegisterAssetParams {
  tier:        AssetTier;
  name:        string;
  description: string;
  content:     Uint8Array;        // raw bytes to encrypt and store
  contentType: string;            // MIME type e.g. "text/plain", "application/octet-stream"
  creators:    IpCreator[];
  commercial:  boolean;
  revShare:    number;            // e.g. 15 for 15% — converted to Story units internally
  basePrice:   string;            // in WIP e.g. "0.1"
  mediaHash?:  string;            // optional SHA-256 of media for SAS
  mediaUrl?:   string;
}

export interface IpCreator {
  name:                string;
  address:             HexAddress;
  contributionPercent: number;    // must sum to 100 across all creators
  description?:        string;
  role?:               string;
}

// ─── Vault types ──────────────────────────────────────────────────────────────

export type VaultConditionType =
  | "ownerOnly"
  | "licenseGated"
  | "inferenceOnly"
  | "timed"
  | "custom";

export interface VaultCreateParams {
  content:       Uint8Array;
  conditionType: VaultConditionType;
  conditionData: VaultConditionData;
  updatable:     boolean;
}

export interface VaultConditionData {
  ownerAddress?:            HexAddress;
  ipId?:                    HexAddress;
  licenseTermsId?:          bigint;
  inferenceLicenseTermsId?: bigint;
  maxComputeUnits?:         number;
  expiryTimestamp?:         bigint;
  customConditionAddr?:     HexAddress;
  customWriteData?:         `0x${string}`;
  customReadData?:          `0x${string}`;
}

export interface VaultRecord {
  uuid:          bigint;
  conditionType: VaultConditionType;
  ipId?:         HexAddress;
  cid?:          string;          // IPFS CID for file vaults
  createdAt:     number;
  txHashes: {
    allocate: TxHash;
    write:    TxHash;
  };
}

export interface VaultAccessParams {
  uuid:              bigint;
  licenseTokenIds?:  bigint[];    // for licenseGated and inferenceOnly
  accessAuxData?:    `0x${string}`; // override: if provided, used directly
}

export interface VaultAccessResult {
  dataKey:  Uint8Array;           // decrypted AES key
  content?: Uint8Array;           // decrypted file content (file vaults only)
  txHash:   TxHash;
}

// ─── Licensing types ──────────────────────────────────────────────────────────

export interface PILConfig {
  commercial:    boolean;
  revShare:      number;            // percentage (0–100)
  derivatives:   boolean;
  transferable:  boolean;
  mintingFee:    string;            // in WIP e.g. "0.1"
  expiration?:   bigint;            // 0 = never
}

export interface LicenseRecord {
  licenseTermsId: bigint;
  licenseTokenId: bigint;
  ipId:           HexAddress;
  owner:          HexAddress;
  mintedAt:       number;
  txHash:         TxHash;
}

export interface DerivativeRecord {
  childIpId:      HexAddress;
  parentIpIds:    HexAddress[];
  licenseTermsIds:bigint[];
  registeredAt:   number;
  txHash:         TxHash;
}

export interface RoyaltyNode {
  ipId:       HexAddress;
  name?:      string;
  revShare:   number;
  children:   RoyaltyNode[];
  vaultAddr?: HexAddress;
}

// ─── Session / Auth types ─────────────────────────────────────────────────────

export interface SessionPayload {
  address:   HexAddress;
  assetId?:  bigint;
  vaultUuid?:bigint;
  ipId?:     HexAddress;
  role:      "owner" | "reviewer" | "agent" | "inference";
  iat:       number;
  exp:       number;
}

export interface SessionToken {
  token:     string;
  expiresAt: number;
  address:   HexAddress;
}

export interface WalletRecord {
  address:            HexAddress;
  encryptedPrivateKey:string;       // AES-encrypted, stored server-side
  createdAt:          number;
  label?:             string;       // e.g. email address
}

export interface DelegateConfig {
  ipId:      HexAddress;
  delegate:  HexAddress;
  moduleAddr:HexAddress;
  fnSelector:string;
  ttl:       number;                // seconds
}

// ─── Negotiation / Agent types ────────────────────────────────────────────────

export type NegotiationStatus =
  | "IDLE"
  | "DISCOVERED"
  | "PROPOSED"
  | "COUNTERED"
  | "ACCEPTED"
  | "REJECTED"
  | "SETTLED";

export interface NegotiationState {
  id:           string;
  status:       NegotiationStatus;
  assetId:      bigint;
  ipId:         HexAddress;
  buyerAddress: HexAddress;
  proposedFee:  bigint;             // in WIP (18 decimals)
  counterFee?:  bigint;
  agreedFee?:   bigint;
  rounds:       number;
  startedAt:    number;
  updatedAt:    number;
}

export interface SettlementResult {
  negotiationId:  string;
  licenseTokenId: bigint;
  amountPaid:     bigint;
  vaultUuid:      bigint;
  txHash:         TxHash;
  settledAt:      number;
}

export interface AgentConfig {
  privateKey:  string;
  name:        string;
  role:        "provider" | "consumer" | "inference";
  maxBudget?:  bigint;              // max WIP willing to spend per negotiation
  strategy?:   "aggressive" | "moderate" | "conservative";
}

// ─── Runtime types ────────────────────────────────────────────────────────────

export interface StreamConfig {
  uuid:           bigint;
  sessionToken:   string;
  chunkSize?:     number;           // bytes per chunk, default 64KB
}

export interface InferenceRequest {
  uuid:           bigint;           // strategy/model vault UUID
  prompt:         string;
  licenseTokenId: bigint;
  sessionToken?:  string;
  maxTokens?:     number;
}

export interface InferenceResult {
  output:         string;
  computeUsed:    number;
  quotaRemaining: number;
  ipId:           HexAddress;
  executedAt:     number;
}

export interface RuntimeQuota {
  address:        HexAddress;
  ipId:           HexAddress;
  used:           number;
  max:            number;
  remaining:      number;
}

// ─── Pool types ───────────────────────────────────────────────────────────────

export interface PoolConfig {
  name:        string;
  description: string;
  revShare:    number;             // pool-level rev share (%)
}

export interface PoolMember {
  assetId: bigint;
  ipId:    HexAddress;
  addedAt: number;
}
