// src/messaging/intents/wallet.ts
// Wallet, earnings, claim, whoami, and link-email intent handlers.

import {
  getWalletAddress,
  getIdentity,
  linkPlatform,
  type Platform,
} from "../../auth/IdentityManager.js";
import { getDB }         from "../../db/index.js";
import { getOperator }   from "../../core/operator.js";
import { createLogger }  from "../../core/index.js";
import {
  walletMessage,
  earningsMessage,
  claimEarningsMessage,
  whoamiMessage,
  emailLinkedMessage,
  errorMessage,
  mono,
} from "../formatter.js";

const log = createLogger("WalletIntent");

// ─── Wallet ────────────────────────────────────────────────────────────────

export async function handleWallet(
  username: string,
  platform: Platform,
  send:     (msg: string) => Promise<void>
): Promise<void> {
  const address = await getWalletAddress(username);
  if (!address) {
    await send(`❌ Wallet not found for @${username}.`);
    return;
  }
  await send(walletMessage(username, address, platform));
}

// ─── Earnings ──────────────────────────────────────────────────────────────

export async function handleEarnings(
  username: string,
  platform: Platform,
  send:     (msg: string) => Promise<void>
): Promise<void> {
  try {
    const address = await getWalletAddress(username);
    if (!address) { await send(`❌ Wallet not found.`); return; }

    const db     = getDB();
    const assets = db.prepare(
      "SELECT ip_id, name FROM assets WHERE owner = ? AND active = 1"
    ).all(address) as { ip_id: string; name: string }[];

    if (assets.length === 0) {
      await send(earningsMessage(username, [], platform));
      return;
    }

    // Fetch claimable royalties for each asset
    const { storyClient } = await getOperator();
    const assetEarnings = await Promise.all(
      assets.map(async (a) => {
        try {
          const result = await storyClient.royalty.claimableRevenue({
            royaltyVaultIpId: a.ip_id as `0x${string}`,
            account:          address as `0x${string}`,
            token:            "0x1514000000000000000000000000000000000000" as `0x${string}`,
          });
          const wip = result ? (Number(result) / 1e18).toFixed(4) : "0.0000";
          return { name: a.name, claimable: wip };
        } catch {
          return { name: a.name, claimable: "0.0000" };
        }
      })
    );

    await send(earningsMessage(username, assetEarnings, platform));
  } catch (err) {
    log.error("Earnings fetch failed", { username, err });
    await send(errorMessage(platform));
  }
}

// ─── Claim ─────────────────────────────────────────────────────────────────

export async function handleClaim(
  username: string,
  platform: Platform,
  send:     (msg: string) => Promise<void>
): Promise<void> {
  try {
    const address = await getWalletAddress(username);
    if (!address) { await send(`❌ Wallet not found.`); return; }

    const db     = getDB();
    const assets = db.prepare(
      "SELECT ip_id FROM assets WHERE owner = ? AND active = 1"
    ).all(address) as { ip_id: string }[];

    if (assets.length === 0) {
      await send(`You have no IP assets to claim from yet.\nSend a file to register it!`);
      return;
    }

    const { storyClient } = await getOperator();
    let   totalClaimed    = 0n;
    let   lastTxHash      = "0x";

    for (const asset of assets) {
      try {
        const result = await storyClient.royalty.claimAllRevenue({
          ancestorIpId: asset.ip_id as `0x${string}`,
          claimer:      address    as `0x${string}`,
          childIpIds:   [],
          royaltyPolicies: [],
          currencyTokens: ["0x1514000000000000000000000000000000000000" as `0x${string}`],
        });
        if (result?.txHash) lastTxHash = result.txHash;
      } catch { /* no revenue to claim for this asset */ }
    }

    const claimed = (Number(totalClaimed) / 1e18).toFixed(4);
    await send(claimEarningsMessage(claimed, lastTxHash, platform));
  } catch (err) {
    log.error("Claim failed", { username, err });
    await send(errorMessage(platform));
  }
}

// ─── Whoami ────────────────────────────────────────────────────────────────

export async function handleWhoami(
  username: string,
  platform: Platform,
  send:     (msg: string) => Promise<void>
): Promise<void> {
  const identity = getIdentity(username);
  const address  = await getWalletAddress(username) ?? "unknown";

  if (!identity) {
    await send(`❌ Identity not found for @${username}.`);
    return;
  }

  const platforms = identity.platforms.map((p: any) => ({
    platform:   p.platform,
    platformId: (p.platform_id ?? p.platformId ?? "").replace(/^telegram:/, "").replace(/^imessage:/, ""),
  }));

  await send(whoamiMessage(username, address, platforms, platform));
}

// ─── Link Email ────────────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function handleLinkEmail(
  platform:   Platform,
  senderId:   string,
  username:   string,
  text:       string,
  send:       (msg: string) => Promise<void>
): Promise<void> {
  // "link email <email>"
  const parts = text.trim().split(/\s+/);
  const email = parts[2]?.toLowerCase();

  if (!email || !EMAIL_RE.test(email)) {
    await send(`Please provide a valid email:\n${mono("link email your@email.com", platform)}`);
    return;
  }

  const result = linkPlatform(username, "email", email);
  if (result.ok) {
    await send(emailLinkedMessage(email, platform));
  } else {
    await send(`❌ ${result.reason ?? "Failed to link email. Try again."}`);
  }
}
