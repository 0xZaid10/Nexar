// src/messaging/intents/register.ts
// Username registration — grants pending shares automatically on success.

import {
  registerUsername,
  isUsernameAvailable,
  getUsernameByPlatform,
  type Platform,
} from "../../auth/IdentityManager.js";
import { grantPendingShares } from "../flows/shareAccess.flow.js";
import {
  welcomeMessage, usernameTakenMessage, usernameInvalidMessage,
  registrationSuccessMessage, alreadyRegisteredMessage, mono,
} from "../formatter.js";
import { createLogger } from "../../core/index.js";

const log = createLogger("RegisterIntent");
const USERNAME_RE = /^[a-z0-9_]{3,20}$/;

export async function handleRegister(
  platform:          Platform,
  senderId:          string,
  text:              string,
  send:              (msg: string) => Promise<void>,
  telegramUsername?: string | null
): Promise<void> {
  const existing = getUsernameByPlatform(platform, senderId);
  if (existing) { await send(alreadyRegisteredMessage(existing, platform)); return; }

  const parts    = text.trim().split(/\s+/);
  let   username = parts[1]?.toLowerCase();

  // Auto-suggest Telegram username if no handle provided
  if (!username || parts.length < 2) {
    if (telegramUsername) {
      const suggested = telegramUsername.toLowerCase().replace(/[^a-z0-9_]/g, "_");
      await send([
        `👋 Welcome to NEXAR — Private Intelligence Graph`,
        ``,
        `Your Telegram username is @${telegramUsername}.`,
        `Use "${suggested}" as your NEXAR handle?`,
        ``,
        `• Reply yes to use it`,
        `• Or reply: register <handle> to pick a different one`,
        ``,
        `Your NEXAR handle is separate from your Telegram @username.`,
      ].join("\n"));
      // Store suggestion temporarily using pending registration
      const { setPendingRegistration } = await import("../../auth/IdentityManager.js");
      setPendingRegistration(platform, senderId, suggested);
      return;
    }
    await send(welcomeMessage(platform)); return;
  }

  // Handle "yes" reply after auto-suggestion
  if (username === "yes") {
    const { getPendingRegistration } = await import("../../auth/IdentityManager.js");
    const pending = getPendingRegistration(platform, senderId);
    if (pending) { username = pending; }
    else { await send(`No pending suggestion. Try: register <handle>`); return; }
  }
  if (!USERNAME_RE.test(username))   { await send(usernameInvalidMessage(platform)); return; }
  if (!isUsernameAvailable(username)){ await send(usernameTakenMessage(username, platform)); return; }

  log.info("Registering username", { platform, senderId, username });

  // Pass grantPendingShares as the onRegistered callback
  const result = await registerUsername(platform, senderId, username, async (u) => {
    await grantPendingShares(u, send);
  });

  if (result.ok) {
    await send(registrationSuccessMessage(result.username, result.walletAddress, platform));
  } else {
    switch (result.reason) {
      case "USERNAME_TAKEN":       await send(usernameTakenMessage(username, platform)); break;
      case "INVALID_USERNAME":     await send(usernameInvalidMessage(platform)); break;
      case "ALREADY_REGISTERED":   await send(alreadyRegisteredMessage(username, platform)); break;
      default: await send(`❌ Registration failed. Please try again.\nregister ${username}`);
    }
  }
}
