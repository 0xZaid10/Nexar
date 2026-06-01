// src/messaging/flows/shareAccess.flow.ts
// Handle sharing with unregistered users — invite or one-time link.
// Also handles the "share @username" intent for registered users.

import { randomBytes }       from "node:crypto";
import { createLogger }      from "../../core/index.js";
import { getDB }             from "../../db/index.js";
import { getWalletAddress, getUsernameByPlatform } from "../../auth/IdentityManager.js";
import { getState, setState, clearState, updateContext } from "../state/ConversationState.js";
import type { Platform }     from "../formatter.js";
import {
  cancelledMessage, errorMessage,
  privateShareSuccessMessage, timedShareSuccessMessage,
  notifyShareRecipientMessage,
} from "../formatter.js";

const log      = createLogger("ShareFlow");
const BASE_URL = process.env.INTERNAL_API_URL  ?? "http://localhost:3001";
const APP_URL  = process.env.NEXAR_APP_URL     ?? "https://nexar.io";

// ─── Unregistered target detected ─────────────────────────────────────────

export async function handleUnregisteredTarget(
  ownerUsername: string,
  targetUsername: string,
  ipId:          string,
  vaultUuid:     string,
  assetName:     string,
  platform:      Platform,
  senderId:      string,
  send:          (text: string) => Promise<void>
): Promise<void> {
  // Store context for next step
  setState(platform, senderId, "awaiting_share_unregistered_choice", {
    pendingBuyIpId:      ipId,
    pendingBuyAssetName: assetName,
    shareTarget:         targetUsername,
    assetName,
  } as any);

  await send([
    `⚠️ @${targetUsername} hasn't joined NEXAR yet.`,
    ``,
    `What would you like to do?`,
    ``,
    `• invite — send @${targetUsername} a pending invite. They get access automatically when they join.`,
    `• link   — generate a secure download link. Anyone with the link can download (no account needed).`,
    `• cancel`,
  ].join("\n"));
}

// ─── Continue unregistered share flow ─────────────────────────────────────

export async function continueUnregisteredShareFlow(
  platform:  Platform,
  senderId:  string,
  username:  string,
  input:     string,
  send:      (text: string) => Promise<void>
): Promise<boolean> {
  const { state, context } = getState(platform, senderId);
  if (state !== "awaiting_share_unregistered_choice" &&
      state !== "awaiting_link_options") return false;

  const t = input.trim().toLowerCase();

  if (t === "cancel") {
    clearState(platform, senderId);
    await send(cancelledMessage(platform));
    return true;
  }

  // ── Choice: invite or link ─────────────────────────────────────────────
  if (state === "awaiting_share_unregistered_choice") {
    if (t === "invite") {
      await handleInvite(username, context, platform, senderId, send);
      return true;
    }

    if (t === "link") {
      setState(platform, senderId, "awaiting_link_options" as any, context);
      await send([
        `🔗 Link options:`,
        ``,
        `• once  — single use, expires 48h`,
        `• multi — unlimited downloads, expires 48h`,
        `• Or reply with custom hours: 24 / 72 / 168`,
      ].join("\n"));
      return true;
    }

    await send(`Please reply with: invite, link, or cancel`);
    return true;
  }

  // ── Link options ───────────────────────────────────────────────────────
  if (state === "awaiting_link_options") {
    let singleUse     = true;
    let usesRemaining: number | null = 1;
    let expiryHours   = 48;

    if (t === "once") {
      singleUse     = true;
      usesRemaining = 1;
      expiryHours   = 48;
    } else if (t === "multi") {
      singleUse     = false;
      usesRemaining = null;
      expiryHours   = 48;
    } else {
      const hours = parseInt(t);
      if (!isNaN(hours) && hours >= 1 && hours <= 8760) {
        expiryHours = hours;
        // Ask single vs multi for custom hours
        setState(platform, senderId, "awaiting_link_use_type" as any, { ...context, timedHours: hours });
        await send([
          `Single-use or multi-use?`,
          `• once  — download once only`,
          `• multi — unlimited downloads within ${hours}h`,
        ].join("\n"));
        return true;
      }
      await send(`Reply once, multi, or a number of hours (e.g. 24)`);
      return true;
    }

    await generateAndSendLink({
      username, context, platform, senderId,
      singleUse, usesRemaining, expiryHours, send,
    });
    return true;
  }

  // ── Use type after custom hours ────────────────────────────────────────
  if ((state as string) === "awaiting_link_use_type") {
    const expiryHours = (context as any).timedHours ?? 48;
    if (t === "once") {
      await generateAndSendLink({ username, context, platform, senderId, singleUse: true, usesRemaining: 1, expiryHours, send });
    } else if (t === "multi") {
      await generateAndSendLink({ username, context, platform, senderId, singleUse: false, usesRemaining: null, expiryHours, send });
    } else {
      await send(`Please reply once or multi`);
    }
    return true;
  }

  return false;
}

// ─── Invite path ───────────────────────────────────────────────────────────

