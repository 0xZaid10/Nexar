// src/messaging/intents/help.ts
// Help and share-file intent handlers.

import { createLogger }  from "../../core/index.js";
import { getWalletAddress } from "../../auth/IdentityManager.js";
import type { Platform } from "../formatter.js";
import { helpMessage, shareFileMessage, errorMessage } from "../formatter.js";
import type { ParsedMessage } from "../router.js";

const log = createLogger("HelpIntent");

// ─── Help ──────────────────────────────────────────────────────────────────

export async function handleHelp(
  username: string | null,
  platform: Platform,
  send:     (msg: string) => Promise<void>
): Promise<void> {
  await send(helpMessage(platform));
}

// ─── Share File ────────────────────────────────────────────────────────────

/**
 * User sent a file attachment. Guide them through registering it as NEXAR IP.
 * For now, tell them to use the API or web app to complete registration —
 * full in-message file ingestion requires downloading the attachment bytes,
 * which needs a running spectrum-ts instance (separate from the webhook handler).
 *
 * TODO: integrate with spectrum-ts SDK to download attachment bytes and
 * call POST /api/asset/register on their behalf.
 */
export async function handleShareFile(
  username: string,
  platform: Platform,
  msg:      ParsedMessage,
  send:     (reply: string) => Promise<void>
): Promise<void> {
  const { attachment } = msg;

  if (!attachment) {
    await send(shareFileMessage(platform));
    return;
  }

  try {
    const address = await getWalletAddress(username);
    const fileName = attachment.name ?? "file";
    const mimeType = attachment.mimeType ?? "application/octet-stream";
    const sizeMB   = attachment.size ? ` (${(attachment.size / 1024 / 1024).toFixed(2)} MB)` : "";

    log.info("File received for IP registration", {
      username,
      platform,
      fileName,
      mimeType,
      attachmentId: attachment.id,
    });

    // TODO: Download attachment bytes via spectrum-ts SDK and call asset register API
    // For now, acknowledge receipt and guide user
    const reply = [
      `📁 File received: ${fileName}${sizeMB}`,
      ``,
      `To register *${fileName}* as your IP on NEXAR:`,
      ``,
      `1. Visit https://app.nexar.io`,
      `2. Connect with username @${username}`,
      `3. Upload this file and set your price`,
      ``,
      `Your wallet: ${address?.slice(0, 10)}...${address?.slice(-6)}`,
      ``,
      `Full in-message registration coming soon! 🚀`,
    ].join("\n");

    await send(reply);
  } catch (err) {
    log.error("Share file intent failed", { username, err });
    await send(errorMessage(platform));
  }
}
