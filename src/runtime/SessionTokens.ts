// src/runtime/SessionTokens.ts
// Short-lived signed JWT tokens for runtime vault access.
// Separate from auth/SessionManager — these are scoped specifically to
// runtime operations (streaming, inference) with tighter TTLs.
// Multi-user: each token is independently scoped to one user + one vault + one operation.

import jwt           from "jsonwebtoken";
import { randomUUID }from "node:crypto";
import { NexarError } from "../core/errors.js";
import { createLogger } from "../core/logger.js";
import type { HexAddress, SessionToken } from "../core/types.js";

const log = createLogger("SessionTokens");

// ─── Token TTLs (seconds) ─────────────────────────────────────────────────────

export const RUNTIME_TTL = {
  STREAM:    60 * 60 * 2,   // 2 hours  — streaming access
  INFERENCE: 60 * 30,       // 30 min   — single inference session
  PREVIEW:   60 * 5,        // 5 min    — quick preview / health check
} as const;

// ─── Token payload ────────────────────────────────────────────────────────────

export interface RuntimeTokenPayload {
  jti:       string;       // unique per token
  sub:       HexAddress;   // user address
  vault:     string;       // vault UUID (string for JWT compatibility)
  ipId:      HexAddress;
  op:        "stream" | "inference" | "preview";
  iat:       number;
  exp:       number;
}

// ─── Revocation store ─────────────────────────────────────────────────────────
// Multi-user: tracks revoked JTIs globally — each entry is independently revocable

const _revokedJtis = new Set<string>();

// ─── SessionTokens ────────────────────────────────────────────────────────────

export class SessionTokens {
  private readonly secret: string;

  constructor() {
    const s = process.env.JWT_SECRET;
    if (!s) throw new NexarError("MISSING_ENV", "JWT_SECRET not set");
    this.secret = s;
  }

  /**
   * Issue a runtime token for vault streaming.
   * Multi-user: each token is scoped to (address, vaultUuid, ipId).
   *
   * @param address   - User wallet address
   * @param vaultUuid - CDR vault UUID
   * @param ipId      - Story IP Asset ID
   * @param ttl       - Seconds until expiry
   */
  issueStreamToken(
    address:   HexAddress,
    vaultUuid: bigint,
    ipId:      HexAddress,
    ttl:       number = RUNTIME_TTL.STREAM
  ): SessionToken {
    return this._issue(address, vaultUuid, ipId, "stream", ttl);
  }

  /**
   * Issue a runtime token for inference execution.
   * Shorter TTL than stream tokens — each inference session is time-bounded.
   */
  issueInferenceToken(
    address:   HexAddress,
    vaultUuid: bigint,
    ipId:      HexAddress,
    ttl:       number = RUNTIME_TTL.INFERENCE
  ): SessionToken {
    return this._issue(address, vaultUuid, ipId, "inference", ttl);
  }

  /**
   * Verify a runtime token and return the payload.
   * Multi-user: each token verified independently.
   * Throws NexarError if invalid, expired, or revoked.
   */
  verify(token: string, expectedOp?: RuntimeTokenPayload["op"]): RuntimeTokenPayload {
    try {
      const payload = jwt.verify(token, this.secret) as RuntimeTokenPayload;

      if (_revokedJtis.has(payload.jti)) {
        throw new NexarError("SESSION_REVOKED", "Runtime token has been revoked");
      }

      if (expectedOp && payload.op !== expectedOp) {
        throw new NexarError(
          "SESSION_INVALID",
          `Token is for operation '${payload.op}', expected '${expectedOp}'`
        );
      }

      return payload;
    } catch (err) {
      if (err instanceof NexarError) throw err;
      const jwtErr = err as jwt.JsonWebTokenError;
      if (jwtErr.name === "TokenExpiredError") {
        throw new NexarError("SESSION_EXPIRED", "Runtime token has expired");
      }
      throw new NexarError("SESSION_INVALID", `Invalid runtime token: ${jwtErr.message}`);
    }
  }

  /**
   * Revoke a token before it expires.
   * Multi-user: revocation is per-JTI, does not affect other users' tokens.
   */
  revoke(token: string): void {
    try {
      const decoded = jwt.decode(token) as RuntimeTokenPayload | null;
      if (decoded?.jti) {
        _revokedJtis.add(decoded.jti);
        log.info("Runtime token revoked", { jti: decoded.jti, sub: decoded.sub });
      }
    } catch { /* silently ignore malformed tokens */ }
  }

  /**
   * Check if a token is valid without throwing.
   */
  isValid(token: string, expectedOp?: RuntimeTokenPayload["op"]): boolean {
    try { this.verify(token, expectedOp); return true; }
    catch { return false; }
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _issue(
    address:   HexAddress,
    vaultUuid: bigint,
    ipId:      HexAddress,
    op:        RuntimeTokenPayload["op"],
    ttl:       number
  ): SessionToken {
    const now = Math.floor(Date.now() / 1000);
    const jti = randomUUID();

    const payload: RuntimeTokenPayload = {
      jti,
      sub:   address,
      vault: vaultUuid.toString(),
      ipId,
      op,
      iat:   now,
      exp:   now + ttl,
    };

    const token = jwt.sign(payload, this.secret, { algorithm: "HS256" });

    log.debug("Runtime token issued", {
      sub:       address,
      vault:     vaultUuid.toString(),
      op,
      expiresAt: new Date((now + ttl) * 1000).toISOString(),
    });

    return { token, expiresAt: now + ttl, address };
  }
}
