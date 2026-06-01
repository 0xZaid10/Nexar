// src/messaging/intents/assets.ts
// "my assets" and "my licenses" intent handlers.

import { getDB }          from "../../db/index.js";
import { getWalletAddress } from "../../auth/IdentityManager.js";
import { createLogger }   from "../../core/index.js";
import type { Platform }  from "../formatter.js";
import { myAssetsMessage, myLicensesMessage, errorMessage } from "../formatter.js";

const log = createLogger("AssetsIntent");

// ─── My Assets ─────────────────────────────────────────────────────────────

export async function handleMyAssets(
  username: string,
  platform: Platform,
  send:     (msg: string) => Promise<void>
): Promise<void> {
  try {
    const address = await getWalletAddress(username);
    if (!address) { await send(`❌ Wallet not found.`); return; }

    const db    = getDB();
    const rows  = db.prepare(
      "SELECT ip_id, name, asset_type, vault_uuid FROM assets WHERE owner = ? AND active = 1 ORDER BY created_at DESC LIMIT 10"
    ).all(address) as { ip_id: string; name: string; asset_type: string; vault_uuid: string }[];

    const assets = rows.map(r => ({
      name:  r.name,
      ipId:  r.ip_id,
      price: "—",           // price lookup from hook would add latency — show on demand
      tier:  r.asset_type,
    }));

    await send(myAssetsMessage(username, assets, platform));
  } catch (err) {
    log.error("My assets failed", { username, err });
    await send(errorMessage(platform));
  }
}

// ─── My Licenses ───────────────────────────────────────────────────────────

export async function handleMyLicenses(
  username: string,
  platform: Platform,
  send:     (msg: string) => Promise<void>
): Promise<void> {
  try {
    const address = await getWalletAddress(username);
    if (!address) { await send(`❌ Wallet not found.`); return; }

    const db   = getDB();
    const rows = db.prepare(`
      SELECT l.license_token_id, l.licensor_ip_id, a.name AS asset_name, a.owner AS owner_address
      FROM licenses l
      LEFT JOIN assets a ON a.ip_id = l.licensor_ip_id
      WHERE l.holder_address = ?
      ORDER BY l.minted_at DESC LIMIT 10
    `).all(address) as { license_token_id: string; licensor_ip_id: string; asset_name: string | null; owner_address: string | null }[];

    // Get owner usernames from wallets table
    const licenses = rows.map(r => {
      const ownerRow = r.owner_address
        ? db.prepare("SELECT label FROM wallets WHERE address = ?").get(r.owner_address) as { label: string } | undefined
        : undefined;
      return {
        assetName: r.asset_name ?? "Unknown",
        ownerIpId: r.licensor_ip_id,
        ownerName: ownerRow?.label ?? r.licensor_ip_id.slice(0, 8) + "...",
        tokenId:   r.license_token_id,
      };
    });

    await send(myLicensesMessage(username, licenses, platform));
  } catch (err) {
    log.error("My licenses failed", { username, err });
    await send(errorMessage(platform));
  }
}
