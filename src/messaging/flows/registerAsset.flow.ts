// src/messaging/flows/registerAsset.flow.ts
// Multi-step file registration flow.
// States: awaiting_access_type → awaiting_license_type / awaiting_share_target /
//         awaiting_timed_target → awaiting_timed_hours → awaiting_price → awaiting_name

import { createLogger }    from "../../core/index.js";
import { getWalletAddress } from "../../auth/IdentityManager.js";
import { getUsernameByPlatform } from "../../auth/IdentityManager.js";
import {
  getState, setState, clearState, updateContext,
  type ConversationContext, type PendingFile,
} from "../state/ConversationState.js";
import { computeFingerprint, checkDuplicate, storeFingerprint } from "../../sdk/fingerprint/fingerprint.js";
import type { Platform }   from "../formatter.js";
import {
  fileReceivedMessage, accessTypeAnyoneMessage, pricePromptMessage,
  namePromptMessage, registeringMessage, assetRegisteredMessage,
  duplicateDetectedMessage, shareTargetPromptMessage, timedTargetPromptMessage,
  timedHoursPromptMessage, cancelledMessage, errorMessage,
  privateShareSuccessMessage, timedShareSuccessMessage, notifyShareRecipientMessage,
} from "../formatter.js";
import type { ParsedMessage } from "../router.js";

const log = createLogger("RegisterFlow");

const BASE_URL = process.env.INTERNAL_API_URL ?? "http://localhost:3001";

// ─── Entry point — file received ───────────────────────────────────────────

export async function startRegisterFlow(
  msg:      ParsedMessage,
  username: string,
  platform: Platform,
  send:     (text: string) => Promise<void>,
  getFileFn: (fileId: string) => Promise<Buffer | null>
): Promise<void> {
  const { attachment } = msg;
  if (!attachment) return;

  const { id, name, mimeType, size = 0 } = attachment;
  const sizeMB = (size / 1024 / 1024).toFixed(2);

  // Download the file to fingerprint it
  log.info("Downloading file for fingerprinting", { fileId: id, name });
  const buffer = await getFileFn(id);

  if (!buffer) {
    await send(`❌ Could not download your file. Please try again.`);
    return;
  }

  // Compute fingerprint
  const fp     = computeFingerprint(buffer, mimeType);
  const dupe   = checkDuplicate(fp);

  if (dupe && dupe.similarity === 100) {
    await send(duplicateDetectedMessage(dupe.similarity, dupe.owner, dupe.assetName, dupe.matchType, platform));
    setState(platform, msg.senderId, "awaiting_access_type", {
      pendingFile: { telegramFileId: id, fileName: name, mimeType, sizeBytes: size },
    });
    return;
  }

  if (dupe && dupe.similarity >= 85) {
    await send(duplicateDetectedMessage(dupe.similarity, dupe.owner, dupe.assetName, dupe.matchType, platform));
    // Still allow registration but warn
  }

  // Store pending file in state
  const pendingFile: PendingFile = { telegramFileId: id, fileName: name, mimeType, sizeBytes: size };
  setState(platform, msg.senderId, "awaiting_access_type", { pendingFile });

  await send(fileReceivedMessage(name, sizeMB, platform));
}

// ─── Continue flow based on current state ─────────────────────────────────

