// src/routes/spectrum.ts
// Photon Spectrum webhook endpoint — receives iMessage and WhatsApp events.
// Verifies HMAC-SHA256 signature, parses payload, routes to intent handler.
// Reply is sent via the spectrum-ts SDK instance (spectrumApp) in server.ts.

import { Router }              from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { asyncHandler }        from "../middleware/errorHandler.js";
import { routeMessage }        from "../messaging/router.js";
import { parseIMessageWebhook } from "../messaging/platforms/imessage.js";
import { parseWhatsAppWebhook, detectPlatform } from "../messaging/platforms/whatsapp.js";
import { sendIMessage }        from "../messaging/platforms/imessage.js";
import { sendWhatsApp }        from "../messaging/platforms/whatsapp.js";
import { createLogger }        from "../core/index.js";

const log = createLogger("SpectrumRoute");

export const spectrumRouter = Router();

// ─── Spectrum SDK app instance (set from server.ts after init) ─────────────
let _spectrumApp: any = null;

export function setSpectrumApp(app: any): void {
  _spectrumApp = app;
  log.info("Spectrum SDK app instance registered");
}

// ─── Signature verification ────────────────────────────────────────────────

const TOLERANCE_SEC = 5 * 60;

function verifySignature(
  rawBody:  string,
  secret:   string,
  sig:      string,
  ts:       string
): boolean {
  if (!rawBody || !secret || !sig || !ts) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
  if (!Number.isFinite(age) || age > TOLERANCE_SEC) {
    log.warn("Stale Spectrum timestamp", { age });
    return false;
  }

  const expected = "v0=" + createHmac("sha256", secret)
    .update(`v0:${ts}:${rawBody}`)
    .digest("hex");

  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ─── Dedup cache (in-memory, TTL ~2 min) ──────────────────────────────────
const seen = new Map<string, number>();
function isDuplicate(messageId: string): boolean {
  const now = Date.now();
  // Prune old entries
  for (const [k, t] of seen) {
    if (now - t > 2 * 60 * 1000) seen.delete(k);
  }
  if (seen.has(messageId)) return true;
  seen.set(messageId, now);
  return false;
}

// ─── POST /webhook/spectrum ────────────────────────────────────────────────
// express.raw() middleware must be applied BEFORE json() for this route.
// In server.ts: app.use("/webhook/spectrum", express.raw({ type: "application/json" }), spectrumRouter)

spectrumRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    // 1. Ack immediately — Photon retries on timeout
    res.status(200).send("ok");

    // 2. Verify signature (uses raw body from express.raw middleware)
    const rawBody  = (req.body as Buffer).toString("utf8");
    const secret   = process.env.SPECTRUM_SIGNING_SECRET ?? "";
    const sig      = (req.headers["x-spectrum-signature"] as string) ?? "";
    const ts       = (req.headers["x-spectrum-timestamp"] as string) ?? "";
    const event    = (req.headers["x-spectrum-event"]     as string) ?? "";

    // In dev mode (no secret configured), skip verification
    const devMode  = !secret;
    if (!devMode && !verifySignature(rawBody, secret, sig, ts)) {
      log.warn("Spectrum signature verification failed — dropping");
      return;
    }

    if (event !== "messages") {
      log.info("Non-message Spectrum event — ignoring", { event });
      return;
    }

    let payload: any;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      log.warn("Failed to parse Spectrum payload");
      return;
    }

    // 3. Detect platform
    const platform = detectPlatform(payload);
    if (!platform) return;

    // 4. Parse into normalised message
    let parsed;
    if (platform === "imessage") {
      parsed = parseIMessageWebhook(payload);
    } else if (platform === "whatsapp") {
      parsed = parseWhatsAppWebhook(payload);
    } else {
      return;
    }
    if (!parsed) return;

    // 5. Dedup
    if (isDuplicate(parsed.messageId)) {
      log.info("Duplicate Spectrum message — skipping", { id: parsed.messageId });
      return;
    }

    // 6. Build send function
    const sendFn = async (text: string): Promise<void> => {
      if (!_spectrumApp) {
        log.warn("Spectrum SDK not initialised — reply queued for dev mode", {
          to: parsed!.senderId,
          text: text.slice(0, 60),
        });
        return;
      }
      if (platform === "imessage") {
        await sendIMessage(_spectrumApp, parsed!.senderId, text);
      } else if (platform === "whatsapp") {
        await sendWhatsApp(_spectrumApp, parsed!.senderId, text);
      }
    };

    // 7. Route (async — response already sent)
    await routeMessage(parsed, sendFn);
  })
);