async function handleInvite(
  ownerUsername: string,
  context:       any,
  platform:      Platform,
  senderId:      string,
  send:          (text: string) => Promise<void>
): Promise<void> {
  const { pendingBuyIpId: ipId, pendingBuyAssetName: assetName, shareTarget: targetUsername } = context;

  try {
    const db = getDB();

    // Check if already pending
    const existing = db.prepare(
      "SELECT 1 FROM pending_shares WHERE ip_id = ? AND target_username = ?"
    ).get(ipId, targetUsername);

    if (!existing) {
      // Get vault_uuid from assets table
      const assetRow = db.prepare("SELECT vault_uuid FROM assets WHERE ip_id = ?").get(ipId) as { vault_uuid: string } | undefined;
      const vaultUuid = assetRow?.vault_uuid ?? "";

      db.prepare(
        `INSERT INTO pending_shares (ip_id, vault_uuid, owner_username, asset_name, target_username)
         VALUES (?, ?, ?, ?, ?)`
      ).run(ipId, vaultUuid, ownerUsername, assetName, targetUsername);
    }

    clearState(platform, senderId);
    await send([
      `✅ Invite sent for ${assetName}!`,
      ``,
      `@${targetUsername} will automatically get access when they join NEXAR.`,
      ``,
      `Share this with them: ${APP_URL}?ref=${ownerUsername}`,
      `Or tell them to find us on Telegram: t.me/nexar_intel_bot`,
    ].join("\n"));

  } catch (err) {
    log.error("Invite failed", { ownerUsername, targetUsername, err });
    await send(errorMessage(platform));
  }
}

// ─── Link generation ───────────────────────────────────────────────────────

async function generateAndSendLink(params: {
  username:      string;
  context:       any;
  platform:      Platform;
  senderId:      string;
  singleUse:     boolean;
  usesRemaining: number | null;
  expiryHours:   number;
  send:          (text: string) => Promise<void>;
}): Promise<void> {
  const { username, context, platform, senderId, singleUse, usesRemaining, expiryHours, send } = params;
  const { pendingBuyIpId: ipId, pendingBuyAssetName: assetName } = context;

  try {
    const db        = getDB();
    const assetRow  = db.prepare("SELECT vault_uuid FROM assets WHERE ip_id = ?").get(ipId) as { vault_uuid: string } | undefined;
    if (!assetRow) { await send(errorMessage(platform)); return; }

    const token     = randomBytes(24).toString("hex");
    const expiresAt = Math.floor(Date.now() / 1000) + expiryHours * 3600;

    db.prepare(
      `INSERT INTO access_tokens
       (token, vault_uuid, ip_id, owner_username, asset_name, single_use, uses_remaining, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(token, assetRow.vault_uuid, ipId, username, assetName, singleUse ? 1 : 0, usesRemaining, expiresAt);

    clearState(platform, senderId);

    const useLabel = singleUse ? "Single-use" : "Unlimited downloads";
    const link     = `${APP_URL}/access/${token}`;

    await send([
      `🔗 Secure access link generated!`,
      ``,
      `Asset: ${assetName}`,
      `${useLabel} • Expires in ${expiryHours}h`,
      ``,
      link,
      ``,
      `Anyone with this link can download the file.`,
      `No NEXAR account needed.`,
    ].join("\n"));

    log.info("Access token generated", { token: token.slice(0, 8) + "...", assetName, singleUse, expiryHours });

  } catch (err) {
    log.error("Link generation failed", { err });
    await send(errorMessage(platform));
  }
}

// ─── Check and grant pending shares on registration ────────────────────────

export async function grantPendingShares(
  username:  string,
  send?:     (text: string) => Promise<void>
): Promise<void> {
  const db   = getDB();
  const rows = db.prepare(
    "SELECT * FROM pending_shares WHERE target_username = ?"
  ).all(username) as Array<{ id: number; ip_id: string; vault_uuid: string; owner_username: string; asset_name: string }>;

  if (rows.length === 0) return;

  log.info("Granting pending shares", { username, count: rows.length });

  for (const row of rows) {
    try {
      // Mint license to new user
      const res = await fetch(`${BASE_URL}/api/license/mint`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          licensorIpId:    row.ip_id,
          licenseTermsId:  "0",
          buyerLabel:      username,
          mintingFee:      "0",
        }),
      });
      const data = await res.json() as { ok: boolean };

      if (data.ok) {
        db.prepare("DELETE FROM pending_shares WHERE id = ?").run(row.id);
        log.info("Pending share granted", { username, assetName: row.asset_name });
      }
    } catch (err) {
      log.warn("Failed to grant pending share", { username, assetName: row.asset_name, err });
    }
  }

  // Notify user
  if (send && rows.length > 0) {
    const names = rows.map(r => `• ${r.asset_name} from @${r.owner_username}`).join("\n");
    await send([
      `🎁 You have ${rows.length} pending file(s) waiting for you!`,
      ``,
      names,
      ``,
      `Reply: my licenses — to see them`,
    ].join("\n"));
  }
}
