// src/messaging/router.ts
// Master intent router — state machine first, then intent detection.

import { createLogger }              from "../core/index.js";
import { getUsernameByPlatform, type Platform } from "../auth/IdentityManager.js";
import { getState, clearState }      from "./state/ConversationState.js";
import { handleRegister }            from "./intents/register.js";
import { handleRecover, handleVerify } from "./intents/recover.js";
import { handleWallet, handleEarnings, handleClaim, handleWhoami, handleLinkEmail } from "./intents/wallet.js";
import { handleMyAssets, handleMyLicenses } from "./intents/assets.js";
import { startRegisterFlow, continueRegisterFlow } from "./flows/registerAsset.flow.js";
import { startBuyFlow, continueBuyFlow }           from "./flows/buyAccess.flow.js";
import { handleAccessAsset, type SendFileFn }       from "./flows/accessAsset.flow.js";
import { continueUnregisteredShareFlow }            from "./flows/shareAccess.flow.js";
import {
  welcomeMessage, notRegisteredMessage, helpMessage,
  errorMessage, cancelledMessage,
} from "./formatter.js";

const log = createLogger("Router");

// ─── Types ─────────────────────────────────────────────────────────────────

export interface ParsedMessage {
  platform:    Platform;
  senderId:    string;
  spaceId:     string;
  spacePhone?: string;
  text:        string | null;
  attachment:  { id: string; name: string; mimeType: string; size?: number; } | null;
  messageId:   string;
}

export type SendFn = (text: string) => Promise<void>;

export interface RouterDeps {
  send:        SendFn;
  sendFile?:   SendFileFn;
  getFile?:    (fileId: string) => Promise<Buffer | null>;
  sendToUser?: (targetUsername: string, text: string) => Promise<void>;
}

// ─── Intent detection ───────────────────────────────────────────────────────

type Intent =
  | "register" | "recover" | "verify"
  | "wallet" | "earnings" | "claim" | "whoami" | "link_email"
  | "my_assets" | "my_licenses"
  | "buy" | "access" | "cancel"
  | "file_received" | "help" | "unknown";

function detectIntent(text: string | null, hasAttachment: boolean): Intent {
  if (hasAttachment) return "file_received";
  if (!text)         return "unknown";

  const t = text.trim().toLowerCase();

  if (t.startsWith("register ") || t === "register") return "register";
  if (t.startsWith("recover "))                       return "recover";
  if (t.startsWith("verify "))                        return "verify";
  if (t === "wallet" || t === "my wallet" || t === "address" || t === "my address") return "wallet";
  if (t === "earnings" || t === "my earnings")        return "earnings";
  if (t === "claim" || t === "claim earnings")        return "claim";
  if (t === "whoami" || t === "who am i" || t === "me") return "whoami";
  if (t.startsWith("link email "))                    return "link_email";
  if (t === "my assets" || t === "assets")            return "my_assets";
  if (t === "my licenses" || t === "licenses")        return "my_licenses";
  if (t.startsWith("buy "))                           return "buy";
  if (t.startsWith("access "))                        return "access";
  if (t === "cancel")                                 return "cancel";
  if (t === "help" || t === "start" || t === "/start" ||
      t === "hi"   || t === "hello" || t === "hey")  return "help";
  if (t === "yes")  return "register";

  return "unknown";
}

// ─── Main router ───────────────────────────────────────────────────────────

export async function routeMessage(msg: ParsedMessage, deps: RouterDeps): Promise<void>;
export async function routeMessage(msg: ParsedMessage, send: SendFn): Promise<void>;
export async function routeMessage(msg: ParsedMessage, depsOrSend: RouterDeps | SendFn): Promise<void> {
  const deps: RouterDeps = typeof depsOrSend === "function"
    ? { send: depsOrSend }
    : depsOrSend;

  const { send, sendFile, getFile, sendToUser } = deps;
  const { platform, senderId, text, attachment, messageId } = msg;

  log.info("Routing message", {
    platform,
    sender:  senderId,
    text:    text?.slice(0, 40),
    hasFile: !!attachment,
    msgId:   messageId,
  });

  try {
    const intent   = detectIntent(text, !!attachment);
    const username = getUsernameByPlatform(platform, senderId);

    // ── Always-available intents (no account needed) ─────────────────────
    if (intent === "register") { await handleRegister(platform, senderId, text!, send, (msg as any).username ?? null); return; }
    if (intent === "recover")  { await handleRecover(platform, senderId, text!, send);  return; }
    if (intent === "verify")   { await handleVerify(platform, senderId, text!, send);   return; }

    // ── Active conversation state — check before anything else ────────────
    const { state } = getState(platform, senderId);

    if (state !== "idle") {
      if (text?.trim().toLowerCase() === "cancel") {
        clearState(platform, senderId);
        await send(cancelledMessage(platform));
        return;
      }

      // Unregistered share flow (invite / link)
      if (state === "awaiting_share_unregistered_choice" ||
          state === "awaiting_link_options" ||
          (state as string) === "awaiting_link_use_type") {
        if (!username) { await send(notRegisteredMessage(platform)); return; }
        const handled = await continueUnregisteredShareFlow(platform, senderId, username, text ?? "", send);
        if (handled) return;
      }

      // Buy flow
      if (state.startsWith("awaiting_buy")) {
        if (!username) { await send(notRegisteredMessage(platform)); return; }
        await continueBuyFlow(platform, senderId, username, text ?? "", send);
        return;
      }

      // Register asset flow
      if (["awaiting_access_type", "awaiting_license_type", "awaiting_share_target",
           "awaiting_timed_target", "awaiting_timed_hours", "awaiting_price",
           "awaiting_name"].includes(state)) {
        if (!username) { await send(notRegisteredMessage(platform)); return; }
        await continueRegisterFlow(platform, senderId, username, text ?? "", send, sendToUser, getFile);
        return;
      }
    }

    // ── New user ──────────────────────────────────────────────────────────
    if (!username) {
      await send(intent === "help" ? welcomeMessage(platform) : notRegisteredMessage(platform));
      return;
    }

    // ── Authenticated intents ─────────────────────────────────────────────
    switch (intent) {

      case "file_received":
        if (!getFile) { await send(`📁 File received! Full registration coming soon on this platform.`); return; }
        await startRegisterFlow(msg, username, platform, send, getFile);
        break;

      case "wallet":      await handleWallet(username, platform, send);                              break;
      case "earnings":    await handleEarnings(username, platform, send);                            break;
      case "claim":       await handleClaim(username, platform, send);                               break;
      case "whoami":      await handleWhoami(username, platform, send);                              break;
      case "link_email":  await handleLinkEmail(platform, senderId, username, text!, send);          break;
      case "my_assets":   await handleMyAssets(username, platform, send);                            break;
      case "my_licenses": await handleMyLicenses(username, platform, send);                          break;

      case "buy": {
        const ref = text!.trim().slice(4).trim();
        await startBuyFlow(username, platform, ref, send, senderId);
        break;
      }

      case "access": {
        const ref = text!.trim().slice(7).trim();
        if (!sendFile) { await send(`❌ File delivery not available on this platform yet.`); return; }
        await handleAccessAsset(username, platform, ref, send, sendFile);
        break;
      }

      case "cancel":
        clearState(platform, senderId);
        await send(cancelledMessage(platform));
        break;

      case "help":
      default:
        await send(helpMessage(platform));
        break;
    }

  } catch (err) {
    log.error("Router error", { platform, sender: senderId, err });
    try { await send(errorMessage(platform)); } catch { /* swallow */ }
  }
}
