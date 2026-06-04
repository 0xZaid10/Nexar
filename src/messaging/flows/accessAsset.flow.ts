// src/messaging/flows/accessAsset.flow.ts
// Decrypt and deliver a licensed asset to the requesting user.

import { createLogger }     from "../../core/index.js";
import { getWalletAddress } from "../../auth/IdentityManager.js";
import { getDB }            from "../../db/index.js";
import type { Platform }    from "../formatter.js";
import {
  accessGrantedMessage, accessDeniedMessage,
  assetNotFoundMessage, errorMessage,
} from "../formatter.js";

const log      = createLogger("AccessFlow");
const BASE_URL = process.env.INTERNAL_API_URL ?? "http://localhost:3001";

export type SendFileFn = (
  buffer:   Buffer,
  fileName: string,
  mimeType: string,
  caption:  string
) => Promise<void>;

// ─── Parse asset reference ─────────────────────────────────────────────────

function parseAssetRef(ref: string): { ownerUsername: string; assetSlug: string } | null {
  const cleaned = ref.trim().replace(/^@/, "");
  const slash   = cleaned.indexOf("/");
  if (slash === -1) return null;
  return { ownerUsername: cleaned.slice(0, slash).toLowerCase(), assetSlug: cleaned.slice(slash + 1).toLowerCase() };
}

// ─── Main access handler ───────────────────────────────────────────────────

export async function handleAccessAsset(
  username:  string,
  platform:  Platform,
  assetRef:  string,
  send:      (text: string) => Promise<void>,
  sendFile:  SendFileFn
): Promise<void> {
  const parsed = parseAssetRef(assetRef);
  if (!parsed) {
    await send(`❌ Invalid format.\nUse: access @username/asset-name`);
    return;
  }

  const { ownerUsername, assetSlug } = parsed;

  try {
    // 1. Get buyer address
    const buyerAddress = await getWalletAddress(username);
    if (!buyerAddress) { await send(`❌ Wallet not found.`); return; }

    // 2. Get owner address + find asset
    const ownerAddress = await getWalletAddress(ownerUsername);
    if (!ownerAddress) { await send(assetNotFoundMessage(assetRef, platform)); return; }

    const db       = getDB();
    const slugify  = (s: string) => s.toLowerCase().replace(/\s+/g, "-");
    const assetRow = db.prepare(
      "SELECT ip_id, vault_uuid, name, vault_cid FROM assets WHERE owner = ? AND active = 1"
    ).all(ownerAddress) as { ip_id: string; vault_uuid: string; name: string; vault_cid: string | null }[];

    const asset = assetRow.find(a => slugify(a.name) === assetSlug || slugify(a.name).includes(assetSlug));
    if (!asset) { await send(assetNotFoundMessage(assetRef, platform)); return; }

    // 3. Check license — find token ID held by buyer
    let license = db.prepare(
      "SELECT license_token_id FROM licenses WHERE LOWER(licensor_ip_id) = LOWER(?) AND LOWER(holder_address) = LOWER(?) LIMIT 1"
    ).get(asset.ip_id, buyerAddress) as { license_token_id: string } | undefined;

    // Owner always has access to their own assets
    const isOwner = ownerAddress.toLowerCase() === buyerAddress.toLowerCase();

    if (!license && !isOwner) {
      await send(accessDeniedMessage(asset.name, platform));
      return;
    }

    // Owner should have a license from registration (auto-minted)
    // If not found, deny — they can re-register or use the bot to fix
    if (!license && isOwner) {
      await send(`❌ No license found for your own asset. This may be a registration issue.`);
      return;
    }

    const tokenId = license.license_token_id;
    await send(accessGrantedMessage(asset.name, tokenId, platform));

    // 4. Call vault access API
    const accessRes = await fetch(`${BASE_URL}/api/vault/access`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label:           username,
        vaultUuid:       asset.vault_uuid,
        licenseTokenIds: [tokenId],
      }),
    });

    const accessData = await accessRes.json() as { ok: boolean; content?: string; error?: string };

    if (!accessData.ok || !accessData.content) {
      log.error("Vault access failed", { vaultUuid: asset.vault_uuid, error: accessData.error });
      await send(`❌ Could not decrypt the file. ${accessData.error ?? ""}`);
      return;
    }

    // 5. Decode content
    const plainBuffer = Buffer.from(accessData.content, "base64");

    // 6. Get mime type from fingerprint table
    const fpRow = db.prepare(
      "SELECT mime_type FROM asset_fingerprints WHERE ip_id = ?"
    ).get(asset.ip_id) as { mime_type: string | null } | undefined;
    const mimeType = fpRow?.mime_type ?? "application/octet-stream";

    // 7. Send file to user (on-chain license is the enforcement)
    const caption = `Licensed to @${username} | Token #${tokenId} | NEXAR`;
    await sendFile(plainBuffer, asset.name, mimeType, caption);

    log.info("File delivered", { username, assetName: asset.name, tokenId, sizeBytes: plainBuffer.length });

  } catch (err) {
    log.error("Access asset failed", { username, assetRef, err });
    await send(errorMessage(platform));
  }
}
