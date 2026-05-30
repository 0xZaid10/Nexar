// src/licensing/HookManager.ts
// Wrapper for DynamicPricingHook and InferenceAccessCondition contracts.
// Handles: asset registration in hook, price preview, quota management.
// All contract calls go through viem writeContract / readContract.

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  type PublicClient,
  type WalletClient,
  type Account,
} from "viem";

import {
  NEXAR_CONTRACTS,
  NETWORK,
  AssetTier,
} from "../core/config.js";
import { NexarError }  from "../core/errors.js";
import { createLogger } from "../core/logger.js";
import type { HexAddress, TxHash } from "../core/types.js";

const log = createLogger("HookManager");

// ─── ABI fragments (only what we call) ───────────────────────────────────────

const PRICING_HOOK_ABI = [
  {
    name: "registerAsset",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "ipId",       type: "address" },
      { name: "tier",       type: "uint8"   },
      { name: "_basePrice", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "setBasePrice",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "ipId",       type: "address" },
      { name: "_basePrice", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "previewPrice",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "ipId",   type: "address" },
      { name: "caller", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "estimatedFee", type: "uint256" }],
  },
  {
    name: "getAssetInfo",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "ipId", type: "address" }],
    outputs: [
      { name: "tier",       type: "uint8"   },
      { name: "base",       type: "uint256" },
      { name: "demand",     type: "uint256" },
      { name: "ipOwnerAddr",type: "address" },
    ],
  },
  {
    name: "demandCount",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const INFERENCE_CONDITION_ABI = [
  {
    name: "getComputeUsed",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "caller", type: "address" },
      { name: "ipId",   type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "resetQuota",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "caller", type: "address" },
      { name: "ipId",   type: "address" },
    ],
    outputs: [],
  },
] as const;

const REPUTATION_REGISTRY_ABI = [
  {
    name: "getReputation",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "agent", type: "address" }],
    outputs: [{ name: "score", type: "uint256" }],
  },
  {
    name: "recordLicensePurchase",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "agent", type: "address" }],
    outputs: [],
  },
  {
    name: "recordDerivativeRegistered",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "agent", type: "address" }],
    outputs: [],
  },
] as const;

// ─── HookManager ─────────────────────────────────────────────────────────────

export class HookManager {
  private readonly publicClient:  PublicClient;
  private readonly walletClient:  WalletClient;
  private readonly account:       Account;

  constructor(publicClient: PublicClient, walletClient: WalletClient, account: Account) {
    this.publicClient  = publicClient;
    this.walletClient  = walletClient;
    this.account       = account;
  }

  // ─── DynamicPricingHook methods ───────────────────────────────────────────

  /**
   * Register an IP Asset in DynamicPricingHook with tier + base price.
   * Call this after AssetRegistry.register() to activate dynamic pricing.
   * Multi-user: each ipId is registered independently.
   */
  async registerAsset(params: {
    ipId:      HexAddress;
    tier:      AssetTier;
    basePrice: string;         // WIP string e.g. "0.1"
  }): Promise<TxHash> {
    log.info("Registering asset in DynamicPricingHook...", {
      ipId:  params.ipId,
      tier:  params.tier.toString(),
      price: params.basePrice,
    });

    try {
      const txHash = await this.walletClient.writeContract({
        address:      NEXAR_CONTRACTS.DynamicPricingHook,
        abi:          PRICING_HOOK_ABI,
        functionName: "registerAsset",
        args:         [params.ipId, params.tier, parseEther(params.basePrice)],
        account:      this.account,
        chain:        null,
      });

      log.success("Asset registered in pricing hook", { ipId: params.ipId, txHash });
      return txHash as TxHash;
    } catch (err) {
      throw new NexarError("LICENSE_CONFIG_FAILED", `Failed to register asset in hook: ${params.ipId}`, { cause: err });
    }
  }

  /**
   * Update base price for an IP Asset.
   * Only callable by IP owner (enforced on-chain).
   */
  async setBasePrice(ipId: HexAddress, basePrice: string): Promise<TxHash> {
    try {
      const txHash = await this.walletClient.writeContract({
        address:      NEXAR_CONTRACTS.DynamicPricingHook,
        abi:          PRICING_HOOK_ABI,
        functionName: "setBasePrice",
        args:         [ipId, parseEther(basePrice)],
        account:      this.account,
        chain:        null,
      });
      log.success("Base price updated", { ipId, basePrice, txHash });
      return txHash as TxHash;
    } catch (err) {
      throw new NexarError("LICENSE_CONFIG_FAILED", `Failed to update base price for ${ipId}`, { cause: err });
    }
  }

