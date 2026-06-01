// src/messaging/platforms/telegram.ts
// Parse, send, and deliver files via Telegram Bot API.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createLogger } from "../../core/index.js";
import type { Platform } from "../formatter.js";

const log          = createLogger("Telegram");
const TELEGRAM_API = "https://api.telegram.org";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface TelegramUpdate {
  update_id: number;
  message?:  TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  from: { id: number; is_bot: boolean; first_name: string; username?: string; };
  chat: { id: number; type: "private" | "group" | "supergroup" | "channel"; username?: string; };
  date:      number;
  text?:     string;
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number; };
  photo?:    Array<{ file_id: string; width: number; height: number; file_size?: number; }>;
  audio?:    { file_id: string; file_name?: string; mime_type?: string; duration: number; };
  video?:    { file_id: string; file_name?: string; mime_type?: string; duration: number; file_size?: number; };
}

export interface ParsedMessage {
  platform:   Platform;
  senderId:   string;
  spaceId:    string;
  text:       string | null;
  attachment: { id: string; name: string; mimeType: string; size?: number; } | null;
  messageId:  string;
  username:   string | null;
}

// ─── Parse webhook ─────────────────────────────────────────────────────────

export function parseTelegramWebhook(update: TelegramUpdate): ParsedMessage | null {
  const msg = update.message;
  if (!msg || msg.from.is_bot) return null;
  if (msg.chat.type !== "private") return null;

  const chatId   = msg.chat.id.toString();
  const senderId = `telegram:${chatId}`;

  let text:       string | null = null;
  let attachment: ParsedMessage["attachment"] = null;

  if (msg.text) {
    text = msg.text.trim();
  } else if (msg.document) {
    attachment = { id: msg.document.file_id, name: msg.document.file_name ?? "file", mimeType: msg.document.mime_type ?? "application/octet-stream", size: msg.document.file_size };
  } else if (msg.photo) {
    const photo = msg.photo[msg.photo.length - 1];
    attachment  = { id: photo.file_id, name: "photo.jpg", mimeType: "image/jpeg", size: photo.file_size };
  } else if (msg.audio) {
    attachment = { id: msg.audio.file_id, name: msg.audio.file_name ?? "audio", mimeType: msg.audio.mime_type ?? "audio/mpeg" };
  } else if (msg.video) {
    attachment = { id: msg.video.file_id, name: msg.video.file_name ?? "video.mp4", mimeType: msg.video.mime_type ?? "video/mp4", size: msg.video.file_size };
  } else {
    return null;
  }

  return { platform: "telegram", senderId, spaceId: chatId, text, attachment, messageId: `tg-${update.update_id}`, username: msg.from.username ?? null };
}

// ─── Signature verification ────────────────────────────────────────────────

export function verifyTelegramSecret(headerSecret: string | undefined, expectedSecret: string): boolean {
  if (!expectedSecret) return true;
  if (!headerSecret)   return false;
  const a = Buffer.from(expectedSecret);
  const b = Buffer.from(headerSecret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ─── Send text ─────────────────────────────────────────────────────────────

/** Strip HTML tags for plain text Telegram messages */
function stripHtml(text: string): string {
  return text
    .replace(/<b>(.*?)<\/b>/gs, '$1')
    .replace(/<code>(.*?)<\/code>/gs, '$1')
    .replace(/<\/?(b|code|i|em)>/g, '');
}

export async function sendTelegram(botToken: string, chatId: string, text: string): Promise<void> {
  const url = `${TELEGRAM_API}/bot${botToken}/sendMessage`;
  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ chat_id: chatId, text: stripHtml(text) }),
  });
  if (!res.ok) {
    const err = await res.text();
    log.error("Telegram send failed", { chatId, status: res.status, err });
    throw new Error(`Telegram API error: ${res.status} ${err}`);
  }
  log.info("Telegram message sent", { chatId, len: text.length });
}

// ─── Send file ─────────────────────────────────────────────────────────────

/**
 * Send a file buffer to a Telegram chat using sendDocument.
 * Works for any file type — images, PDFs, CSVs, etc.
 */
export async function sendTelegramFile(
  botToken: string,
  chatId:   string,
  buffer:   Buffer,
  fileName: string,
  mimeType: string,
  caption:  string
): Promise<void> {
  const url      = `${TELEGRAM_API}/bot${botToken}/sendDocument`;
  const formData = new FormData();

  formData.append("chat_id", chatId);
  formData.append("caption", caption.slice(0, 1024));  // Telegram caption limit
  formData.append(
    "document",
    new Blob([buffer], { type: mimeType }),
    fileName
  );

  const res = await fetch(url, { method: "POST", body: formData });

  if (!res.ok) {
    const err = await res.text();
    log.error("Telegram file send failed", { chatId, fileName, status: res.status, err });
    throw new Error(`Telegram sendDocument error: ${res.status} ${err}`);
  }

  log.info("Telegram file sent", { chatId, fileName, sizeBytes: buffer.length });
}

// ─── Download file from Telegram ───────────────────────────────────────────

/**
 * Download a file from Telegram servers using its file_id.
 * Steps: getFile → get file_path → download from cdn.
 */
export async function downloadTelegramFile(botToken: string, fileId: string): Promise<Buffer | null> {
  try {
    // Step 1: Get file path
    const infoRes = await fetch(`${TELEGRAM_API}/bot${botToken}/getFile?file_id=${fileId}`);
    if (!infoRes.ok) {
      log.warn("getFile failed", { fileId, status: infoRes.status });
      return null;
    }

    const info = await infoRes.json() as { ok: boolean; result?: { file_path: string } };
    if (!info.ok || !info.result?.file_path) {
      log.warn("getFile returned no path", { fileId });
      return null;
    }

    // Step 2: Download file
    const dlUrl = `${TELEGRAM_API}/file/bot${botToken}/${info.result.file_path}`;
    const dlRes = await fetch(dlUrl);
    if (!dlRes.ok) {
      log.warn("File download failed", { fileId, status: dlRes.status });
      return null;
    }

    const arrayBuffer = await dlRes.arrayBuffer();
    const buffer      = Buffer.from(arrayBuffer);
    log.info("Telegram file downloaded", { fileId, sizeBytes: buffer.length });
    return buffer;

  } catch (err) {
    log.error("downloadTelegramFile error", { fileId, err });
    return null;
  }
}

// ─── Register webhook ───────────────────────────────────────────────────────

export async function registerTelegramWebhook(botToken: string, webhookUrl: string, secretToken: string): Promise<void> {
  const url  = `${TELEGRAM_API}/bot${botToken}/setWebhook`;
  const res  = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ url: webhookUrl, secret_token: secretToken, allowed_updates: ["message"] }),
  });
  const data = await res.json() as { ok: boolean; description?: string };
  if (!data.ok) throw new Error(`setWebhook failed: ${data.description}`);
  log.success("Telegram webhook registered", { url: webhookUrl });
}
