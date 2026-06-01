// src/messaging/intents/recover.ts
// Handle account recovery flow — initiate + verify code.

import {
  initiateRecovery,
  verifyRecovery,
  getRecoveryCode,
  getIdentity,
  type Platform,
} from "../../auth/IdentityManager.js";
import {
  recoveryInitMessage,
  recoveryCodeMessage,
  recoverySuccessMessage,
  mono,
} from "../formatter.js";
import { createLogger } from "../../core/index.js";

const log = createLogger("RecoverIntent");

// Store pending recovery usernames per (platform, senderId) in memory
// (short-lived, no need for DB — codes expire in 10 min anyway)
const pendingRecovery = new Map<string, string>();  // key: "platform:senderId" → username

/**
 * Handle "recover <username>" — send code to original platform.
 * The caller must also send the code via the original platform.
 */
export async function handleRecover(
  platform:   Platform,
  senderId:   string,
  text:       string,
  send:       (msg: string) => Promise<void>,
  sendToOriginal?: (platform: Platform, senderId: string, msg: string) => Promise<void>
): Promise<void> {
  const parts    = text.trim().split(/\s+/);
  const username = parts[1]?.toLowerCase();

  if (!username) {
    await send(`To recover your account, reply:\n${mono("recover <username>", platform)}`);
    return;
  }

  const result = initiateRecovery(username, platform, senderId);

  if (!result.ok) {
    switch (result.reason) {
      case "USERNAME_NOT_FOUND":
        await send(`❌ Username @${username} not found.`);
        break;
      default:
        await send(`❌ Recovery failed. Please try again.`);
    }
    return;
  }

  // Store pending recovery
  pendingRecovery.set(`${platform}:${senderId}`, username);

  // Get the recovery code to send to original platform
  const code = getRecoveryCode(username);

  // Notify user recovery has been initiated
  await send(recoveryInitMessage(username, result.originalPlatform!, platform));

  // If we can send to original platform, do it
  if (sendToOriginal && result.originalPlatform && result.originalId && code) {
    try {
      await sendToOriginal(
        result.originalPlatform,
        result.originalId,
        recoveryCodeMessage(code, result.originalPlatform)
      );
      log.info("Recovery code sent to original platform", {
        username,
        originalPlatform: result.originalPlatform,
      });
    } catch (err) {
      log.error("Failed to send recovery code to original platform", { username, err });
      // Still let user know to check their original platform
    }
  } else if (code) {
    // Dev mode: just include the code in the response for testing
    log.info("Recovery code (dev mode)", { username, code });
  }
}

/**
 * Handle "verify <code>" — complete recovery by linking new platform.
 */
export async function handleVerify(
  platform: Platform,
  senderId: string,
  text:     string,
  send:     (msg: string) => Promise<void>
): Promise<void> {
  const parts    = text.trim().split(/\s+/);
  const code     = parts[1];
  const key      = `${platform}:${senderId}`;
  const username = pendingRecovery.get(key);

  if (!code) {
    await send(`Please provide your 6-digit code:\n${mono("verify <code>", platform)}`);
    return;
  }

  if (!username) {
    await send(`No pending recovery. Start with:\n${mono("recover <username>", platform)}`);
    return;
  }

  const result = verifyRecovery(username, code);

  if (result.ok) {
    pendingRecovery.delete(key);
    await send(recoverySuccessMessage(username, platform));
  } else {
    switch (result.reason) {
      case "INVALID_CODE":
        await send(`❌ Invalid code. Please check and try again:\n${mono("verify <code>", platform)}`);
        break;
      case "NO_PENDING_RECOVERY":
        await send(`Recovery code expired. Please start again:\n${mono("recover " + username, platform)}`);
        pendingRecovery.delete(key);
        break;
      default:
        await send(`❌ Recovery failed. Please try again.`);
    }
  }
}
