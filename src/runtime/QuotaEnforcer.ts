// src/runtime/QuotaEnforcer.ts
// On-chain quota enforcement via InferenceAccessCondition contract.
// Reads compute usage from the contract (incremented by CDR validators on each read).
// Local cache reduces chain reads — 30s TTL.

import type { PublicClient } from "viem";
import { NEXAR_CONTRACTS, MAX_COMPUTE_UNITS } from "../core/config.js";
import { NexarError as CipherError }          from "../core/errors.js";
import { createLogger }                        from "../core/logger.js";
import type { HexAddress, RuntimeQuota }       from "../core/types.js";

const log = createLogger("QuotaEnforcer");

const INFERENCE_CONDITION_ABI = [
  {
    name:             "getComputeUsed",
    type:             "function",
    stateMutability:  "view",
    inputs:           [{ name: "caller", type: "address" }, { name: "ipId", type: "address" }],
    outputs:          [{ type: "uint256" }],
  },
] as const;

function cacheKey(caller: HexAddress, ipId: HexAddress): string {
  return `${caller.toLowerCase()}:${ipId.toLowerCase()}`;
}

export class QuotaEnforcer {
  private readonly publicClient: PublicClient;
  private readonly maxUnits:     number;
  private readonly _cache = new Map<string, { used: number; fetchedAt: number }>();
  private readonly CACHE_TTL_MS = 30_000;

  constructor(publicClient: PublicClient, maxUnits = MAX_COMPUTE_UNITS) {
    this.publicClient = publicClient;
    this.maxUnits     = maxUnits;
  }

  /**
   * Check quota for a (caller, ipId) pair.
   * Reads from InferenceAccessCondition on-chain — this is the source of truth.
   * The contract itself increments on every CDR read (done by validators).
   * Throws QUOTA_EXCEEDED if at or over limit.
   */
  async check(caller: HexAddress, ipId: HexAddress): Promise<RuntimeQuota> {
    const used = await this.getUsedUnits(caller, ipId);

    if (used >= this.maxUnits) {
      throw new CipherError(
        "QUOTA_EXCEEDED",
        `Inference quota exhausted for ${ipId} (${used}/${this.maxUnits} used)`
      );
    }

    return {
      address:   caller,
      ipId,
      used,
      max:       this.maxUnits,
      remaining: this.maxUnits - used,
    };
  }

  async getUsedUnits(caller: HexAddress, ipId: HexAddress): Promise<number> {
    const key    = cacheKey(caller, ipId);
    const cached = this._cache.get(key);
    const now    = Date.now();

    if (cached && now - cached.fetchedAt < this.CACHE_TTL_MS) {
      return cached.used;
    }

    const conditionAddr = NEXAR_CONTRACTS.InferenceAccessCondition;
    if (!conditionAddr) {
      log.warn("InferenceAccessCondition address not set — quota not enforced on-chain");
      return 0;
    }

    try {
      const used = await this.publicClient.readContract({
        address:      conditionAddr,
        abi:          INFERENCE_CONDITION_ABI,
        functionName: "getComputeUsed",
        args:         [caller, ipId],
      });

      const usedNum = Number(used as bigint);
      this._cache.set(key, { used: usedNum, fetchedAt: now });
      return usedNum;
    } catch (err) {
      if (err instanceof CipherError) throw err;
      log.warn("Could not read quota from chain — using 0", { caller, ipId, err: String(err) });
      return 0;
    }
  }

  /**
   * Optimistically increment local cache after inference.
   * The real on-chain increment happens inside InferenceAccessCondition.checkReadCondition()
   * called by CDR validators. This keeps our local cache in sync.
   */
  incrementLocalCache(caller: HexAddress, ipId: HexAddress): void {
    const key    = cacheKey(caller, ipId);
    const cached = this._cache.get(key);
    if (cached) {
      cached.used++;
    } else {
      this._cache.set(key, { used: 1, fetchedAt: Date.now() });
    }
    log.debug("Local quota cache incremented", { caller, ipId, newUsed: (cached?.used ?? 1).toString() });
  }

  invalidateCache(caller: HexAddress, ipId: HexAddress): void {
    this._cache.delete(cacheKey(caller, ipId));
  }

  getAllQuotas(): Array<{ caller: string; ipId: string; used: number }> {
    return [...this._cache.entries()].map(([key, val]) => {
      const [caller, ipId] = key.split(":");
      return { caller: caller ?? "", ipId: ipId ?? "", used: val.used };
    });
  }
}
