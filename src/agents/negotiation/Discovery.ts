// src/agents/negotiation/Discovery.ts
// Discovers NEXAR assets on-chain and reads their PIL terms.
// Multi-user: read-only, no auth required — any agent can discover any asset.
// Queries: NEXARRegistry (on-chain), DynamicPricingHook (pricing), Story SDK (PIL).

import type { PublicClient }  from "viem";
import type { StoryClient }   from "@story-protocol/core-sdk";

import { NEXAR_CONTRACTS }   from "../../core/config.js";
import { NexarError }        from "../../core/errors.js";
import { createLogger }       from "../../core/logger.js";
import { HookManager }        from "../../licensing/HookManager.js";
import { LicensingEngine }    from "../../licensing/LicensingEngine.js";
import type { HexAddress, AssetRecord } from "../../core/types.js";
import type { AssetTier }     from "../../core/config.js";

const log = createLogger("Discovery");

// ─── ABI for NEXARRegistry reads ─────────────────────────────────────────────

const REGISTRY_ABI = [
  {
    name: "getAssetsByTier",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "tier", type: "uint8" }],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  {
    name: "assets",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "", type: "uint256" }],
    outputs: [
      { name: "ipId",         type: "address" },
      { name: "vaultUuid",    type: "uint256" },
      { name: "tier",         type: "uint8"   },
      { name: "owner",        type: "address" },
      { name: "registeredAt", type: "uint256" },
      { name: "active",       type: "bool"    },
      { name: "name",         type: "string"  },
      { name: "assetType",    type: "string"  },
    ],
  },
  {
    name: "getAssetByIpId",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "ipId", type: "address" }],
    outputs: [
      { name: "ipId",         type: "address" },
      { name: "vaultUuid",    type: "uint256" },
      { name: "tier",         type: "uint8"   },
      { name: "owner",        type: "address" },
      { name: "registeredAt", type: "uint256" },
      { name: "active",       type: "bool"    },
      { name: "name",         type: "string"  },
      { name: "assetType",    type: "string"  },
    ],
  },
  {
    name: "totalAssets",
    type: "function",
    stateMutability: "view",
    inputs:  [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ─── Discovery result types ───────────────────────────────────────────────────

export interface DiscoveredAsset {
  assetId:      bigint;
  ipId:         HexAddress;
  vaultUuid:    bigint;
  tier:         AssetTier;
  owner:        HexAddress;
  name:         string;
  assetType:    string;
  currentPrice: bigint;         // from DynamicPricingHook (buyer-adjusted)
  marketPrice:  bigint;         // base price from hook
  licenseTermsId?: bigint;
}

export interface DiscoveryFilters {
  tier?:        AssetTier;
  maxPrice?:    bigint;
  owner?:       HexAddress;
  nameContains?:string;
}

// ─── Discovery ────────────────────────────────────────────────────────────────

export class Discovery {
  private readonly publicClient: PublicClient;
  private readonly hooks:        HookManager;
  private readonly licensing:    LicensingEngine;

  constructor(
    publicClient: PublicClient,
    storyClient:  ReturnType<typeof StoryClient.newClient>,
    hookManager:  HookManager
  ) {
    this.publicClient = publicClient;
    this.hooks        = hookManager;
    this.licensing    = new LicensingEngine(storyClient);
  }

  /**
   * Find all active NEXAR assets, optionally filtered.
   * Multi-user: read-only, permissionless — any agent can call this.
   *
   * @param filters  - Optional filters (tier, maxPrice, owner, name)
   * @param buyer    - Buyer address for reputation-adjusted pricing
   */
  async findAssets(
    filters: DiscoveryFilters = {},
    buyer:   HexAddress
  ): Promise<DiscoveredAsset[]> {
    log.info("Discovering assets...", {
      tier:     filters.tier?.toString() ?? "all",
      maxPrice: filters.maxPrice?.toString() ?? "any",
    });

    try {
      let assetIds: bigint[];

      if (filters.tier !== undefined) {
        // Query by tier — uses NEXARRegistry.getAssetsByTier()
        const ids = await this.publicClient.readContract({
          address:      NEXAR_CONTRACTS.NEXARRegistry,
          abi:          REGISTRY_ABI,
          functionName: "getAssetsByTier",
          args:         [filters.tier],
        });
        assetIds = (ids as bigint[]);
      } else {
        // Get total count and iterate — for small registries
        const total = await this.publicClient.readContract({
          address:      NEXAR_CONTRACTS.NEXARRegistry,
          abi:          REGISTRY_ABI,
          functionName: "totalAssets",
        });
        assetIds = Array.from({ length: Number(total as bigint) }, (_, i) => BigInt(i + 1));
      }

      // Fetch each asset record
      const assets: DiscoveredAsset[] = [];

      for (const assetId of assetIds) {
        try {
          const rec = await this.publicClient.readContract({
            address:      NEXAR_CONTRACTS.NEXARRegistry,
            abi:          REGISTRY_ABI,
            functionName: "assets",
            args:         [assetId],
          }) as [HexAddress, bigint, number, HexAddress, bigint, boolean, string, string];

          const [ipId, vaultUuid, tier, owner, , active, name, assetType] = rec;

          if (!active) continue;

          // Apply filters
          if (filters.owner && owner.toLowerCase() !== filters.owner.toLowerCase()) continue;
          if (filters.nameContains && !name.toLowerCase().includes(filters.nameContains.toLowerCase())) continue;

          // Get pricing from DynamicPricingHook
          let currentPrice = 0n;
          let marketPrice  = 0n;
          try {
            [currentPrice, marketPrice] = await Promise.all([
              this.hooks.previewMintFee(ipId, buyer, 1),
              this.hooks.previewMintFee(ipId, ipId,  1), // use ipId as neutral buyer for market price
            ]);
          } catch { /* hook not yet configured for this asset */ }

          if (filters.maxPrice !== undefined && currentPrice > filters.maxPrice) continue;

          assets.push({
            assetId,
            ipId,
            vaultUuid,
            tier:         tier as AssetTier,
            owner,
            name,
            assetType,
            currentPrice,
            marketPrice,
          });
        } catch { continue; }
      }

      log.success("Discovery complete", { found: assets.length.toString() });
      return assets;
    } catch (err) {
      throw new NexarError("DISCOVERY_FAILED", "Asset discovery failed", { cause: err });
    }
  }

  /**
   * Look up a specific asset by IP ID.
   * Multi-user: read-only.
   */
  async findByIpId(ipId: HexAddress, buyer: HexAddress): Promise<DiscoveredAsset | null> {
    try {
      const rec = await this.publicClient.readContract({
        address:      NEXAR_CONTRACTS.NEXARRegistry,
        abi:          REGISTRY_ABI,
        functionName: "getAssetByIpId",
        args:         [ipId],
      }) as [HexAddress, bigint, number, HexAddress, bigint, boolean, string, string];

      const [recIpId, vaultUuid, tier, owner, assetId, active, name, assetType] = rec;
      if (!active) return null;

      const currentPrice = await this.hooks.previewMintFee(ipId, buyer, 1).catch(() => 0n);

      return {
        assetId:      BigInt(0), // NEXARRegistry returns assetId in index 4
        ipId:         recIpId,
        vaultUuid,
        tier:         tier as AssetTier,
        owner,
        name,
        assetType,
        currentPrice,
        marketPrice:  currentPrice,
      };
    } catch {
      return null;
    }
  }

  /**
   * Read PIL license terms for an IP Asset.
   * Used during negotiation to understand what terms are attached.
   */
  async readTerms(ipId: HexAddress): Promise<{ licenseTermsId: bigint } | null> {
    try {
      // Query Story API for attached license terms
      const response = await fetch(
        `https://api.storyapis.com/api/v4/licenses/ip/${ipId}/terms`,
        { headers: { "Content-Type": "application/json" } }
      );
      if (!response.ok) return null;
      const data = await response.json() as { data?: Array<{ licenseTermsId: string }> };
      const first = data.data?.[0];
      if (!first) return null;
      return { licenseTermsId: BigInt(first.licenseTermsId) };
    } catch {
      return null;
    }
  }

  /**
   * Get demand statistics for an IP Asset (how popular is it?).
   */
  async getDemandStats(ipId: HexAddress): Promise<{ demandCount: bigint; currentPrice: bigint }> {
    const [demandCount, currentPrice] = await Promise.all([
      this.hooks.getDemandCount(ipId).catch(() => 0n),
      this.hooks.previewMintFee(ipId, ipId, 1).catch(() => 0n),
    ]);
    return { demandCount, currentPrice };
  }
}
