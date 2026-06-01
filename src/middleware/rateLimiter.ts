// src/middleware/rateLimiter.ts
// Rate limiting middleware — prevents abuse of expensive endpoints.
// Different limits per route type.

import rateLimit from "express-rate-limit";

const IS_DEV = process.env.NODE_ENV !== "production";

// General API — 60 requests per minute per IP
export const apiLimiter = rateLimit({
  windowMs:         60 * 1000,
  max:              IS_DEV ? 1000 : 60,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { ok: false, error: "RATE_LIMITED", message: "Too many requests — try again in a minute" },
});

// Wallet creation — 5 per minute (Privy API calls are expensive)
export const walletLimiter = rateLimit({
  windowMs:         60 * 1000,
  max:              IS_DEV ? 100 : 5,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { ok: false, error: "RATE_LIMITED", message: "Too many wallet creation requests" },
});

// Asset registration — 10 per minute (on-chain tx, Pinata upload)
export const assetLimiter = rateLimit({
  windowMs:         60 * 1000,
  max:              IS_DEV ? 100 : 10,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { ok: false, error: "RATE_LIMITED", message: "Too many asset registration requests" },
});

// Spectrum webhook — 120 per minute (messages can come fast)
export const spectrumLimiter = rateLimit({
  windowMs:         60 * 1000,
  max:              IS_DEV ? 10000 : 120,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { ok: false, error: "RATE_LIMITED", message: "Webhook rate limit exceeded" },
});