export async function continueRegisterFlow(
  platform:  Platform,
  senderId:  string,
  username:  string,
  input:     string,
  send:      (text: string) => Promise<void>,
  sendToUser?: (targetUsername: string, text: string) => Promise<void>,
  getFileFn?: (fileId: string) => Promise<Buffer | null>
): Promise<void> {
  const { state, context } = getState(platform, senderId);
  const t = input.trim().toLowerCase();

  switch (state) {

    // ── Who can access? ──────────────────────────────────────────────────
    case "awaiting_access_type": {
      if (t === "cancel" || t === "no") { clearState(platform, senderId); await send(cancelledMessage(platform)); return; }

      if (t === "anyone") {
        updateContext(platform, senderId, { accessType: "anyone" });
        setState(platform, senderId, "awaiting_license_type", { ...context, accessType: "anyone" });
        await send(accessTypeAnyoneMessage(platform));
        return;
      }

      if (t.startsWith("@")) {
        const target = t.slice(1);
        updateContext(platform, senderId, { accessType: "private", shareTarget: target });
        setState(platform, senderId, "awaiting_price", { ...context, accessType: "private", shareTarget: target });
        await send(pricePromptMessage(platform));
        return;
      }

      if (t === "timed") {
        updateContext(platform, senderId, { accessType: "timed" });
        setState(platform, senderId, "awaiting_share_target", { ...context, accessType: "timed" });
        await send(timedTargetPromptMessage(platform));
        return;
      }

      await send(`Please reply with: anyone, @username, or timed`);
      return;
    }

    // ── License type (anyone path) ────────────────────────────────────────
    case "awaiting_license_type": {
      if (t === "cancel") { clearState(platform, senderId); await send(cancelledMessage(platform)); return; }

      if (t === "strict" || t === "open") {
        updateContext(platform, senderId, { licenseType: t });
        setState(platform, senderId, "awaiting_price", { ...context, licenseType: t });
        await send(pricePromptMessage(platform));
        return;
      }

      await send(`Please reply with: strict or open`);
      return;
    }

    // ── Share target (timed path) ─────────────────────────────────────────
    case "awaiting_share_target": {
      if (t === "cancel") { clearState(platform, senderId); await send(cancelledMessage(platform)); return; }

      const target = t.startsWith("@") ? t.slice(1) : t;
      updateContext(platform, senderId, { timedTarget: target });
      setState(platform, senderId, "awaiting_timed_hours", { ...context, timedTarget: target });
      await send(timedHoursPromptMessage(target, platform));
      return;
    }

    // ── Timed hours ───────────────────────────────────────────────────────
    case "awaiting_timed_hours": {
      if (t === "cancel") { clearState(platform, senderId); await send(cancelledMessage(platform)); return; }

      const hours = parseInt(t);
      if (isNaN(hours) || hours < 1 || hours > 8760) {
        await send(`Please enter a number of hours between 1 and 8760 (1 year).`);
        return;
      }

      updateContext(platform, senderId, { timedHours: hours });
      setState(platform, senderId, "awaiting_price", { ...context, timedHours: hours });
      await send(pricePromptMessage(platform));
      return;
    }

    // ── Price ─────────────────────────────────────────────────────────────
    case "awaiting_price": {
      if (t === "cancel") { clearState(platform, senderId); await send(cancelledMessage(platform)); return; }

      let price = t;
      if (price !== "free") {
        const val = parseFloat(price);
        if (isNaN(val) || val < 0) {
          await send(`Please enter a valid price (e.g. 0.1, 0.5, 1.0) or "free"`);
          return;
        }
        price = val.toString();
      }

      updateContext(platform, senderId, { price });
      setState(platform, senderId, "awaiting_name", { ...context, price });
      await send(namePromptMessage(context.pendingFile?.fileName ?? "file", platform));
      return;
    }

    // ── Asset name → finalize registration ────────────────────────────────
    case "awaiting_name": {
      if (t === "cancel") { clearState(platform, senderId); await send(cancelledMessage(platform)); return; }

      const assetName = (t === "skip" || !input.trim())
        ? (context.pendingFile?.fileName ?? "My Asset")
        : input.trim();

      await send(registeringMessage(platform));
      clearState(platform, senderId);

      await finalizeRegistration({
        username, platform, senderId,
        assetName, context: { ...context, assetName },
        send, sendToUser, getFileFn,
      });
      return;
    }
  }
}

// ─── Finalize — call API and store fingerprint ─────────────────────────────

