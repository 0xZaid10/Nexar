// src/licensing/RoyaltyEngine.ts
// Royalty payment, claiming, and graph traversal.
// Confirmed against:
//   sdk-reference/royalty.md  (payRoyaltyOnBehalf, claimAllRevenue)
//   developers/typescript-sdk/pay-ipa.md
//   developers/typescript-sdk/claim-revenue.md

import type { StoryClient } from "@story-protocol/core-sdk";
import { zeroAddress, parseEther } from "viem";

import { TOKENS, STORY_CONTRACTS } from "../core/config.js";
import { NexarError }              from "../core/errors.js";
import { createLogger }             from "../core/logger.js";
import type { HexAddress, TxHash, RoyaltyNode } from "../core/types.js";

const log = createLogger("RoyaltyEngine");

export class RoyaltyEngine {
  private readonly story: ReturnType<typeof StoryClient.newClient>;

  constructor(storyClient: ReturnType<typeof StoryClient.newClient>) {
    this.story = storyClient;
  }

  // ─── Pay royalty ──────────────────────────────────────────────────────────

  /**
   * Pay royalties to an IP Asset on behalf of a payer IP.
   * Confirmed from sdk-reference/royalty.md payRoyaltyOnBehalf():
   *   { receiverIpId, payerIpId, token, amount }
   *
   * When payer is an external user (not an IP), use zeroAddress as payerIpId.
   * Multi-user: each pay call is independent — no shared state.
   *
   * @param receiverIpId - IP Asset receiving royalties
   * @param payerIpId    - IP Asset paying (or zeroAddress for external payer)
   * @param amount       - Amount in WIP (18 decimals)
   */
  async pay(
    receiverIpId: HexAddress,
    payerIpId:    HexAddress | null,
    amount:       bigint
  ): Promise<TxHash> {
    log.info("Paying royalty...", {
      receiver: receiverIpId,
      payer:    payerIpId ?? "external",
      amount:   amount.toString(),
    });

    try {
      const result = await this.story.royalty.payRoyaltyOnBehalf({
        receiverIpId,
        payerIpId:  (payerIpId ?? zeroAddress) as HexAddress,
        token:      TOKENS.WIP,
        amount,
      });

      log.success("Royalty paid", {
        receiver: receiverIpId,
        txHash:   result.txHash,
      });

      return result.txHash as TxHash;
    } catch (err) {
      throw new NexarError(
        "ROYALTY_PAY_FAILED",
        `Failed to pay royalty to ${receiverIpId}`,
        { cause: err }
      );
    }
  }

  // ─── Claim all revenue ────────────────────────────────────────────────────

  /**
   * Claim all accrued revenue for an ancestor IP from its derivatives.
   * Confirmed from sdk-reference/royalty.md claimAllRevenue():
   *   { ancestorIpId, claimer, childIpIds, royaltyPolicies, currencyTokens }
   *
   * Multi-user: permissionless — any wallet can trigger claim for any IP.
   *
   * @param ancestorIpId  - The IP whose revenue vault to claim from
   * @param childIpIds    - Derivative IPs that generated the revenue
   */
  async claimAll(
    ancestorIpId: HexAddress,
    childIpIds:   HexAddress[]
  ): Promise<{ txHash?: TxHash }> {
    log.info("Claiming all revenue...", {
      ancestor: ancestorIpId,
      children: childIpIds.length.toString(),
    });

    try {
      const result = await this.story.royalty.claimAllRevenue({
        ancestorIpId,
        claimer:         ancestorIpId,     // IP Account holds royalty tokens by default
        childIpIds,
        royaltyPolicies: childIpIds.map(() => STORY_CONTRACTS.RoyaltyPolicyLAP as HexAddress),
        currencyTokens:  [TOKENS.WIP],
        claimOptions: {
          autoTransferAllClaimedTokensFromIp: true,
          autoUnwrapIpTokens:                 false,
        },
      });

      log.success("Revenue claimed", {
        ancestor: ancestorIpId,
        txHash:   result.txHash ?? "n/a",
      });

      return { txHash: result.txHash as TxHash | undefined };
    } catch (err) {
      throw new NexarError(
        "ROYALTY_CLAIM_FAILED",
        `Failed to claim revenue for ${ancestorIpId}`,
        { cause: err }
      );
    }
  }

  // ─── Get claimable amount ─────────────────────────────────────────────────

  /**
   * Get the claimable WIP amount for an IP's royalty vault.
   * Multi-user: read-only, no auth required.
   */
  async getClaimable(ipId: HexAddress): Promise<bigint> {
    try {
      const result = await this.story.royalty.claimableRevenue({
        claimer: ipId,
        token:   TOKENS.WIP,
      });
      return BigInt(result ?? 0);
    } catch {
      return 0n;
    }
  }

  // ─── Simulate revenue flow ────────────────────────────────────────────────

  /**
   * Simulate how revenue would be distributed through the royalty graph.
   * Pure calculation — no on-chain transaction.
   * Shows exactly how much each node in the chain receives.
   *
   * @param chain  - Ordered list of (ipId, revShare%) from leaf to root
   * @param amount - Total revenue to distribute (WIP, 18 decimals)
   */
  simulateDistribution(
    chain: Array<{ ipId: HexAddress; revSharePct: number }>,
    amount: bigint
  ): Map<HexAddress, bigint> {
    const result = new Map<HexAddress, bigint>();
    let remaining = amount;

    // LAP: each ancestor takes their % of the ORIGINAL amount (not of remainder)
    for (const node of chain) {
      const share = (amount * BigInt(Math.round(node.revSharePct * 1e6))) / BigInt(100 * 1e6);
      result.set(node.ipId, share);
      remaining -= share;
    }

    // Final node keeps the remainder
    if (chain.length > 0) {
      const last = chain[chain.length - 1]!;
      result.set(last.ipId, (result.get(last.ipId) ?? 0n) + remaining);
    }

    return result;
  }

  // ─── Build royalty graph ──────────────────────────────────────────────────

  /**
   * Build a visual royalty node tree from a known derivative chain.
   * Used by demo/run.ts to display the royalty flow diagram.
   */
  buildGraphFromChain(
    chain: Array<{ ipId: HexAddress; name: string; revSharePct: number }>
  ): RoyaltyNode {
    if (chain.length === 0) throw new NexarError("ROYALTY_GRAPH_BUILD_FAILED", "Empty chain");

    // Build tree bottom-up: leaf is last element, root is first
    let current: RoyaltyNode = {
      ipId:     chain[chain.length - 1]!.ipId,
      name:     chain[chain.length - 1]!.name,
      revShare: chain[chain.length - 1]!.revSharePct,
      children: [],
    };

    for (let i = chain.length - 2; i >= 0; i--) {
      const node: RoyaltyNode = {
        ipId:     chain[i]!.ipId,
        name:     chain[i]!.name,
        revShare: chain[i]!.revSharePct,
        children: [current],
      };
      current = node;
    }

    return current;
  }

  // ─── Print royalty graph ───────────────────────────────────────────────────

  /**
   * Print the royalty flow graph to the terminal (for demo output).
   */
  printGraph(root: RoyaltyNode, indent = 0): void {
    const pad = "  ".repeat(indent);
    const arrow = indent === 0 ? "" : "└─ ";
    log.info(`${pad}${arrow}${root.name ?? root.ipId} [${root.revShare}% upstream]`);
    for (const child of root.children) {
      this.printGraph(child, indent + 1);
    }
  }
}
