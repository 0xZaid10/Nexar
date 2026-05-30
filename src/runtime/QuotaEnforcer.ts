// src/runtime/QuotaEnforcer.ts
// Enforces inference compute quotas before every runtime call.
// Reads InferenceAccessCondition on-chain state.
// Multi-user: quota tracking is per (caller, ipId) — fully isolated per user.

import type { PublicClient } from "viem";
import { NEXAR_CONTRACTS, MAX_COMPUTE_UNITS } from "../core/config.js";
import { NexarError }                          from "../core/errors.js";
import { createLogger }                         from "../core/logger.js";
import type { HexAddress, RuntimeQuota }        from "../core/types.js";

const log = createLogger("QuotaEnforcer");

// ─── ABI ─────────────────────────────────────────────────────────────────────

const INFERENCE_CONDITION_ABI = [
  {
    name: "getComputeUsed",
    type: "function",
    stateMutability: "view",
    inputs:  [
      { name: "caller", type: "address" },
      { name: "ipId",   type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

function cacheKey(caller: HexAddress, ipId: HexAddress): string {
  return `${caller.toLowerCase()}:${ipId.toLowerCase()}`;
}

// ─── QuotaEnforcer ────────────────────────────────────────────────────────────

export class QuotaEnforcer {
  private readonly publicClient: PublicClient;
  private readonly maxUnits:     number;
  // Instance-level cache — each QuotaEnforcer instance has its own cache
  // This ensures test isolation (each test creates a fresh instance)
  private readonly _cache = new Map<string, { used: number; fetchedAt: number }>();
  private readonly CACHE_TTL_MS = 30_000;

  constructor(publicClient: PublicClient, maxUnits = MAX_COMPUTE_UNITS) {
    this.publicClient = publicClient;
    this.maxUnits     = maxUnits;
  }

  /**
   * Check quota and throw if exceeded.
   * Does NOT decrement — decrement happens on-chain in InferenceAccessCondition
   * when accessCDR() is called. This is a pre-flight check.
   * Multi-user: reads chain state per (caller, ipId).
   *
   * @param caller - Agent/user address requesting inference
   * @param ipId   - Inference IP Asset being accessed
   */
  async check(caller: HexAddress, ipId: HexAddress): Promise<RuntimeQuota> {
    const used = await this.getUsedUnits(caller, ipId);
    const remaining = Math.max(0, this.maxUnits - used);

    const quota: RuntimeQuota = {
      address:   caller,
      ipId,
      used,
      max:       this.maxUnits,
      remaining,
    };

    if (remaining === 0) {
      throw new NexarError(
        "QUOTA_EXCEEDED",
        `Inference quota exhausted for ${caller} on ${ipId}: ${used}/${this.maxUnits} units used`,
        { context: { caller, ipId, used, max: this.maxUnits } }
      );
    }

    log.debug("Quota check passed", {
      caller,
      ipId,
      used:      used.toString(),
      remaining: remaining.toString(),
    });

    return quota;
  }

  /**
   * Get used compute units from on-chain InferenceAccessCondition.
   * Uses local cache (30s TTL) to avoid hammering the chain.
   * Multi-user: each (caller, ipId) pair has its own cache entry.
   */
  async getUsedUnits(caller: HexAddress, ipId: HexAddress): Promise<number> {
    const key     = cacheKey(caller, ipId);
    const cached  = this._cache.get(key);
    const now     = Date.now();

    // Return cached value if fresh
    if (cached && now - cached.fetchedAt < this.CACHE_TTL_MS) {
      return cached.used;
    }

    try {
      const used = await this.publicClient.readContract({
        address:      NEXAR_CONTRACTS.InferenceAccessCondition,
        abi:          INFERENCE_CONDITION_ABI,
        functionName: "getComputeUsed",
        args:         [caller, ipId],
      });

      const usedNum = Number(used as bigint);
      this._cache.set(key, { used: usedNum, fetchedAt: now });
      return usedNum;
    } catch (err) {
      // Re-throw NexarErrors — don't swallow them
      if (err instanceof NexarError) throw err;
      // Contract not yet deployed — return 0 (dev mode)
      log.warn("Could not read quota from chain — using 0 (dev mode)", { caller, ipId });
      return 0;
    }
  }

  incrementLocalCache(caller: HexAddress, ipId: HexAddress): void {
    const key    = cacheKey(caller, ipId);
    const cached = this._cache.get(key);
    if (cached) {
      cached.used++;
      log.debug("Local quota cache incremented", {
        caller,
        ipId,
        newUsed: cached.used.toString(),
      });
    } else {
      // Initialize cache entry if not present
      this._cache.set(key, { used: 1, fetchedAt: Date.now() });
    }
  }

  invalidateCache(caller: HexAddress, ipId: HexAddress): void {
    this._cache.delete(cacheKey(caller, ipId));
    log.debug("Quota cache invalidated", { caller, ipId });
  }

  getAllQuotas(): Array<{ caller: string; ipId: string; used: number }> {
    return [...this._cache.entries()].map(([key, val]) => {
      const [caller, ipId] = key.split(":");
      return { caller: caller ?? "", ipId: ipId ?? "", used: val.used };
    });
  }
}
