// src/messaging/platforms/imessage.ts
// Parse and send iMessage via Photon Spectrum SDK.
// Receiving: webhook payload parsing (documented in photon_docs/webhooks/events.md)
// Sending: spectrum-ts SDK (imessage provider)

import { createHmac, timingSafeEqual } from "node:crypto";
import { createLogger } from "../../core/index.js";
import type { Platform } from "../formatter.js";

const log = createLogger("iMessage");

// ─── Webhook payload types ─────────────────────────────────────────────────

export interface IMessageWebhookPayload {
  event:   "messages";
  space: {
    id:       string;   // e.g. "any;-;+15551234567"
    platform: "iMessage";
    type:     "dm" | "group";
    phone:    string;   // the Photon line it arrived on, or "shared"
  };
  message: {
    id:        string;
    platform:  "iMessage";
    direction: "inbound";
    timestamp: string;  // ISO 8601
    sender: {
      id:       string;   // E.164 phone e.g. "+15551234567"
      platform: "iMessage";
    };
    content: IMessageContent;
  };
}

export type IMessageContent =
  | { type: "text";       text: string }
  | { type: "attachment"; id: string; name: string; mimeType: string; size?: number }
  | { type: "reaction";   emoji: string; target: { id: string; contentPreview?: string } }
  | { type: "group";      items: IMessageWebhookPayload["message"][] }
  | { type: string;       [key: string]: unknown };  // forward-compatible catch-all

// ─── Parsed incoming message ───────────────────────────────────────────────

export interface ParsedMessage {
  platform:     Platform;
  senderId:     string;   // E.164 phone
  spaceId:      string;   // Photon space id (used when sending reply)
  spacePhone:   string;   // which Photon line to reply on
  text:         string | null;
  attachment:   { id: string; name: string; mimeType: string; size?: number } | null;
  messageId:    string;   // for dedup
  isGroup:      boolean;
}

/**
 * Parse a Photon iMessage webhook payload into a normalised ParsedMessage.
 * Returns null for non-text/attachment content types we don't handle.
 */
export function parseIMessageWebhook(body: IMessageWebhookPayload): ParsedMessage | null {
  const { message, space } = body;

  // Skip outbound echoes (shouldn't happen but guard anyway)
  if (message.direction !== "inbound") return null;

  // Skip reactions — we don't handle them
  if (message.content.type === "reaction") return null;

  let text:       string | null = null;
  let attachment: ParsedMessage["attachment"] = null;

  switch (message.content.type) {
    case "text":
      text = message.content.text.trim();
      break;
    case "attachment":
      attachment = {
        id:       message.content.id,
        name:     message.content.name,
        mimeType: message.content.mimeType,
        size:     message.content.size,
      };
      break;
    default:
      // Unknown content type — log and skip
      log.info("Skipping unsupported content type", { type: message.content.type });
      return null;
  }

  return {
    platform:   "imessage",
    senderId:   message.sender.id,
    spaceId:    space.id,
    spacePhone: space.phone,
    text,
    attachment,
    messageId:  message.id,
    isGroup:    space.type === "group",
  };
}

// ─── Signature verification ────────────────────────────────────────────────

/**
 * Verify a Photon webhook signature.
 * Formula: v0= + HMAC-SHA256(signingSecret, "v0:" + timestamp + ":" + rawBody)
 * Documented in photon_docs/webhooks/verifying-signatures.md
 */
export function verifyPhotonSignature(
  rawBody:       string,
  signingSecret: string,
  signature:     string,
  timestamp:     string,
  toleranceSec   = 5 * 60
): boolean {
  if (!rawBody || !signingSecret || !signature || !timestamp) return false;

  // Reject stale timestamps
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSec) {
    log.warn("Stale webhook timestamp", { age });
    return false;
  }

  // Recompute HMAC
  const expected = "v0=" + createHmac("sha256", signingSecret)
    .update(`v0:${timestamp}:${rawBody}`)
    .digest("hex");

  // Constant-time comparison
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ─── Reply sender ──────────────────────────────────────────────────────────

/**
 * Send an iMessage reply via Photon Spectrum SDK.
 * The app instance is created once in server.ts and passed here.
 */
export async function sendIMessage(
  app:      any,  // Spectrum app instance (spectrum-ts)
  senderId: string,
  text:     string
): Promise<void> {
  try {
    // Import spectrum-ts iMessage provider dynamically
    const { imessage } = await import("spectrum-ts/providers/imessage");
    const im   = imessage(app);
    const user = await im.user(senderId);
    const dm   = await im.space(user);
    await dm.send(text);
    log.info("iMessage sent", { to: senderId, len: text.length });
  } catch (err) {
    log.error("Failed to send iMessage", { to: senderId, err });
    throw err;
  }
}