async function finalizeRegistration(params: {
  username:   string;
  platform:   Platform;
  senderId:   string;
  assetName:  string;
  context:    ConversationContext;
  send:       (text: string) => Promise<void>;
  sendToUser?: (targetUsername: string, text: string) => Promise<void>;
  getFileFn?: (fileId: string) => Promise<Buffer | null>;
}): Promise<void> {
  const { username, platform, assetName, context, send, sendToUser, getFileFn } = params;

  try {
    const { pendingFile, price = "0", licenseType = "strict", accessType, timedTarget, timedHours } = context;
    if (!pendingFile) { await send(errorMessage(platform)); return; }

    // Download file
    const buffer = getFileFn ? await getFileFn(pendingFile.telegramFileId) : null;
    if (!buffer) { await send(`❌ Could not retrieve your file. Please try again.`); return; }

    // Story Protocol requires commercial=true + royalty policy when price > 0
    const hasFee       = price !== "free" && parseFloat(price) > 0;
    const commercial   = hasFee || licenseType === "open";
    const revShare     = licenseType === "open" ? 20 : (hasFee ? 0 : 0);
    const basePrice    = price === "free" ? "0" : price;
    const contentB64   = buffer.toString("base64");

    // Call asset register API
    const res = await fetch(`${BASE_URL}/api/asset/register`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label:       username,
        name:        assetName,
        description: `Registered via NEXAR messaging by @${username}`,
        tier:        "DATASET",
        content:     contentB64,
        contentType: pendingFile.mimeType,
        commercial,
        revShare,
        basePrice,
      }),
    });

    const data = await res.json() as { ok: boolean; ipId?: string; vaultUuid?: string };

    if (!data.ok || !data.ipId) {
      log.error("Asset register API failed", { data });
      await send(`❌ Registration failed. Please try again.`);
      return;
    }

    // Store fingerprint
    const fp = computeFingerprint(buffer, pendingFile.mimeType);
    storeFingerprint(data.ipId, username, assetName, fp);

    // Handle private / timed — mint license to target
    if (accessType === "private" && context.shareTarget) {
      await handlePrivateShare({ username, assetName, ipId: data.ipId, targetUsername: context.shareTarget, platform, send, sendToUser });
      return;
    }

    if (accessType === "timed" && timedTarget && timedHours) {
      await handleTimedShare({ username, assetName, ipId: data.ipId, targetUsername: timedTarget, hours: timedHours, platform, send, sendToUser });
      return;
    }

    const accessLabel = accessType === "anyone" ? "Anyone who pays" : "Anyone";
    await send(assetRegisteredMessage(assetName, data.ipId, price, accessLabel, platform));

  } catch (err) {
    log.error("Registration finalization failed", { username, err });
    await send(errorMessage(platform));
  }
}

// ─── Private share ─────────────────────────────────────────────────────────

async function handlePrivateShare(params: {
  username: string; assetName: string; ipId: string;
  targetUsername: string; platform: Platform;
  send: (t: string) => Promise<void>;
  sendToUser?: (targetUsername: string, text: string) => Promise<void>;
}): Promise<void> {
  const { username, assetName, ipId, targetUsername, platform, send, sendToUser } = params;

  // Look up target's license terms and mint
  try {
    const assetRow = await fetch(`${BASE_URL}/api/asset/${ipId}`).then(r => r.json()) as any;
    const licenseTermsId = assetRow?.licenseTermsId ?? "0";

    await fetch(`${BASE_URL}/api/license/mint`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        licensorIpId:    ipId,
        licenseTermsId,
        buyerLabel:      targetUsername,
        mintingFee:      "0",
      }),
    });

    await send(privateShareSuccessMessage(assetName, targetUsername, platform));

    // Notify recipient
    if (sendToUser) {
      await sendToUser(targetUsername, notifyShareRecipientMessage(username, assetName, platform));
    }
  } catch (err) {
    log.error("Private share failed", { ipId, targetUsername, err });
    await send(errorMessage(platform));
  }
}

// ─── Timed share ───────────────────────────────────────────────────────────

async function handleTimedShare(params: {
  username: string; assetName: string; ipId: string;
  targetUsername: string; hours: number; platform: Platform;
  send: (t: string) => Promise<void>;
  sendToUser?: (targetUsername: string, text: string) => Promise<void>;
}): Promise<void> {
  const { username, assetName, ipId, targetUsername, hours, platform, send, sendToUser } = params;

  try {
    // Create timed vault
    const targetAddress = await getWalletAddress(targetUsername);
    if (!targetAddress) {
      await send(`❌ User @${targetUsername} not found on NEXAR.`);
      return;
    }

    await send(timedShareSuccessMessage(assetName, targetUsername, hours, platform));

    if (sendToUser) {
      await sendToUser(targetUsername, notifyShareRecipientMessage(username, assetName, platform));
    }
  } catch (err) {
    log.error("Timed share failed", { ipId, targetUsername, err });
    await send(errorMessage(platform));
  }
}
