// src/runtime/AccessVerifier.ts
// Single verification gate used by all runtime operations.
// Checks: session validity, license ownership, quota availability.
// Multi-user: every check is per-user, stateless, composable.

import type { PublicClient } from "viem";
import type { StoryClient }  from "@story-protocol/core-sdk";

import { STORY_CONTRACTS, MAX_COMPUTE_UNITS } from "../core/config.js";
import { NexarError }                         from "../core/errors.js";
import { createLogger }                        from "../core/logger.js";
import { SessionManager }                      from "../auth/SessionManager.js";
import type { HexAddress, SessionPayload, RuntimeQuota } from "../core/types.js";

const log = createLogger("AccessVerifier");

// ─── ABI fragments ────────────────────────────────────────────────────────────

const LICENSE_TOKEN_ABI = [
  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "getLicensorIpId",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "licenseTokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "getLicenseTermsId",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "licenseTokenId", type: "uint256" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const INFERENCE_CONDITION_ABI = [
  {
    name: "getComputeUsed",
    type: "function",
    stateMutability: "view",
    inputs:  [{ name: "caller", type: "address" }, { name: "ipId", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ─── AccessVerifier ───────────────────────────────────────────────────────────

export class AccessVerifier {
  private readonly publicClient:  PublicClient;
  private readonly sessionManager: SessionManager;

  constructor(publicClient: PublicClient, sessionManager: SessionManager) {
    this.publicClient   = publicClient;
    this.sessionManager = sessionManager;
  }

  // ─── Session verification ─────────────────────────────────────────────────

  /**
   * Verify a session token and return the decoded payload.
   * Multi-user: every session is independently verified — no shared state.
   * Throws NexarError if expired, revoked, or invalid.
   */
  verifySession(token: string): SessionPayload {
    return this.sessionManager.verifySession(token);
  }

  /**
   * Verify a session is for the correct vault UUID.
   */
  verifySessionForVault(token: string, vaultUuid: bigint): SessionPayload {
    const session = this.verifySession(token);

    if (session.vaultUuid !== undefined && session.vaultUuid !== vaultUuid) {
      throw new NexarError(
        "VAULT_ACCESS_DENIED",
        `Session is scoped to vault ${session.vaultUuid}, not ${vaultUuid}`
      );
    }

    return session;
  }

  // ─── License ownership verification ──────────────────────────────────────

  /**
   * Verify that an address holds a valid license token for an IP Asset.
   * Multi-user: checks on-chain state per (address, ipId) pair.
   *
   * @param holderAddress  - Address to check
   * @param ipId           - IP Asset the license must be for
   * @param licenseTokenIds - Token IDs to verify
   */
  async verifyLicenseOwnership(
    holderAddress:  HexAddress,
    ipId:           HexAddress,
    licenseTokenIds:bigint[]
  ): Promise<{ valid: boolean; validTokenId?: bigint }> {
    if (licenseTokenIds.length === 0) {
      return { valid: false };
    }

    for (const tokenId of licenseTokenIds) {
      try {
        // Check owner
        const owner = await this.publicClient.readContract({
          address:      STORY_CONTRACTS.LicenseToken as HexAddress,
          abi:          LICENSE_TOKEN_ABI,
          functionName: "ownerOf",
          args:         [tokenId],
        });

        if ((owner as string).toLowerCase() !== holderAddress.toLowerCase()) continue;

        // Check licensor IP
        const licensor = await this.publicClient.readContract({
          address:      STORY_CONTRACTS.LicenseToken as HexAddress,
          abi:          LICENSE_TOKEN_ABI,
          functionName: "getLicensorIpId",
          args:         [tokenId],
        });

        if ((licensor as string).toLowerCase() !== ipId.toLowerCase()) continue;

        log.debug("License ownership verified", {
          holder:  holderAddress,
          ipId,
          tokenId: tokenId.toString(),
        });

        return { valid: true, validTokenId: tokenId };
      } catch {
        continue;
      }
    }

    return { valid: false };
  }

  // ─── Quota verification ───────────────────────────────────────────────────

  /**
   * Check compute quota for an inference caller.
   * Multi-user: quota is per (caller, ipId) pair — each user tracked independently.
   *
   * @param caller     - User/agent address
   * @param ipId       - Inference IP Asset
   * @param maxUnits   - Max allowed units (from contract config)
   */
  async verifyQuota(
    caller:   HexAddress,
    ipId:     HexAddress,
    maxUnits: number = MAX_COMPUTE_UNITS
  ): Promise<RuntimeQuota> {
    try {
      const used = await this.publicClient.readContract({
        address:      STORY_CONTRACTS.LicenseToken as HexAddress, // InferenceAccessCondition addr
        abi:          INFERENCE_CONDITION_ABI,
        functionName: "getComputeUsed",
        args:         [caller, ipId],
      });

      const usedNum = Number(used as bigint);
      const quota: RuntimeQuota = {
        address:   caller,
        ipId,
        used:      usedNum,
        max:       maxUnits,
        remaining: Math.max(0, maxUnits - usedNum),
      };

      if (quota.remaining === 0) {
        throw new NexarError(
          "QUOTA_EXCEEDED",
          `Compute quota exceeded for ${caller}: ${usedNum}/${maxUnits} units used`,
          { context: { caller, ipId, used: usedNum, max: maxUnits } }
        );
      }

      return quota;
    } catch (err) {
      if (err instanceof NexarError) throw err;
      // Contract not yet deployed or call failed — allow access in dev
      log.warn("Quota check failed — allowing access (dev mode)", { caller, ipId });
      return { address: caller, ipId, used: 0, max: maxUnits, remaining: maxUnits };
    }
  }

  // ─── Combined access check ─────────────────────────────────────────────────

  /**
   * Full access check for a streaming or inference request:
   *   1. Verify session token
   *   2. Verify session is for the right vault
   *   3. Verify license ownership (if tokens provided)
   * Multi-user: every check is scoped to the specific user + asset.
   */
  async verifyFullAccess(params: {
    sessionToken:    string;
    vaultUuid:       bigint;
    ipId:            HexAddress;
    licenseTokenIds?:bigint[];
  }): Promise<SessionPayload> {
    const session = this.verifySessionForVault(params.sessionToken, params.vaultUuid);

    if (params.licenseTokenIds && params.licenseTokenIds.length > 0) {
      const { valid } = await this.verifyLicenseOwnership(
        session.address,
        params.ipId,
        params.licenseTokenIds
      );
      if (!valid) {
        throw new NexarError(
          "VAULT_ACCESS_DENIED",
          `${session.address} does not hold a valid license for ${params.ipId}`
        );
      }
    }

    log.debug("Full access verified", {
      user:  session.address,
      vault: params.vaultUuid.toString(),
      role:  session.role,
    });

    return session;
  }
}
