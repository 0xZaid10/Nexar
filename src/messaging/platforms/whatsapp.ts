// src/messaging/platforms/whatsapp.ts
// Parse and send WhatsApp messages via Photon Spectrum / WhatsApp Business Cloud API.
// Photon delivers WhatsApp events via the same webhook format as iMessage.
// Sending uses the WhatsApp Business client from @photon-ai/advanced-whatsapp or
// the Photon REST API (to avoid a separate long-lived process).

import { createLogger } from "../../core/index.js";
import type { Platform } from "../formatter.js";

const log = createLogger("WhatsApp");

// ─── Webhook payload types ─────────────────────────────────────────────────
// WhatsApp via Photon uses the same envelope as iMessage but with platform = "WhatsApp"
// and sender.id = WA contact id (phone in E.164 format: +15551234567)

export interface WhatsAppWebhookPayload {
  event:   "messages";
  space: {
    id:       string;
    platform: "WhatsApp";
  };
  message: {
    id:        string;
    platform:  "WhatsApp";
    direction: "inbound";
    timestamp: string;
    sender: {
      id:       string;  // E.164 phone or WA contact id
      platform: "WhatsApp";
    };
    content: WhatsAppContent;
  };
}

export type WhatsAppContent =
  | { type: "text";       text: string }
  | { type: "attachment"; id: string; name: string; mimeType: string; size?: number }
  | { type: "reaction";   emoji: string; target: { id: string } }
  | { type: string;       [key: string]: unknown };

// ─── Parsed incoming message ───────────────────────────────────────────────

export interface ParsedMessage {
  platform:   Platform;
  senderId:   string;
  spaceId:    string;
  text:       string | null;
  attachment: { id: string; name: string; mimeType: string; size?: number } | null;
  messageId:  string;
}

/**
 * Parse a Photon WhatsApp webhook payload into a normalised ParsedMessage.
 */
export function parseWhatsAppWebhook(body: WhatsAppWebhookPayload): ParsedMessage | null {
  const { message, space } = body;

  if (message.direction !== "inbound") return null;
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
      log.info("Skipping unsupported WhatsApp content type", { type: message.content.type });
      return null;
  }

  return {
    platform:   "whatsapp",
    senderId:   message.sender.id,
    spaceId:    space.id,
    text,
    attachment,
    messageId:  message.id,
  };
}

// ─── Reply sender ──────────────────────────────────────────────────────────

/**
 * Send a WhatsApp reply via Photon Spectrum SDK.
 */
export async function sendWhatsApp(
  app:      any,  // Spectrum app instance
  senderId: string,
  text:     string
): Promise<void> {
  try {
    const { whatsapp } = await import("spectrum-ts/providers/whatsapp-business");
    const wa   = whatsapp(app);
    const user = await wa.user(senderId);
    const dm   = await wa.space(user);
    await dm.send(text);
    log.info("WhatsApp sent", { to: senderId, len: text.length });
  } catch (err) {
    log.error("Failed to send WhatsApp", { to: senderId, err });
    throw err;
  }
}

// ─── Platform detection ────────────────────────────────────────────────────

/**
 * Detect platform from Photon webhook payload.
 * Returns "imessage" | "whatsapp" based on message.platform field.
 */
export function detectPlatform(payload: any): Platform | null {
  const platform = payload?.message?.platform ?? payload?.space?.platform;
  if (!platform) return null;
  switch (platform.toLowerCase()) {
    case "imessage": return "imessage";
    case "whatsapp": return "whatsapp";
    default:
      log.warn("Unknown platform in webhook", { platform });
      return null;
  }
}
