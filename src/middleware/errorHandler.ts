// src/middleware/errorHandler.ts
// Global Express error handler — maps NexarError codes to HTTP status codes.

import type { Request, Response, NextFunction } from "express";
import { createLogger } from "../core/logger.js";

const log = createLogger("ErrorHandler");

// Map error codes to HTTP status codes
const STATUS_MAP: Record<string, number> = {
  MISSING_ENV:         500,
  VAULT_EMPTY:         404,
  VAULT_TIMEOUT:       504,
  VAULT_CREATE_FAILED: 500,
  VAULT_DECRYPT_FAILED:500,
  VAULT_ACCESS_DENIED: 403,
  SESSION_EXPIRED:     401,
  SESSION_REVOKED:     401,
  SESSION_INVALID:     401,
  WALLET_CREATE_FAILED:500,
  WALLET_SIGN_FAILED:  500,
  QUOTA_EXCEEDED:      429,
  GAS_RELAY_FAILED:    503,
  DISCOVERY_FAILED:    404,
};

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const code    = (err as { code?: string }).code ?? "INTERNAL_ERROR";
  const message = (err as Error).message ?? "An unexpected error occurred";
  const status  = STATUS_MAP[code] ?? 500;

  if (status >= 500) {
    log.error(`${req.method} ${req.path} → ${status}`, { code, message });
  } else {
    log.warn(`${req.method} ${req.path} → ${status}`, { code, message });
  }

  res.status(status).json({
    ok:      false,
    error:   code,
    message,
  });
}

export function notFound(req: Request, res: Response): void {
  res.status(404).json({ ok: false, error: "NOT_FOUND", message: `${req.method} ${req.path} not found` });
}

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
