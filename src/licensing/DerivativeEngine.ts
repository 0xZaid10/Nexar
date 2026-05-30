// src/licensing/DerivativeEngine.ts
// Register derivative IPs and traverse the derivative chain.
// Confirmed against:
//   developers/typescript-sdk/register-derivative.md
//   sdk-reference/ipasset.md registerDerivativeIpAsset

import type { StoryClient } from "@story-protocol/core-sdk";

import { NEXAR_SPG_NFT, STORY_CONTRACTS } from "../core/config.js";
import { NexarError }                      from "../core/errors.js";
import { createLogger }                     from "../core/logger.js";
import type { HexAddress, TxHash, DerivativeRecord, RoyaltyNode, IpCreator } from "../core/types.js";
import type { MetadataBuilder, BuildMetadataParams } from "../sdk/asset/MetadataBuilder.js";
import type { AssetTier } from "../core/config.js";

const log = createLogger("DerivativeEngine");

export class DerivativeEngine {
  private readonly story:    ReturnType<typeof StoryClient.newClient>;
  private readonly metadata: MetadataBuilder;
  private readonly owner:    HexAddress;

  constructor(
    storyClient:     ReturnType<typeof StoryClient.newClient>,
    metadataBuilder: MetadataBuilder,
    ownerAddress:    HexAddress
  ) {
    this.story    = storyClient;
    this.metadata = metadataBuilder;
    this.owner    = ownerAddress;
  }

  /**
   * Register a new derivative IP Asset as a child of parent IPs.
   * Mints a new NFT + registers + links to parents in one tx.
   *
   * Confirmed from developers/typescript-sdk/register-derivative.md:
   *   client.ipAsset.registerDerivativeIpAsset({
   *     nft: { type: "mint", spgNftContract },
   *     derivData: { parentIpIds, licenseTermsIds },
   *     ipMetadata: { ... }
   *   })
   *
   * Multi-user: each call mints to `owner` — fully per-user.
   *
   * @param parentIpIds      - Array of parent IP Asset IDs
   * @param licenseTermsIds  - License terms for each parent (parallel arrays)
   * @param metadata         - IP metadata for the derivative
   */
  async registerDerivative(params: {
    parentIpIds:      HexAddress[];
    licenseTermsIds:  bigint[];
    metadata:         BuildMetadataParams;
  }): Promise<DerivativeRecord> {
    if (params.parentIpIds.length !== params.licenseTermsIds.length) {
      throw new NexarError(
        "INVALID_PARAMS",
        "parentIpIds and licenseTermsIds arrays must have the same length"
      );
    }

    log.info("Registering derivative IP Asset...", {
      parents: params.parentIpIds.join(", "),
      terms:   params.licenseTermsIds.map(String).join(", "),
    });

    // Build and upload metadata
    const built = await this.metadata.build(params.metadata);

    try {
      const response = await this.story.ipAsset.registerDerivativeIpAsset({
        nft: {
          type:           "mint",
          spgNftContract: (NEXAR_SPG_NFT || STORY_CONTRACTS.IPAssetRegistry) as HexAddress,
          recipient:      this.owner,
        },
        derivData: {
          parentIpIds:     params.parentIpIds,
          licenseTermsIds: params.licenseTermsIds.map(String),
        },
        ipMetadata: {
          ipMetadataURI:   built.ipMetadataURI,
          ipMetadataHash:  built.ipMetadataHash,
          nftMetadataURI:  built.nftMetadataURI,
          nftMetadataHash: built.nftMetadataHash,
        },
      });

      const record: DerivativeRecord = {
        childIpId:       response.ipId as HexAddress,
        parentIpIds:     params.parentIpIds,
        licenseTermsIds: params.licenseTermsIds,
        registeredAt:    Date.now(),
        txHash:          response.txHash as TxHash,
      };

      log.success("Derivative registered", {
        childIpId: record.childIpId,
        parents:   params.parentIpIds.join(", "),
        txHash:    record.txHash,
      });

      return record;
    } catch (err) {
      throw new NexarError(
        "DERIVATIVE_REGISTER_FAILED",
        `Failed to register derivative of [${params.parentIpIds.join(", ")}]`,
        { cause: err }
      );
    }
  }

  /**
   * Build a human-readable royalty flow graph starting from a root IP.
   * Recursively resolves parent-child relationships.
   * Multi-user: read-only, no auth required.
   *
   * @param ipId      - Root IP Asset to start from
   * @param maxDepth  - Max levels to traverse (default 5)
   */
  async buildRoyaltyGraph(ipId: HexAddress, maxDepth = 5): Promise<RoyaltyNode> {
    return this._buildNode(ipId, 0, maxDepth, new Set<string>());
  }

  private async _buildNode(
    ipId:    HexAddress,
    depth:   number,
    maxDepth:number,
    visited: Set<string>
  ): Promise<RoyaltyNode> {
    if (depth >= maxDepth || visited.has(ipId)) {
      return { ipId, revShare: 0, children: [] };
    }
    visited.add(ipId);

    // Note: Story API does not yet expose a direct "get children" endpoint
    // In production, use the Story API v4 list-ip-asset-edges endpoint
    // For now return a leaf node — the demo layer builds the graph manually
    return {
      ipId,
      revShare: 0,
      children: [],
    };
  }

  /**
   * Get ancestors of an IP Asset (walk up the parent chain).
   * Uses Story Protocol's IP graph traversal.
   */
  async getAncestors(ipId: HexAddress): Promise<HexAddress[]> {
    try {
      // Query Story API for parent relationships
      // This calls the list-ip-asset-edges API endpoint
      const response = await fetch(
        `https://api.storyapis.com/api/v4/assets/${ipId}/parents`,
        { headers: { "Content-Type": "application/json" } }
      );
      if (!response.ok) return [];
      const data = await response.json() as { data?: Array<{ ipId: string }> };
      return (data.data ?? []).map((d) => d.ipId as HexAddress);
    } catch {
      return [];
    }
  }

  /**
   * Simulate revenue flow through the royalty graph.
   * Shows how much each ancestor receives when `amount` WIP is paid.
   *
   * @param ipId   - IP earning revenue
   * @param amount - Total revenue in WIP (18 decimals)
   * @returns Map of ipId → amount received
   */
  async simulateRevenue(
    ipId:   HexAddress,
    amount: bigint
  ): Promise<Map<HexAddress, bigint>> {
    const distribution = new Map<HexAddress, bigint>();
    const ancestors    = await this.getAncestors(ipId);

    // Simple simulation — actual distribution is handled by Royalty Module
    // This gives a human-readable preview for the demo
    let remaining = amount;
    for (const ancestor of ancestors) {
      // Approximate: each ancestor takes their configured rev share
      // Real calculation is done on-chain by RoyaltyModule
      const share = remaining / 10n; // placeholder 10% per ancestor
      distribution.set(ancestor, share);
      remaining -= share;
    }
    distribution.set(ipId, remaining);

    return distribution;
  }
}
