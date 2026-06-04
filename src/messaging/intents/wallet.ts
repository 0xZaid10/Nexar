// src/messaging/intents/wallet.ts
import {
  getWalletAddress,
  getIdentity,
  linkPlatform,
  type Platform,
} from "../../auth/IdentityManager.js";
import { getDB }              from "../../db/index.js";
import { getOperator }        from "../../core/operator.js";
import { delegationStore }    from "../../auth/DelegationStore.js";
import { createLogger }       from "../../core/index.js";
import {
  walletMessage, earningsMessage, claimEarningsMessage,
  whoamiMessage, emailLinkedMessage, errorMessage, mono,
} from "../formatter.js";

const log    = createLogger("WalletIntent");
const APP_URL = process.env.NEXAR_APP_URL ?? "https://nexarip.online";
const WIP     = "0x1514000000000000000000000000000000000000" as `0x${string}`;

// ─── Wallet ────────────────────────────────────────────────────────────────

export async function handleWallet(
  username: string,
  platform: Platform,
  send:     (msg: string) => Promise<void>
): Promise<void> {
  const address = await getWalletAddress(username);
  if (!address) { await send(`❌ Wallet not found for ${username}.`); return; }

  const delegation = delegationStore.getExpiryInfo(username);
  const authStatus = delegation.valid
    ? `✅ Authorized (${delegation.daysLeft}d left)`
    : `⚠️ Not authorized — tap below to authorize`;

  await send(walletMessage(username, address, platform));

  // Send Mini App button if not authorized or expiring soon
  if (!delegation.valid || (delegation.daysLeft ?? 99) < 2) {
    await send(
      [
        `🔑 NEXAR Wallet Authorization`,
        ``,
        `Status: ${authStatus}`,
        ``,
        `To access files and claim royalties, authorize NEXAR:`,
        `${APP_URL}/app`,
        ``,
        `Open the link → connect wallet → tap Authorize.`,
      ].join("\n")
    );
  }
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

    const { storyClient } = await getOperator();
    const assetEarnings = await Promise.all(
      assets.map(async (a) => {
        try {
          // Read vault balance directly (SDK claimableRevenue broken on Aeneid)
          const vault = await storyClient.royalty.getRoyaltyVaultAddress(a.ip_id as `0x${string}`);
          const { createPublicClient, http } = await import("viem");
          const pc = createPublicClient({ transport: http("https://aeneid.storyrpc.io") });
          const vaultBal = await pc.readContract({
            address: WIP,
            abi: [{name:"balanceOf",type:"function",inputs:[{name:"a",type:"address"}],outputs:[{type:"uint256"}],stateMutability:"view"}],
            functionName: "balanceOf", args: [vault as `0x${string}`],
          });
          const wip = (Number(vaultBal) / 1e18).toFixed(4);
          return { name: a.name, claimable: wip };
        } catch {
          return { name: a.name, claimable: "0.0000" };
        }
      })
    );

    // Also show wallet WIP balance (already claimed + received)
    const { createPublicClient: pc2, http: http2 } = await import("viem");
    const pubClient = (await import("viem")).createPublicClient({ transport: (await import("viem")).http("https://aeneid.storyrpc.io") });
    const walletBal = await pubClient.readContract({
      address: WIP,
      abi: [{name:"balanceOf",type:"function",inputs:[{name:"a",type:"address"}],outputs:[{type:"uint256"}],stateMutability:"view"}],
      functionName: "balanceOf", args: [address as `0x${string}`],
    });
    const walletWip = (Number(walletBal) / 1e18).toFixed(4);
    await send(earningsMessage(username, assetEarnings, platform));
    if (Number(walletBal) > 0) {
      await send(`💳 Wallet balance: ${walletWip} WIP (previously claimed)`);
    }
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
    let lastTxHash   = "";
    let totalClaimed = 0n;

    // Check vault balances before claiming
    const { createPublicClient, http } = await import("viem");
    const pc = createPublicClient({ transport: http("https://aeneid.storyrpc.io") });
    const balAbi = [{name:"balanceOf",type:"function",inputs:[{name:"a",type:"address"}],outputs:[{type:"uint256"}],stateMutability:"view"}];

    for (const asset of assets) {
      try {
        const vault    = await storyClient.royalty.getRoyaltyVaultAddress(asset.ip_id as `0x${string}`);
        const vaultBal = await pc.readContract({ address:WIP, abi:balAbi, functionName:"balanceOf", args:[vault as `0x${string}`] }) as bigint;
        if (vaultBal > 0n) totalClaimed += vaultBal;

        const result = await storyClient.royalty.claimAllRevenue({
          ancestorIpId:    asset.ip_id as `0x${string}`,
          claimer:         asset.ip_id as `0x${string}`,
          childIpIds:      [],
          royaltyPolicies: [],
          currencyTokens:  [WIP],
          txOptions:       { waitForTransaction: true },
        });
        if (result?.txHashes?.[0]) lastTxHash = result.txHashes[0];
      } catch { /* no revenue to claim */ }
    }

    if (lastTxHash) {
      const claimedWip = (Number(totalClaimed) / 1e18).toFixed(4);
      await send(claimEarningsMessage(claimedWip, lastTxHash, platform));

      // Auto-transfer from IP accounts to owner wallet
      const PRIVY_BASE  = "https://api.privy.io/v1";
      const { getDB }   = await import("../../db/index.js");
      const walletRow   = getDB().prepare("SELECT privy_wallet_id FROM wallets WHERE label = ?").get(username) as any;
      const walletId    = walletRow?.privy_wallet_id;
      const { encodeFunctionData } = await import("viem");

      if (walletId && !walletId.startsWith("0x")) {
        const credentials = Buffer.from(`${process.env.PRIVY_APP_ID}:${process.env.PRIVY_APP_SECRET}`).toString("base64");
        const headers = { "Authorization":`Basic ${credentials}`, "privy-app-id":process.env.PRIVY_APP_ID!, "Content-Type":"application/json" };

        for (const asset of assets) {
          try {
            const { createPublicClient, http } = await import("viem");
            const pc = createPublicClient({ transport: http("https://aeneid.storyrpc.io") });
            const balAbi = [{name:"balanceOf",type:"function",inputs:[{name:"a",type:"address"}],outputs:[{type:"uint256"}],stateMutability:"view"}];
            const ipBal  = await pc.readContract({ address: WIP, abi: balAbi, functionName:"balanceOf", args:[asset.ip_id as `0x${string}`] });

            if (Number(ipBal) > 0) {
              const transferData = encodeFunctionData({
                abi: [{name:"transfer",type:"function",inputs:[{name:"to",type:"address"},{name:"amount",type:"uint256"}],outputs:[{type:"bool"}],stateMutability:"nonpayable"}],
                functionName: "transfer", args: [address as `0x${string}`, ipBal as bigint],
              });
              const execData = encodeFunctionData({
                abi: [{name:"execute",type:"function",inputs:[{name:"to",type:"address"},{name:"value",type:"uint256"},{name:"data",type:"bytes"}],outputs:[{type:"bytes"}],stateMutability:"nonpayable"}],
                functionName: "execute", args: [WIP as `0x${string}`, 0n, transferData],
              });
              await fetch(`${PRIVY_BASE}/wallets/${walletId}/rpc`, {
                method: "POST", headers,
                body: JSON.stringify({ method:"eth_sendTransaction", caip2:"eip155:1315",
                  params: { transaction: { to: asset.ip_id, data: execData, value:"0x0" } }
                }),
              });
              log.info("Auto-transferred royalties to owner wallet", { username, asset: asset.ip_id });
            }
          } catch(e) { /* silent */ }
        }
        await send(`✅ Royalties sent to your wallet: ${address.slice(0,6)}...${address.slice(-4)}`);
      }
    } else {
      await send(`No claimable royalties at this time.`);
    }
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
  if (!identity) { await send(`❌ Identity not found for ${username}.`); return; }

  const platforms = identity.platforms.map((p: any) => ({
    platform:   p.platform,
    platformId: (p.platform_id ?? p.platformId ?? "").replace(/^telegram:/, "").replace(/^imessage:/, ""),
  }));

  const delegation = delegationStore.getExpiryInfo(username);
  await send(whoamiMessage(username, address, platforms, platform));

  if (delegation.valid) {
    const days = delegation.daysLeft ?? 7;
    await send(`🔑 NEXAR authorized ✅ (${days} day${days !== 1 ? "s" : ""} left)`);
  } else {
    await send(`🔑 Not authorized — open ${APP_URL}/app to authorize.`);
  }
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
