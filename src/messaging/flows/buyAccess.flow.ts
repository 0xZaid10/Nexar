// src/messaging/flows/buyAccess.flow.ts
// Buy license flow: lookup asset → show price → confirm → mint license.

import { createLogger }      from "../../core/index.js";
import { getWalletAddress }  from "../../auth/IdentityManager.js";
import { getState, setState, clearState } from "../state/ConversationState.js";
import type { Platform }     from "../formatter.js";
import {
  buyConfirmMessage, buySuccessMessage,
  insufficientBalanceMessage, assetNotFoundMessage,
  cancelledMessage, errorMessage,
} from "../formatter.js";

const log      = createLogger("BuyFlow");
const BASE_URL = process.env.INTERNAL_API_URL ?? "http://localhost:3001";

// ─── Parse asset reference ─────────────────────────────────────────────────
// Supports: @alice/my-dataset  or  0x1234...  (ip_id)

function parseAssetRef(ref: string): { ownerUsername: string; assetSlug: string } | null {
  const cleaned = ref.trim().replace(/^@/, "");
  const slash   = cleaned.indexOf("/");
  if (slash === -1) return null;
  return { ownerUsername: cleaned.slice(0, slash).toLowerCase(), assetSlug: cleaned.slice(slash + 1).toLowerCase() };
}

// ─── Look up asset by owner + slug ────────────────────────────────────────

async function lookupAsset(ownerUsername: string, assetSlug: string): Promise<{
  ipId: string; name: string; licenseTermsId: string; ownerAddress: string; price: string;
} | null> {
  try {
    // Get owner wallet
    const ownerAddress = await getWalletAddress(ownerUsername);
    if (!ownerAddress) return null;

    // Get assets for owner
    const res  = await fetch(`${BASE_URL}/api/asset?owner=${ownerAddress}`);
    const data = await res.json() as { ok: boolean; assets: any[] };
    if (!data.ok) return null;

    // Match by slug (name lowercased, spaces → hyphens)
    const slugify = (s: string) => s.toLowerCase().replace(/\s+/g, "-");
    const asset   = data.assets.find((a: any) => slugify(a.name) === assetSlug || slugify(a.name).includes(assetSlug));
    if (!asset) return null;

    // Get license fee
    const feeRes  = await fetch(`${BASE_URL}/api/license/terms/get-fee`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ licensorIpId: asset.ip_id, licenseTermsId: asset.license_terms_id ?? "0" }),
    });
    const feeData = await feeRes.json() as { ok: boolean; fee?: string };
    const price   = feeData.ok && feeData.fee ? feeData.fee : "0";

    return { ipId: asset.ip_id, name: asset.name, licenseTermsId: (asset as any).license_terms_id ?? "0", ownerAddress, price };
  } catch (err) {
    log.warn("Asset lookup failed", { ownerUsername, assetSlug, err });
    return null;
  }
}

// ─── Start buy flow ────────────────────────────────────────────────────────

export async function startBuyFlow(
  username:  string,
  platform:  Platform,
  assetRef:  string,
  send:      (text: string) => Promise<void>,
  senderId?: string
): Promise<void> {
  const parsed = parseAssetRef(assetRef);
  if (!parsed) {
    await send(`❌ Invalid asset reference.\nFormat: buy @username/asset-name`);
    return;
  }

  const { ownerUsername, assetSlug } = parsed;
  const asset = await lookupAsset(ownerUsername, assetSlug);

  if (!asset) {
    await send(assetNotFoundMessage(assetRef, platform));
    return;
  }

  // Get buyer's wallet balance
  const buyerAddress = await getWalletAddress(username);
  const balance      = "—";

  // Check if buyer already holds a license for this asset
  if (buyerAddress) {
    const { getDB } = await import("../../db/index.js");
    const db = getDB();
    const existingLicense = db.prepare(
      "SELECT license_token_id FROM licenses WHERE licensor_ip_id = ? AND holder_address = ? LIMIT 1"
    ).get(asset.ipId, buyerAddress) as { license_token_id: string } | undefined;

    if (existingLicense) {
      await send([
        `✅ You already own a license for ${asset.name}!`,
        ``,
        `License token: #${existingLicense.license_token_id}`,
        ``,
        `Access it with: access ${ownerUsername}/${assetSlug}`,
      ].join("\n"));
      return;
    }
  }

  if (existingLicense) {
    await send([
      `✅ You already own a license for ${asset.name}!`,
      ``,
      `License token: #${existingLicense.license_token_id}`,
      ``,
      `Access it with: access ${ownerUsername}/${assetSlug}`,
    ].join("\n"));
    return;
  }

  const priceEth = asset.price === "0" ? "free" : (Number(asset.price) / 1e18).toFixed(4);

  // Store pending purchase in state
  setState(platform, senderId ?? username, "awaiting_buy_confirm", {
    pendingBuyIpId:      asset.ipId,
    pendingBuyAssetName: asset.name,
    pendingBuyPrice:     asset.price,
    pendingBuyOwner:     ownerUsername,
    pendingBuyTermsId:   asset.licenseTermsId,
  });

  await send(buyConfirmMessage(asset.name, ownerUsername, priceEth, balance, platform));
}

// ─── Continue buy flow ─────────────────────────────────────────────────────

export async function continueBuyFlow(
  platform: Platform,
  senderId: string,
  username: string,
  input:    string,
  send:     (text: string) => Promise<void>
): Promise<void> {
  const { context } = getState(platform, senderId);
  const t = input.trim().toLowerCase();

  if (t === "cancel" || t === "no") {
    clearState(platform, senderId);
    await send(cancelledMessage(platform));
    return;
  }

  if (t !== "confirm" && t !== "yes") {
    await send(`Reply confirm to buy or cancel to exit.`);
    return;
  }

  const { pendingBuyIpId, pendingBuyAssetName, pendingBuyPrice, pendingBuyOwner, pendingBuyTermsId } = context;
  if (!pendingBuyIpId || !pendingBuyAssetName) {
    clearState(platform, senderId);
    await send(errorMessage(platform));
    return;
  }

  try {
    clearState(platform, senderId);

    // Mint license
    const res  = await fetch(`${BASE_URL}/api/license/mint`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        licensorIpId:    pendingBuyIpId,
        licenseTermsId:  pendingBuyTermsId ?? "0",
        buyerLabel:      username,
        mintingFee:      pendingBuyPrice ?? "0",
      }),
    });
    const data = await res.json() as { ok: boolean; tokenIds?: string[]; error?: string };

    if (!data.ok) {
      log.error("License mint failed", { data });
      await send(`❌ Purchase failed: ${data.error ?? "unknown error"}`);
      return;
    }

    const tokenId = data.licenseTokenIds?.[0] ?? data.tokenIds?.[0] ?? "—";
    await send(buySuccessMessage(pendingBuyAssetName, tokenId, platform));

  } catch (err) {
    log.error("Buy confirm failed", { username, err });
    clearState(platform, senderId);
    await send(errorMessage(platform));
  }
}
