// src/auth/DelegationStore.ts
// EIP-712 session delegation store.
// Users sign once in the Mini App — server uses delegation to call CDR on their behalf.
// Delegation = "I authorize NEXAR to decrypt files on my behalf until X"

import { verifyTypedData }  from "viem";
import { getDB }            from "../db/index.js";
import { createLogger }     from "../core/logger.js";
import type { HexAddress }  from "../core/types.js";

const log = createLogger("DelegationStore");

// ─── EIP-712 domain + types ───────────────────────────────────────────────────

export const DELEGATION_DOMAIN = {
  name:    "NEXAR",
  version: "1",
  chainId: 1315,  // Aeneid
} as const;

export const DELEGATION_TYPES = {
  NexarDelegation: [
    { name: "username",  type: "string"  },
    { name: "action",    type: "string"  },
    { name: "validUntil",type: "uint256" },
  ],
} as const;

export interface DelegationPayload {
  username:   string;
  action:     "nexar_access";
  validUntil: bigint;
}

export interface StoredDelegation {
  username:      string;
  walletAddress: string;
  signature:     string;
  validUntil:    number;
  createdAt:     number;
}

// ─── DelegationStore ──────────────────────────────────────────────────────────

export class DelegationStore {

  /**
   * Verify and store a user's EIP-712 delegation.
   * Called from POST /api/auth/delegate (Mini App submits after signing).
   */
  async store(params: {
    username:      string;
    walletAddress: string;
    signature:     string;
    validUntil:    number;
  }): Promise<{ ok: boolean; reason?: string }> {

    const { username, walletAddress, signature, validUntil } = params;

    // 1. Sanity check expiry
    const now = Math.floor(Date.now() / 1000);
    if (validUntil <= now) return { ok: false, reason: "DELEGATION_EXPIRED" };
    if (validUntil > now + 30 * 24 * 3600) return { ok: false, reason: "DELEGATION_TOO_LONG" }; // max 30 days

    // 2. Verify EIP-712 signature
    try {
      const valid = await verifyTypedData({
        address:     walletAddress as HexAddress,
        domain:      DELEGATION_DOMAIN,
        types:       DELEGATION_TYPES,
        primaryType: "NexarDelegation",
        message: {
          username,
          action:     "nexar_access" as const,
          validUntil: BigInt(validUntil),
        },
        signature: signature as `0x${string}`,
      });

      if (!valid) return { ok: false, reason: "INVALID_SIGNATURE" };
    } catch (err) {
      log.warn("Delegation signature verification failed", { username, err });
      return { ok: false, reason: "SIGNATURE_VERIFY_FAILED" };
    }

    // 3. Store in DB (upsert — replaces existing delegation for this user)
    try {
      getDB().prepare(`
        INSERT OR REPLACE INTO delegations
          (username, wallet_address, signature, valid_until, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(username, walletAddress.toLowerCase(), signature, validUntil, now);

      log.success("Delegation stored", { username, validUntil: new Date(validUntil * 1000).toISOString() });
      return { ok: true };
    } catch (err) {
      log.error("Failed to store delegation", { username, err });
      return { ok: false, reason: "DB_ERROR" };
    }
  }

  /**
   * Check if a user has a valid (non-expired) delegation.
   * Called before every CDR read operation.
   */
  hasValidDelegation(username: string): boolean {
    const now = Math.floor(Date.now() / 1000);
    const row = getDB().prepare(
      "SELECT 1 FROM delegations WHERE username = ? AND valid_until > ? LIMIT 1"
    ).get(username, now);
    return !!row;
  }

  /**
   * Get stored delegation for a user.
   */
  getDelegation(username: string): StoredDelegation | null {
    const now = Math.floor(Date.now() / 1000);
    const row = getDB().prepare(
      "SELECT * FROM delegations WHERE username = ? AND valid_until > ?"
    ).get(username, now) as any;
    if (!row) return null;
    // Normalize DB snake_case to camelCase
    return {
      username:      row.username,
      walletAddress: row.wallet_address,
      signature:     row.signature,
      validUntil:    Number(row.valid_until),
      createdAt:     Number(row.created_at),
      valid_until:   Number(row.valid_until),  // keep both for compat
    } as StoredDelegation;
  }

  /**
   * Revoke a delegation (user requested or expired).
   */
  revoke(username: string): void {
    getDB().prepare("DELETE FROM delegations WHERE username = ?").run(username);
    log.info("Delegation revoked", { username });
  }

  /**
   * Get expiry info for a user's delegation.
   */
  getExpiryInfo(username: string): { valid: boolean; expiresAt?: string; daysLeft?: number } {
    const d = this.getDelegation(username);
    if (!d) return { valid: false };
    const validUntil = Number(d.valid_until ?? (d as any).validUntil ?? 0);
    const daysLeft   = Math.ceil((validUntil - Math.floor(Date.now() / 1000)) / 86400);
    let expiresAt: string | undefined;
    try { expiresAt = new Date(validUntil * 1000).toISOString(); } catch { expiresAt = undefined; }
    return { valid: true, expiresAt, daysLeft };
  }
}

export const delegationStore = new DelegationStore();
