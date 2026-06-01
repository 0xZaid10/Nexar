// src/routes/telegram.ts
// Telegram Bot API webhook — full file send/receive support.

import { Router }         from "express";
import { asyncHandler }   from "../middleware/errorHandler.js";
import { routeMessage }   from "../messaging/router.js";
import {
  parseTelegramWebhook,
  verifyTelegramSecret,
  sendTelegram,
  sendTelegramFile,
  downloadTelegramFile,
  registerTelegramWebhook,
  type TelegramUpdate,
} from "../messaging/platforms/telegram.js";
import { getUsernameByPlatform } from "../auth/IdentityManager.js";
import { getDB }          from "../db/index.js";
import { createLogger }   from "../core/index.js";

const log = createLogger("TelegramRoute");

export const telegramRouter = Router();

// ─── Dedup ─────────────────────────────────────────────────────────────────

const seen = new Map<string, number>();
function isDuplicate(id: string): boolean {
  const now = Date.now();
  for (const [k, t] of seen) { if (now - t > 2 * 60 * 1000) seen.delete(k); }
  if (seen.has(id)) return true;
  seen.set(id, now);
  return false;
}

// ─── POST /webhook/telegram ────────────────────────────────────────────────

telegramRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    res.status(200).send("ok");

    const secretToken  = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
    const headerSecret = req.headers["x-telegram-bot-api-secret-token"] as string | undefined;
    if (secretToken && !verifyTelegramSecret(headerSecret, secretToken)) {
      log.warn("Telegram secret mismatch — dropping");
      return;
    }

    const update   = req.body as TelegramUpdate;
    if (!update?.update_id) return;
    if (isDuplicate(update.update_id.toString())) return;

    const parsed = parseTelegramWebhook(update);
    if (!parsed) return;

    log.info("Telegram message received", { from: parsed.senderId, text: parsed.text?.slice(0, 40), hasFile: !!parsed.attachment });

    const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
    if (!botToken) { log.warn("TELEGRAM_BOT_TOKEN not set — reply suppressed"); return; }

    const chatId = parsed.spaceId;

    // ── send text ──────────────────────────────────────────────────────────
    const sendFn = async (text: string): Promise<void> => {
      await sendTelegram(botToken, chatId, text);
    };

    // ── send file ──────────────────────────────────────────────────────────
    const sendFileFn = async (buffer: Buffer, fileName: string, mimeType: string, caption: string): Promise<void> => {
      await sendTelegramFile(botToken, chatId, buffer, fileName, mimeType, caption);
    };

    // ── download file from Telegram ────────────────────────────────────────
    const getFileFn = async (fileId: string): Promise<Buffer | null> => {
      return downloadTelegramFile(botToken, fileId);
    };

    // ── send to another user by username ───────────────────────────────────
    const sendToUserFn = async (targetUsername: string, text: string): Promise<void> => {
      // Look up target's Telegram chat_id from platform_identities
      const db  = getDB();
      const row = db.prepare(
        "SELECT platform_id FROM platform_identities WHERE username = ? AND platform = 'telegram' LIMIT 1"
      ).get(targetUsername) as { platform_id: string } | undefined;

      if (!row) {
        log.warn("Cannot notify user — no Telegram identity", { targetUsername });
        return;
      }

      const targetChatId = row.platform_id.replace("telegram:", "");
      await sendTelegram(botToken, targetChatId, text);
    };

    await routeMessage(parsed, {
      send:       sendFn,
      sendFile:   sendFileFn,
      getFile:    getFileFn,
      sendToUser: sendToUserFn,
    });
  })
);

// ─── POST /webhook/telegram/register ──────────────────────────────────────

telegramRouter.post(
  "/register",
  asyncHandler(async (req, res) => {
    const botToken    = process.env.TELEGRAM_BOT_TOKEN ?? "";
    const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET ?? "";

    if (!botToken) {
      res.status(400).json({ ok: false, error: "TELEGRAM_BOT_TOKEN not set" });
      return;
    }

    const { webhookUrl } = req.body as { webhookUrl?: string };
    if (!webhookUrl) {
      res.status(400).json({ ok: false, error: "webhookUrl required" });
      return;
    }

    await registerTelegramWebhook(botToken, webhookUrl, secretToken);
    res.json({ ok: true, webhookUrl });
  })
);
