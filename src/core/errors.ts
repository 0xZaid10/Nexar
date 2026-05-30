// src/core/errors.ts
// Typed error classes for every NEXAR failure mode.
// Every module throws NexarError — callers catch and check the code.

export type NexarErrorCode =
  // ── Vault errors ────────────────────────────────────────────────────────
  | "VAULT_CREATE_FAILED"
  | "VAULT_ACCESS_DENIED"
  | "VAULT_NOT_FOUND"
  | "VAULT_EMPTY"
  | "VAULT_DECRYPT_FAILED"
  | "VAULT_UPDATE_FORBIDDEN"
  | "VAULT_TIMEOUT"
  | "VAULT_INSUFFICIENT_PARTIALS"
  // ── Asset / IP errors ───────────────────────────────────────────────────
  | "ASSET_REGISTER_FAILED"
  | "ASSET_NOT_FOUND"
  | "ASSET_ALREADY_REGISTERED"
  | "ASSET_DELISTED"
  | "IP_REGISTER_FAILED"
  | "METADATA_UPLOAD_FAILED"
  // ── Licensing errors ────────────────────────────────────────────────────
  | "LICENSE_TERMS_REGISTER_FAILED"
  | "LICENSE_ATTACH_FAILED"
  | "LICENSE_MINT_FAILED"
  | "LICENSE_NOT_FOUND"
  | "LICENSE_EXPIRED"
  | "LICENSE_CONFIG_FAILED"
  | "DERIVATIVE_REGISTER_FAILED"
  // ── Royalty errors ──────────────────────────────────────────────────────
  | "ROYALTY_PAY_FAILED"
  | "ROYALTY_CLAIM_FAILED"
  | "ROYALTY_GRAPH_BUILD_FAILED"
  // ── Auth errors ─────────────────────────────────────────────────────────
  | "SESSION_CREATE_FAILED"
  | "SESSION_INVALID"
  | "SESSION_EXPIRED"
  | "SESSION_REVOKED"
  | "WALLET_CREATE_FAILED"
  | "WALLET_SIGN_FAILED"
  | "GAS_RELAY_FAILED"
  | "DELEGATE_FAILED"
  | "PERMISSION_DENIED"
  // ── Runtime errors ──────────────────────────────────────────────────────
  | "STREAM_FAILED"
  | "INFERENCE_FAILED"
  | "QUOTA_EXCEEDED"
  | "QUOTA_CHECK_FAILED"
  | "ACCESS_VERIFY_FAILED"
  // ── Agent / negotiation errors ──────────────────────────────────────────
  | "DISCOVERY_FAILED"
  | "NEGOTIATION_REJECTED"
  | "NEGOTIATION_TIMEOUT"
  | "SETTLEMENT_FAILED"
  | "POOL_CREATE_FAILED"
  | "POOL_ADD_MEMBER_FAILED"
  | "POOL_DISTRIBUTE_FAILED"
  // ── Config / setup errors ───────────────────────────────────────────────
  | "MISSING_ENV"
  | "CONTRACTS_NOT_DEPLOYED"
  | "CLIENT_INIT_FAILED"
  | "UNSUPPORTED_TIER"
  | "INVALID_PARAMS";

export class NexarError extends Error {
  public readonly code:    NexarErrorCode;
  public readonly cause?:  unknown;
  public readonly context?: Record<string, unknown>;

  constructor(
    code:     NexarErrorCode,
    message:  string,
    options?: { cause?: unknown; context?: Record<string, unknown> }
  ) {
    super(message);
    this.name    = "NexarError";
    this.code    = code;
    this.cause   = options?.cause;
    this.context = options?.context;

    // Maintains proper stack trace in V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, NexarError);
    }
  }

  toString(): string {
    return `[NexarError:${this.code}] ${this.message}`;
  }

  toJSON(): Record<string, unknown> {
    return {
      name:    this.name,
      code:    this.code,
      message: this.message,
      context: this.context,
    };
  }
}

// ─── Convenience factory functions ───────────────────────────────────────────

export const Errors = {
  vaultAccessDenied:  (uuid: bigint, cause?: unknown) =>
    new NexarError("VAULT_ACCESS_DENIED",  `Access denied to vault ${uuid}`, { cause, context: { uuid: uuid.toString() } }),

  vaultTimeout:       (uuid: bigint) =>
    new NexarError("VAULT_TIMEOUT",        `Vault ${uuid} decryption timed out — validators did not respond in time`, { context: { uuid: uuid.toString() } }),

  vaultEmpty:         (uuid: bigint) =>
    new NexarError("VAULT_EMPTY",          `Vault ${uuid} has never been written to`, { context: { uuid: uuid.toString() } }),

  quotaExceeded:      (address: string, ipId: string, used: number, max: number) =>
    new NexarError("QUOTA_EXCEEDED",       `Compute quota exceeded for ${address} on ${ipId}: used ${used}/${max}`, { context: { address, ipId, used, max } }),

  sessionExpired:     (token: string) =>
    new NexarError("SESSION_EXPIRED",      "Session token has expired", { context: { token: token.slice(0, 20) + "..." } }),

  sessionInvalid:     (reason: string) =>
    new NexarError("SESSION_INVALID",      `Invalid session token: ${reason}`),

  missingEnv:         (vars: string[]) =>
    new NexarError("MISSING_ENV",          `Missing required environment variables: ${vars.join(", ")}`, { context: { vars } }),

  contractsNotDeployed: (names: string[]) =>
    new NexarError("CONTRACTS_NOT_DEPLOYED", `NEXAR contracts not deployed: ${names.join(", ")}. Run: npm run deploy`, { context: { names } }),

  invalidParams:      (message: string) =>
    new NexarError("INVALID_PARAMS",       message),

  negotiationRejected:(id: string, reason: string) =>
    new NexarError("NEGOTIATION_REJECTED", `Negotiation ${id} rejected: ${reason}`, { context: { id, reason } }),

  permissionDenied:   (action: string, address: string) =>
    new NexarError("PERMISSION_DENIED",    `${address} is not authorized to: ${action}`, { context: { action, address } }),
} as const;

// ─── Type guard ───────────────────────────────────────────────────────────────

export function isNexarError(err: unknown): err is NexarError {
  return err instanceof NexarError;
}
