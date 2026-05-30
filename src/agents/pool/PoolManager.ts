// src/agents/pool/PoolManager.ts
// Group IP intelligence pool: create, add members, distribute royalties.
// Wraps Story groupClient SDK — confirmed from sdk-reference/group.md.
// Multi-user: each pool has one owner, multiple contributor members.
// EvenSplitGroupPool auto-splits all downstream royalties equally.

import type { StoryClient }   from "@story-protocol/core-sdk";
import { zeroAddress }         from "viem";

import {
  STORY_CONTRACTS,
  TOKENS,
  REV_SHARE,
} from "../../core/config.js";
import { NexarError }         from "../../core/errors.js";
import { createLogger }        from "../../core/logger.js";
import { PILBuilder }          from "../../licensing/PILBuilder.js";
import type {
  HexAddress,
  TxHash,
  PoolRecord,
  PoolMember,
} from "../../core/types.js";

const log = createLogger("PoolManager");

// ─── Pool result types ────────────────────────────────────────────────────────

export interface CreatePoolResult {
  groupId:   HexAddress;      // Story Group IP ID
  txHash?:   TxHash;
}

export interface PoolStats {
  groupId:      HexAddress;
  memberCount:  number;
  members:      PoolMember[];
  claimable:    bigint;
}

// ─── PoolManager ─────────────────────────────────────────────────────────────

export class PoolManager {
  private readonly story:      ReturnType<typeof StoryClient.newClient>;
  private readonly pilBuilder: PILBuilder;
  private readonly owner:      HexAddress;

  // In-memory pool records — multi-user: each pool independently tracked
  private readonly _pools = new Map<HexAddress, PoolRecord>();

  constructor(
    storyClient:  ReturnType<typeof StoryClient.newClient>,
    ownerAddress: HexAddress
  ) {
    this.story      = storyClient;
    this.pilBuilder = new PILBuilder();
    this.owner      = ownerAddress;
  }

  // ─── Create pool ──────────────────────────────────────────────────────────

  /**
   * Create a Group IP intelligence pool with EvenSplitGroupPool and attach PIL terms.
   * Uses registerGroupAndAttachLicense() — confirmed from sdk-reference/group.md.
   *
   * Multi-user: each pool is owned by one address, but members can be any IPs.
   *
   * @param name      - Human-readable pool name
   * @param revShare  - Revenue share percentage (%) passed upstream by the pool
   */
  async createPool(params: {
    name:     string;
    revShare: number;
  }): Promise<CreatePoolResult> {
    log.separator(`Creating pool: ${params.name}`);

    const terms = this.pilBuilder.commercialRemix(
      "0.1",           // pool minting fee
      params.revShare
    );

    try {
      // Confirmed from sdk-reference/group.md registerGroupAndAttachLicense():
      //   groupPool: EvenSplitGroupPool address
      const response = await this.story.groupClient.registerGroupAndAttachLicense({
        groupPool:        STORY_CONTRACTS.EvenSplitGroupPool as HexAddress,
        licenseTermsId:   undefined as unknown as string, // registered inline
        licenseTermsData: {
          terms,
          licensingConfig: this.pilBuilder.buildLicensingConfig({
            hookAddress:  zeroAddress as `0x${string}`,
            mintingFee:   "0.1",
            revSharePct:  params.revShare,
          }),
        },
      } as Parameters<typeof this.story.groupClient.registerGroupAndAttachLicense>[0]);

      const groupId = response.groupId as HexAddress;

      // Record pool
      const record: PoolRecord = {
        poolId:    0n,
        groupIpId: groupId,
        memberIds: [],
        owner:     this.owner,
        createdAt: BigInt(Date.now()),
        active:    true,
        name:      params.name,
      };
      this._pools.set(groupId, record);

      log.success("Pool created", {
        groupId,
        txHash: response.txHash ?? "n/a",
      });

      return { groupId, txHash: response.txHash as TxHash | undefined };
    } catch (err) {
      throw new NexarError("POOL_CREATE_FAILED", `Failed to create pool: ${params.name}`, { cause: err });
    }
  }

  // ─── Add members ──────────────────────────────────────────────────────────

