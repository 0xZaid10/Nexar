// src/agents/ProviderAgent.ts
// Provider agent: registers assets, monitors royalties, claims revenue.
// Multi-user: each instance manages one provider identity (one wallet).
// Extends BaseAgent — all clients pre-wired.

import type { StoryClient }   from "@story-protocol/core-sdk";
import type { CDRClient }      from "@piplabs/cdr-sdk";
import type { Account, PublicClient, WalletClient } from "viem";
import { parseEther, zeroAddress } from "viem";

import { TOKENS, STORY_CONTRACTS }  from "../core/config.js";
import { NexarError }              from "../core/errors.js";
import { BaseAgent, type AgentConfig } from "./BaseAgent.js";
import { AssetRegistry }           from "../sdk/asset/AssetRegistry.js";
import type { RegisterAssetParams, RegisterAssetResult, HexAddress, TxHash } from "../core/types.js";

export class ProviderAgent extends BaseAgent {
  private readonly assetRegistry: AssetRegistry;

  // Tracks all assets registered by this provider in this session
  readonly registeredAssets: RegisterAssetResult[] = [];

  constructor(
    config:       AgentConfig,
    account:      Account,
    storyClient:  ReturnType<typeof StoryClient.newClient>,
    cdrClient:    CDRClient,
    publicClient: PublicClient,
    walletClient: WalletClient
  ) {
    super(config, account, storyClient, cdrClient, publicClient, walletClient);
    this.assetRegistry = new AssetRegistry(storyClient, cdrClient, this.address);
  }

  // ─── Main lifecycle ───────────────────────────────────────────────────────

  async run(): Promise<void> {
    this.log.info("Provider agent running...", { address: this.address });
    const rep = await this.getReputation();
    this.log.info("Current reputation", { score: rep.toString() });
  }

  // ─── Register an intelligence asset ──────────────────────────────────────

  /**
   * Register a new intelligence asset end-to-end.
   * Delegates to AssetRegistry.register() — NFT + IP + CDR + PIL + hook.
   * Multi-user: each call is independently scoped to this provider's wallet.
   *
   * @param params - RegisterAssetParams (content, tier, name, creators, etc.)
   */
  async registerAsset(params: RegisterAssetParams): Promise<RegisterAssetResult> {
    this.log.separator(`Registering: ${params.name}`);

    const result = await this.assetRegistry.register(params);
    this.registeredAssets.push(result);

    // Register in DynamicPricingHook after IP creation
    try {
      await this.hooks.registerAsset({
        ipId:      result.ipId,
        tier:      params.tier,
        basePrice: params.basePrice,
      });
    } catch (err) {
      this.log.warn("Hook registration failed (non-critical)", { err: String(err) });
    }

    this.log.success("Asset registered and priced", {
      ipId:      result.ipId,
      uuid:      result.vaultUuid.toString(),
      basePrice: params.basePrice,
    });

    return result;
  }

  // ─── Update pricing ───────────────────────────────────────────────────────

  /**
   * Update base price for an asset in DynamicPricingHook.
   * Multi-user: only the asset owner can update (enforced on-chain).
   */
  async updatePrice(ipId: HexAddress, newBasePrice: string): Promise<TxHash> {
    this.log.info("Updating base price...", { ipId, newBasePrice });
    return this.hooks.setBasePrice(ipId, newBasePrice);
  }

  // ─── Monitor royalties ────────────────────────────────────────────────────

  /**
   * Check claimable royalties for all registered assets.
   * Multi-user: each provider monitors their own assets.
   */
  async checkClaimableRoyalties(): Promise<Map<HexAddress, bigint>> {
    const claimable = new Map<HexAddress, bigint>();

    for (const asset of this.registeredAssets) {
      try {
        const result = await this.story.royalty.claimableRevenue({
          claimer: asset.ipId,
          token:   TOKENS.WIP,
        });
        claimable.set(asset.ipId, BigInt(result ?? 0));
      } catch { /* no vault yet */ }
    }

    return claimable;
  }

  // ─── Claim revenue ────────────────────────────────────────────────────────

  /**
   * Claim all accrued royalties for a specific IP Asset.
   * Confirmed from sdk-reference/royalty.md claimAllRevenue().
   * Multi-user: each provider claims independently for their own IPs.
   *
   * @param ancestorIpId - IP Asset to claim revenue for
   * @param childIpIds   - Derivative IPs that generated the revenue
   */
  async claimRevenue(
    ancestorIpId: HexAddress,
    childIpIds:   HexAddress[] = []
  ): Promise<{ amountClaimed: bigint; txHash?: TxHash }> {
    this.log.info("Claiming revenue...", {
      ipId:     ancestorIpId,
      children: childIpIds.length.toString(),
    });

    try {
      const result = await this.story.royalty.claimAllRevenue({
        ancestorIpId,
        claimer:          ancestorIpId,         // IP Account holds royalty tokens
        childIpIds,
        royaltyPolicies:  childIpIds.map(() => STORY_CONTRACTS.RoyaltyPolicyLAP as HexAddress),
        currencyTokens:   [TOKENS.WIP],
        claimOptions: {
          autoTransferAllClaimedTokensFromIp: true,
          autoUnwrapIpTokens:                 false,
        },
      });

      this.log.success("Revenue claimed", { ancestorIpId, txHash: result.txHash });
      return {
        amountClaimed: 0n, // actual amount from event logs in production
        txHash:        result.txHash as TxHash | undefined,
      };
    } catch (err) {
      throw new NexarError("ROYALTY_CLAIM_FAILED", `Failed to claim revenue for ${ancestorIpId}`, { cause: err });
    }
  }

  // ─── Pay royalty on behalf of child ──────────────────────────────────────

  /**
   * Pay royalties upstream from a child IP to a parent IP.
   * Confirmed from sdk-reference/royalty.md payRoyaltyOnBehalf().
   * Use when a child IP earns revenue and needs to route the parent's share.
   */
  async payRoyalty(params: {
    receiverIpId: HexAddress;
    payerIpId:    HexAddress;
    amount:       bigint;
  }): Promise<TxHash> {
    this.log.info("Paying royalty...", {
      receiver: params.receiverIpId,
      payer:    params.payerIpId,
      amount:   params.amount.toString(),
    });

    const result = await this.story.royalty.payRoyaltyOnBehalf({
      receiverIpId: params.receiverIpId,
      payerIpId:    params.payerIpId || zeroAddress as HexAddress,
      token:        TOKENS.WIP,
      amount:       params.amount,
    });

    this.log.success("Royalty paid", { txHash: result.txHash });
    return result.txHash as TxHash;
  }
}