  /**
   * Preview the current minting fee for an IP Asset.
   * Multi-user: caller's reputation affects price — pass the buyer's address.
   *
   * @param ipId    - IP Asset to check
   * @param caller  - Buyer's address (reputation-adjusted)
   * @param amount  - Number of license tokens
   */
  async previewMintFee(
    ipId:   HexAddress,
    caller: HexAddress,
    amount: number = 1
  ): Promise<bigint> {
    try {
      const fee = await this.publicClient.readContract({
        address:      NEXAR_CONTRACTS.DynamicPricingHook,
        abi:          PRICING_HOOK_ABI,
        functionName: "previewPrice",
        args:         [ipId, caller, BigInt(amount)],
      });
      return fee as bigint;
    } catch (err) {
      throw new NexarError("LICENSE_CONFIG_FAILED", `Failed to preview price for ${ipId}`, { cause: err });
    }
  }

  /**
   * Get demand count for an IP Asset (how many times licensed).
   */
  async getDemandCount(ipId: HexAddress): Promise<bigint> {
    const count = await this.publicClient.readContract({
      address:      NEXAR_CONTRACTS.DynamicPricingHook,
      abi:          PRICING_HOOK_ABI,
      functionName: "demandCount",
      args:         [ipId],
    });
    return count as bigint;
  }

  // ─── InferenceAccessCondition — quota management ──────────────────────────

  /**
   * Get compute units used by a caller for a specific IP Asset.
   * Multi-user: quota is per (caller, ipId) pair.
   */
  async getComputeUsed(caller: HexAddress, ipId: HexAddress): Promise<bigint> {
    const used = await this.publicClient.readContract({
      address:      NEXAR_CONTRACTS.InferenceAccessCondition,
      abi:          INFERENCE_CONDITION_ABI,
      functionName: "getComputeUsed",
      args:         [caller, ipId],
    });
    return used as bigint;
  }

  /**
   * Reset compute quota for a caller (owner only, for testing).
   */
  async resetQuota(caller: HexAddress, ipId: HexAddress): Promise<TxHash> {
    const txHash = await this.walletClient.writeContract({
      address:      NEXAR_CONTRACTS.InferenceAccessCondition,
      abi:          INFERENCE_CONDITION_ABI,
      functionName: "resetQuota",
      args:         [caller, ipId],
      account:      this.account,
      chain:        null,
    });
    log.success("Quota reset", { caller, ipId });
    return txHash as TxHash;
  }

  // ─── ReputationRegistry methods ───────────────────────────────────────────

  /**
   * Get on-chain reputation score for an address (0–100).
   * Multi-user: each address has independent reputation.
   */
  async getReputation(agent: HexAddress): Promise<number> {
    const score = await this.publicClient.readContract({
      address:      NEXAR_CONTRACTS.ReputationRegistry,
      abi:          REPUTATION_REGISTRY_ABI,
      functionName: "getReputation",
      args:         [agent],
    });
    return Number(score);
  }

  /**
   * Record a license purchase for an agent (increases reputation by 5).
   */
  async recordLicensePurchase(agent: HexAddress): Promise<void> {
    try {
      await this.walletClient.writeContract({
        address:      NEXAR_CONTRACTS.ReputationRegistry,
        abi:          REPUTATION_REGISTRY_ABI,
        functionName: "recordLicensePurchase",
        args:         [agent],
        account:      this.account,
        chain:        null,
      });
    } catch { /* non-critical — reputation recording failure should not block flow */ }
  }

  /**
   * Record a derivative registration for an agent (increases reputation by 10).
   */
  async recordDerivativeRegistered(agent: HexAddress): Promise<void> {
    try {
      await this.walletClient.writeContract({
        address:      NEXAR_CONTRACTS.ReputationRegistry,
        abi:          REPUTATION_REGISTRY_ABI,
        functionName: "recordDerivativeRegistered",
        args:         [agent],
        account:      this.account,
        chain:        null,
      });
    } catch { /* non-critical */ }
  }
}