  /**
   * Add IP Assets to an existing pool.
   * Confirmed from sdk-reference/group.md addIpsToGroup():
   *   { groupId, ipIds[] }
   *
   * Multi-user: any IP owner can add their IP to a pool they're eligible for.
   * The IP must have compatible license terms attached.
   *
   * @param groupId   - Group IP ID (from createPool)
   * @param ipIds     - IP Asset IDs to add as members
   * @param termsId   - License terms ID attached to each IP (must match pool terms)
   */
  async addMembers(
    groupId:  HexAddress,
    ipIds:    HexAddress[],
    termsId:  bigint
  ): Promise<TxHash> {
    log.info("Adding members to pool...", {
      groupId,
      count:   ipIds.length.toString(),
      members: ipIds.join(", "),
    });

    try {
      const response = await this.story.groupClient.addIpsToGroup({
        groupId,
        ipIds,
        licenseTermsId:   termsId.toString(),
        maxAllowedRewardShare: 100,
      } as Parameters<typeof this.story.groupClient.addIpsToGroup>[0]);

      // Update local record
      const pool = this._pools.get(groupId);
      if (pool) {
        ipIds.forEach((_, i) => pool.memberIds.push(BigInt(i)));
      }

      log.success("Members added", { groupId, count: ipIds.length.toString() });
      return response.txHash as TxHash;
    } catch (err) {
      throw new NexarError("POOL_ADD_MEMBER_FAILED", `Failed to add members to pool ${groupId}`, { cause: err });
    }
  }

  // ─── Distribute royalties ─────────────────────────────────────────────────

  /**
   * Collect royalties from pool members and distribute to contributors.
   * Confirmed from sdk-reference/group.md collectAndDistributeGroupRoyalties():
   *   { groupId, currencyTokens, memberIpIds }
   *
   * Multi-user: distribution is automatic via EvenSplitGroupPool.
   * Any address can call this — it is permissionless.
   */
  async distributeRoyalties(
    groupId:    HexAddress,
    memberIpIds:HexAddress[]
  ): Promise<TxHash> {
    log.info("Distributing pool royalties...", {
      groupId,
      members: memberIpIds.length.toString(),
    });

    try {
      const response = await this.story.groupClient.collectAndDistributeGroupRoyalties({
        groupId,
        currencyTokens: [TOKENS.WIP],
        memberIpIds,
      });

      log.success("Royalties distributed", {
        groupId,
        txHash: response.txHash ?? "n/a",
      });

      return response.txHash as TxHash;
    } catch (err) {
      throw new NexarError("POOL_DISTRIBUTE_FAILED", `Failed to distribute royalties for pool ${groupId}`, { cause: err });
    }
  }

  // ─── Get claimable rewards ────────────────────────────────────────────────

  /**
   * Get claimable reward amounts for a list of IP Assets in the pool.
   * Confirmed from sdk-reference/group.md getClaimableReward().
   */
  async getClaimableRewards(
    groupId:     HexAddress,
    memberIpIds: HexAddress[]
  ): Promise<bigint[]> {
    try {
      const rewards = await this.story.groupClient.getClaimableReward({
        groupId,
        currencyToken: TOKENS.WIP,
        memberIpIds,
      });
      return (rewards as bigint[]) ?? [];
    } catch {
      return memberIpIds.map(() => 0n);
    }
  }

  // ─── Claim rewards for a member ───────────────────────────────────────────

  /**
   * Claim reward for specific member IPs in the pool.
   * Confirmed from sdk-reference/group.md claimReward().
   */
  async claimReward(
    groupId:     HexAddress,
    memberIpIds: HexAddress[]
  ): Promise<TxHash> {
    const response = await this.story.groupClient.claimReward({
      groupId,
      currencyToken: TOKENS.WIP,
      memberIpIds,
    });
    return response.txHash as TxHash;
  }

  // ─── Query ────────────────────────────────────────────────────────────────

  getPool(groupId: HexAddress): PoolRecord | undefined {
    return this._pools.get(groupId);
  }

  getAllPools(): PoolRecord[] {
    return [...this._pools.values()];
  }
}
