// src/auth/AccessDelegate.ts
// Delegates IP Account permissions to other addresses using Story's AccessController.
// Multi-user: each delegation is scoped to (ipId, delegate, module, ttl).
// Uses setPermission from sdk-reference/permissions.md.
// Enables: grant reviewer access to IP Account actions without full ownership transfer.

import type { StoryClient } from "@story-protocol/core-sdk";
import { zeroAddress }       from "viem";

import { STORY_CONTRACTS }   from "../core/config.js";
import { NexarError }       from "../core/errors.js";
import { createLogger }      from "../core/logger.js";
import type { HexAddress, TxHash, DelegateConfig } from "../core/types.js";

const log = createLogger("AccessDelegate");

// ─── Permission levels (from sdk-reference/permissions.md) ───────────────────
// 0 = ABSTAIN (default), 1 = ALLOW, 2 = DENY

export const Permission = {
  ABSTAIN: 0,
  ALLOW:   1,
  DENY:    2,
} as const;

// ─── Active delegations store (in-memory, replace with DB in production) ──────
// Multi-user: tracks all active delegations per IP Asset

interface DelegationRecord {
  ipId:      HexAddress;
  delegate:  HexAddress;
  moduleAddr:HexAddress;
  fnSelector:string;
  grantedAt: number;
  expiresAt: number;   // Unix timestamp, 0 = no expiry
  txHash:    TxHash;
}

const _delegations = new Map<string, DelegationRecord>(); // key: `${ipId}:${delegate}`

// ─── AccessDelegate ───────────────────────────────────────────────────────────

export class AccessDelegate {
  private readonly story: ReturnType<typeof StoryClient.newClient>;

  constructor(storyClient: ReturnType<typeof StoryClient.newClient>) {
    this.story = storyClient;
  }

  /**
   * Grant a delegate address permission to act on behalf of an IP Account.
   * Multi-user: each delegation is independent and TTL-scoped.
   *
   * Confirmed from sdk-reference/permissions.md setPermission():
   *   ipId:       IP that grants the permission
   *   signer:     address being granted permission
   *   to:         module address (or zeroAddress for all modules)
   *   permission: 1 = ALLOW
   *   func:       function selector (optional, omit for all functions)
   *
   * @param config - DelegateConfig (see core/types.ts)
   */
  async grantAccess(config: DelegateConfig): Promise<TxHash> {
    log.info("Granting access delegation...", {
      ipId:     config.ipId,
      delegate: config.delegate,
      module:   config.moduleAddr,
      ttl:      config.ttl.toString(),
    });

    try {
      // Grant specific module permission
      // Confirmed from sdk-reference/permissions.md setPermission params
      const response = await this.story.permissions.setPermission({
        ipId:       config.ipId,
        signer:     config.delegate,
        to:         config.moduleAddr,
        permission: Permission.ALLOW,
        func:       config.fnSelector || undefined,
      });

      const txHash = response.txHash as TxHash;
      const now    = Date.now();

      // Record delegation for TTL enforcement
      const key = `${config.ipId}:${config.delegate}`;
      _delegations.set(key, {
        ipId:       config.ipId,
        delegate:   config.delegate,
        moduleAddr: config.moduleAddr,
        fnSelector: config.fnSelector,
        grantedAt:  now,
        expiresAt:  config.ttl > 0 ? now + config.ttl * 1000 : 0,
        txHash,
      });

      log.success("Access delegated", {
        ipId:     config.ipId,
        delegate: config.delegate,
        txHash,
      });

      return txHash;
    } catch (err) {
      throw new NexarError(
        "DELEGATE_FAILED",
        `Failed to delegate access for ${config.ipId} to ${config.delegate}`,
        { cause: err }
      );
    }
  }

  /**
   * Grant wildcard permission — delegate can call ALL modules on behalf of IP Account.
   * Use with care. Confirmed from sdk-reference/permissions.md setAllPermissions().
   *
   * @param ipId      - IP Asset to grant permissions on
   * @param delegate  - Address receiving all permissions
   */
  async grantWildcardAccess(ipId: HexAddress, delegate: HexAddress): Promise<TxHash> {
    log.warn("Granting WILDCARD access — delegate can call all modules", {
      ipId,
      delegate,
    });

    try {
      const response = await this.story.permissions.setAllPermissions({
        ipId,
        signer:     delegate,
        permission: Permission.ALLOW,
      });

      log.success("Wildcard access granted", { ipId, delegate, txHash: response.txHash });
      return response.txHash as TxHash;
    } catch (err) {
      throw new NexarError(
        "DELEGATE_FAILED",
        `Failed to grant wildcard access for ${ipId} to ${delegate}`,
        { cause: err }
      );
    }
  }

  /**
   * Revoke a delegate's permission on an IP Account.
   * Sets permission to DENY — explicit deny overrides any wildcard ALLOW.
   * Multi-user: revocation only affects the specific (ipId, delegate) pair.
   */
  async revokeAccess(ipId: HexAddress, delegate: HexAddress, moduleAddr?: HexAddress): Promise<TxHash> {
    log.info("Revoking access delegation...", { ipId, delegate });

    try {
      const response = await this.story.permissions.setPermission({
        ipId,
        signer:     delegate,
        to:         moduleAddr ?? (zeroAddress as HexAddress),
        permission: Permission.DENY,
      });

      // Remove from delegation store
      _delegations.delete(`${ipId}:${delegate}`);

      log.success("Access revoked", { ipId, delegate, txHash: response.txHash });
      return response.txHash as TxHash;
    } catch (err) {
      throw new NexarError(
        "DELEGATE_FAILED",
        `Failed to revoke access for ${ipId} from ${delegate}`,
        { cause: err }
      );
    }
  }

  /**
   * Check if a delegation is still active (not expired).
   * Multi-user: checks per (ipId, delegate) pair independently.
   */
  isDelegationActive(ipId: HexAddress, delegate: HexAddress): boolean {
    const key    = `${ipId}:${delegate}`;
    const record = _delegations.get(key);
    if (!record)                            return false;
    if (record.expiresAt === 0)             return true;  // no expiry
    return Date.now() < record.expiresAt;
  }

  /**
   * Clean up expired delegations (revoke on-chain).
   * Call periodically from a background job in production.
   */
  async cleanupExpiredDelegations(): Promise<void> {
    const now     = Date.now();
    const expired = [..._delegations.entries()]
      .filter(([, r]) => r.expiresAt > 0 && now >= r.expiresAt);

    for (const [key, record] of expired) {
      log.info("Cleaning up expired delegation...", {
        ipId:     record.ipId,
        delegate: record.delegate,
      });
      try {
        await this.revokeAccess(record.ipId, record.delegate, record.moduleAddr);
      } catch (err) {
        log.warn("Failed to revoke expired delegation", { key, err: String(err) });
      }
    }
  }

  /**
   * Get all active delegations for an IP Asset.
   * Multi-user: returns all delegates across all users for a given IP.
   */
  getActiveDelegations(ipId: HexAddress): DelegationRecord[] {
    const now = Date.now();
    return [..._delegations.values()].filter(
      (r) => r.ipId === ipId && (r.expiresAt === 0 || now < r.expiresAt)
    );
  }
}
