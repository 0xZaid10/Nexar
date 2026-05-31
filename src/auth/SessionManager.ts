// src/auth/SessionManager.ts
// Persistent JWT session management via SQLite.
// Revocations survive restarts. Sessions scoped per (user, vault, role, TTL).

import jwt           from "jsonwebtoken";
import { randomUUID }from "node:crypto";

import { SESSION_TTL }   from "../core/config.js";
import { NexarError as CipherError }   from "../core/errors.js";
import { createLogger }  from "../core/logger.js";
import { getDB }         from "../db/index.js";
import type { SessionPayload, SessionToken, HexAddress } from "../core/types.js";

const log = createLogger("SessionManager");

function getSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) throw new CipherError("MISSING_ENV", "JWT_SECRET not set");
  return s;
}

export class SessionManager {

  createSession(params: {
    address:    HexAddress;
    role:       SessionPayload["role"];
    ttl:        number;
    assetId?:   bigint;
    vaultUuid?: bigint;
    ipId?:      HexAddress;
  }): SessionToken {
    const jti = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    const payload: Record<string, unknown> & { jti: string } = {
      address:   params.address,
      role:      params.role,
      assetId:   params.assetId   !== undefined ? params.assetId.toString()   : undefined,
      vaultUuid: params.vaultUuid !== undefined ? params.vaultUuid.toString() : undefined,
      ipId:      params.ipId,
      iat:       now,
      exp:       now + params.ttl,
      jti,
    };

    const token = jwt.sign(payload, getSecret(), { algorithm: "HS256" });

    // Persist to DB for revocation tracking
    const db = getDB();
    db.prepare(
      `INSERT INTO sessions (jti, address, vault_uuid, ip_id, role, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(jti, params.address, params.vaultUuid?.toString() ?? null, params.ipId ?? null, params.role, now + params.ttl);

    log.info("Session created", { address: params.address, role: params.role, ttl: params.ttl.toString() });
    return { token, expiresAt: now + params.ttl, address: params.address };
  }

  verifySession(token: string): SessionPayload {
    try {
      const raw = jwt.verify(token, getSecret()) as Record<string, unknown> & { jti?: string };

      // Check revocation in DB
      if (raw.jti) {
        const row = getDB().prepare("SELECT revoked FROM sessions WHERE jti = ?").get(raw.jti) as
          { revoked: number } | undefined;
        if (row?.revoked === 1) {
          throw new CipherError("SESSION_REVOKED", "Session has been revoked");
        }
      }

      return {
        address:   raw.address   as HexAddress,
        role:      raw.role      as SessionPayload["role"],
        assetId:   raw.assetId   !== undefined ? BigInt(raw.assetId   as string) : undefined,
        vaultUuid: raw.vaultUuid !== undefined ? BigInt(raw.vaultUuid as string) : undefined,
        ipId:      raw.ipId      as HexAddress | undefined,
        iat:       raw.iat       as number,
        exp:       raw.exp       as number,
      };
    } catch (err) {
      if (err instanceof CipherError) throw err;
      const jwtErr = err as jwt.JsonWebTokenError;
      if (jwtErr.name === "TokenExpiredError") throw new CipherError("SESSION_EXPIRED", "Session token has expired");
      throw new CipherError("SESSION_INVALID", `Invalid session token: ${jwtErr.message}`);
    }
  }

  revokeSession(token: string): void {
    try {
      const decoded = jwt.decode(token) as (SessionPayload & { jti?: string }) | null;
      if (decoded?.jti) {
        getDB().prepare("UPDATE sessions SET revoked = 1 WHERE jti = ?").run(decoded.jti);
        log.info("Session revoked", { address: decoded.address, jti: decoded.jti });
      }
    } catch { /* silently ignore */ }
  }

  revokeAllForAddress(address: HexAddress): number {
    const result = getDB().prepare(
      "UPDATE sessions SET revoked = 1 WHERE address = ? AND revoked = 0"
    ).run(address);
    log.info("All sessions revoked for address", { address, count: result.changes.toString() });
    return result.changes;
  }

  isValidSession(token: string): boolean {
    try { this.verifySession(token); return true; }
    catch { return false; }
  }

  createReviewerSession(params: { reviewerAddress: HexAddress; vaultUuid: bigint; ipId: HexAddress; ttl?: number }): SessionToken {
    return this.createSession({ address: params.reviewerAddress, role: "reviewer", ttl: params.ttl ?? SESSION_TTL.MEDIUM, vaultUuid: params.vaultUuid, ipId: params.ipId });
  }

  createAgentSession(params: { agentAddress: HexAddress; assetId: bigint; vaultUuid: bigint; ttl?: number }): SessionToken {
    return this.createSession({ address: params.agentAddress, role: "agent", ttl: params.ttl ?? SESSION_TTL.SHORT, assetId: params.assetId, vaultUuid: params.vaultUuid });
  }

  createInferenceSession(params: { agentAddress: HexAddress; ipId: HexAddress; vaultUuid: bigint; ttl?: number }): SessionToken {
    return this.createSession({ address: params.agentAddress, role: "inference", ttl: params.ttl ?? SESSION_TTL.SHORT, ipId: params.ipId, vaultUuid: params.vaultUuid });
  }

  // Admin: count active sessions
  countActive(): number {
    const now = Math.floor(Date.now() / 1000);
    const row = getDB().prepare(
      "SELECT COUNT(*) as n FROM sessions WHERE revoked = 0 AND expires_at > ?"
    ).get(now) as { n: number };
    return row.n;
  }

  // Cleanup expired sessions (call periodically)
  cleanupExpired(): number {
    const now    = Math.floor(Date.now() / 1000);
    const result = getDB().prepare("DELETE FROM sessions WHERE expires_at < ? - 86400").run(now);
    return result.changes;
  }
}
