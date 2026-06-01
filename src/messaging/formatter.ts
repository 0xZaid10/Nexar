// src/messaging/formatter.ts
// Format reply messages per platform + new flow templates.

export type Platform = "imessage" | "whatsapp" | "telegram" | "email";

function bold(text: string, platform: Platform): string {
  switch (platform) {
    case "whatsapp": return `*${text}*`;
    case "telegram": return text;  // plain text mode
    default:         return text;
  }
}

function mono(text: string, _platform: Platform): string {
  return text;  // plain text for all platforms
}

export { mono };

// ─── Existing templates ────────────────────────────────────────────────────

export function welcomeMessage(platform: Platform): string {
  const b = (t: string) => bold(t, platform);
  return [
    `👋 ${b("Welcome to NEXAR")} — Private Intelligence Graph`,
    ``,
    `Your files. Your data. Your IP. On-chain and monetized.`,
    ``,
    `To get started, choose a username:`,
    `register <username>`,
    ``,
    `Username must be 3-20 characters, letters/numbers/underscore.`,
  ].join("\n");
}

export function usernameTakenMessage(username: string, _platform: Platform): string {
  return `❌ Sorry, ${username} is already taken. Try another:\nregister <username>`;
}

export function usernameInvalidMessage(_platform: Platform): string {
  return `❌ Invalid username. Must be 3-20 characters, only letters, numbers, and underscores.\nregister <username>`;
}

export function registrationSuccessMessage(username: string, walletAddress: string, _platform: Platform): string {
  return [
    `✅ Handle "${username}" registered!`,
    ``,
    `Your wallet`,
    walletAddress,
    ``,
    `Text help to see what you can do.`,
  ].join("\n");
}

export function alreadyRegisteredMessage(username: string, _platform: Platform): string {
  return `You're already registered as @${username}.\nText help to see commands.`;
}

export function helpMessage(_platform: Platform): string {
  return [
    `👋 NEXAR — Private Intelligence Graph`,
    ``,
    `What I can do for you:`,
    ``,
    `📁 Register a file as IP — just send any file`,
    `🛒 Buy access — buy @username/asset-name`,
    `📥 Access a file — access @username/asset-name`,
    `💰 Check earnings — earnings`,
    `💸 Claim earnings — claim`,
    `👛 Your wallet — wallet`,
    `🔑 Your identity — whoami`,
    `📋 Your assets — my assets`,
    `🎫 Your licenses — my licenses`,
    `🔗 Link email — link email your@email.com`,
    `🔄 Recover account — recover <username>`,
    `🔍 Check plagiarism — send a file and reply "check"`,
    ``,
    `Text help anytime to see this again.`,
  ].join("\n");
}

export function walletMessage(username: string, walletAddress: string, _platform: Platform): string {
  return [
    `👛 Your NEXAR Wallet`,
    ``,
    `Username: @${username}`,
    `Address: ${walletAddress}`,
    `Mode: Privy MPC (non-custodial)`,
    ``,
    `View: https://aeneid.explorer.story.foundation/address/${walletAddress}`,
  ].join("\n");
}

export function earningsMessage(username: string, assets: Array<{ name: string; claimable: string }>, _platform: Platform): string {
  if (assets.length === 0) {
    return [
      `💰 Your IP Earnings`,
      ``,
      `No registered IP assets yet.`,
      `Send a file to register it as a NEXAR IP asset!`,
    ].join("\n");
  }
  const lines = assets.map(a => `• ${a.name}: ${a.claimable} WIP claimable`);
  return [`💰 Your IP Earnings`, ``, ...lines].join("\n");
}

export function claimEarningsMessage(claimed: string, txHash: string, _platform: Platform): string {
  return [
    `✅ Earnings Claimed!`,
    ``,
    `Amount: ${claimed} WIP`,
    `Tx: ${txHash.slice(0, 20)}...`,
  ].join("\n");
}

export function recoveryInitMessage(username: string, originalPlatform: string, _platform: Platform): string {
  return [
    `🔄 Account Recovery`,
    ``,
    `We've sent a 6-digit code to your original ${originalPlatform}.`,
    ``,
    `Reply with: verify <6-digit-code>`,
    ``,
    `Code expires in 10 minutes.`,
  ].join("\n");
}

export function recoveryCodeMessage(code: string, _platform: Platform): string {
  return [
    `🔑 Recovery Code`,
    ``,
    `Your verification code: ${code}`,
    ``,
    `Enter this on your new device to complete recovery.`,
    `Expires in 10 minutes.`,
  ].join("\n");
}

export function recoverySuccessMessage(username: string, _platform: Platform): string {
  return `✅ Account recovered! Welcome back, @${username}.`;
}

export function notRegisteredMessage(_platform: Platform): string {
  return `You don't have a NEXAR account yet.\n\nGet started: register <username>`;
}

export function emailLinkedMessage(email: string, _platform: Platform): string {
  return `✅ Email ${email} linked to your account.`;
}

export function whoamiMessage(username: string, walletAddress: string, platforms: Array<{ platform: string; platformId: string }>, _platform: Platform): string {
  const pl = platforms.map(p => `• ${p.platform}: ${p.platformId}`).join("\n");
  return [
    `🔑 NEXAR Handle: ${username}`,
    ``,
    `Wallet: ${walletAddress.slice(0, 10)}...${walletAddress.slice(-6)}`,
    ``,
    `Linked platforms:`,
    pl,
  ].join("\n");
}

export function shareFileMessage(_platform: Platform): string {
  return [
    `To share a file securely:`,
    ``,
    `Just send the file as an attachment and I'll guide you through it.`,
  ].join("\n");
}

export function errorMessage(_platform: Platform): string {
  return `❌ Something went wrong. Try again or text help.`;
}

// ─── NEW: File registration flow templates ─────────────────────────────────

export function fileReceivedMessage(fileName: string, sizeMB: string, _platform: Platform): string {
  return [
    `📁 Got ${fileName} (${sizeMB} MB)`,
    ``,
    `Who should be able to access this file?`,
    ``,
    `• anyone  — public marketplace, you set the price`,
    `• @username — private, only that person`,
    `• timed   — time-limited access to one person`,
    ``,
    `Reply with one of the above.`,
  ].join("\n");
}

export function accessTypeAnyoneMessage(_platform: Platform): string {
  return [
    `📋 License terms:`,
    ``,
    `• strict — no re-selling allowed`,
    `• open   — re-selling allowed, you earn 20% of their sales`,
    ``,
    `Reply strict or open.`,
  ].join("\n");
}

export function pricePromptMessage(_platform: Platform): string {
  return [
    `💰 Set a license price in $IP:`,
    ``,
    `Examples: 0.1  0.5  1.0  free`,
    ``,
    `Reply with the amount.`,
  ].join("\n");
}

export function namePromptMessage(fileName: string, _platform: Platform): string {
  return [
    `📝 Give this asset a name:`,
    ``,
    `(or reply skip to use "${fileName}")`,
  ].join("\n");
}

export function registeringMessage(_platform: Platform): string {
  return [
    `⏳ Registering on Story Protocol...`,
    ``,
    `This takes about 30 seconds. Hang tight!`,
  ].join("\n");
}

export function assetRegisteredMessage(
  assetName: string,
  ipId:      string,
  price:     string,
  accessType: string,
  _platform: Platform
): string {
  return [
    `✅ ${assetName} registered as your IP!`,
    ``,
    `Price: ${price === "free" ? "Free" : price + " $IP"}`,
    `Access: ${accessType}`,
    `IP ID: ${ipId.slice(0, 10)}...${ipId.slice(-6)}`,
    ``,
    `Explorer: https://aeneid.explorer.story.foundation/ipa/${ipId}`,
    ``,
    `Your file is encrypted on IPFS. Only licensed users can decrypt it.`,
    `Plagiarism fingerprint stored. 🛡️`,
  ].join("\n");
}

export function duplicateDetectedMessage(
  similarity:  number,
  ownerUsername: string,
  assetName:   string,
  matchType:   string,
  _platform:   Platform
): string {
  return [
    `⚠️ Similar content found on NEXAR!`,
    ``,
    `Match: ${similarity}% similar (${matchType})`,
    `Original: @${ownerUsername} — ${assetName}`,
    ``,
    `Do you still want to register? Reply yes to continue or no to cancel.`,
  ].join("\n");
}

export function shareTargetPromptMessage(_platform: Platform): string {
  return [
    `👤 Who should receive private access?`,
    ``,
    `Reply with their username: @username`,
  ].join("\n");
}

export function timedTargetPromptMessage(_platform: Platform): string {
  return [
    `👤 Who should get timed access?`,
    ``,
    `Reply with their username: @username`,
  ].join("\n");
}

export function timedHoursPromptMessage(targetUsername: string, _platform: Platform): string {
  return [
    `⏰ How many hours should @${targetUsername} have access?`,
    ``,
    `Examples: 24  48  72`,
  ].join("\n");
}

// ─── NEW: Buy flow templates ───────────────────────────────────────────────

export function buyConfirmMessage(
  assetName:     string,
  ownerUsername: string,
  price:         string,
  balance:       string,
  _platform:     Platform
): string {
  return [
    `🛒 Purchase License`,
    ``,
    `Asset: ${assetName}`,
    `Owner: ${ownerUsername}`,
    `Price: ${price} $IP`,
    `Your balance: ${balance} $IP`,
    ``,
    `Reply confirm to buy or cancel to exit.`,
  ].join("\n");
}

export function buySuccessMessage(assetName: string, tokenId: string, _platform: Platform): string {
  return [
    `✅ License purchased!`,
    ``,
    `You now have access to: ${assetName}`,
    `License token: #${tokenId}`,
    ``,
    `Reply: access @owner/${assetName.toLowerCase().replace(/\s+/g, "-")}`,
    `to download the file.`,
  ].join("\n");
}

export function insufficientBalanceMessage(price: string, balance: string, _platform: Platform): string {
  return [
    `❌ Insufficient balance`,
    ``,
    `Required: ${price} $IP`,
    `Your balance: ${balance} $IP`,
    ``,
    `Fund your wallet to continue.`,
  ].join("\n");
}

// ─── NEW: Asset/license list templates ────────────────────────────────────

export function myAssetsMessage(
  username: string,
  assets: Array<{ name: string; ipId: string; price: string; tier: string }>,
  _platform: Platform
): string {
  if (assets.length === 0) {
    return [
      `📋 Your IP Assets`,
      ``,
      `No assets registered yet.`,
      `Send a file to register your first IP asset!`,
    ].join("\n");
  }
  const lines = assets.map((a, i) =>
    `${i + 1}. ${a.name}\n   Tier: ${a.tier}\n   IP: ${a.ipId.slice(0, 8)}...`
  );
  return [`📋 ${username}'s IP Assets (${assets.length})`, ``, ...lines].join("\n");
}

export function myLicensesMessage(
  username: string,
  licenses: Array<{ assetName: string; ownerIpId: string; ownerName?: string; tokenId: string }>,
  _platform: Platform
): string {
  if (licenses.length === 0) {
    return [
      `🎫 Your Licenses`,
      ``,
      `No licenses purchased yet.`,
      `Browse assets and buy access with: buy @username/asset-name`,
    ].join("\n");
  }
  const lines = licenses.map((l, i) =>
    `${i + 1}. ${l.assetName}\n   Owner: @${l.ownerName ?? l.ownerIpId.slice(0, 8)}\n   Token: #${l.tokenId}`
  );
  return [`🎫 ${username}'s Licenses (${licenses.length})`, ``, ...lines].join("\n");
}

// ─── NEW: File access/delivery templates ──────────────────────────────────

export function accessGrantedMessage(assetName: string, licenseTokenId: string, _platform: Platform): string {
  return [
    `✅ Access verified! Decrypting ${assetName}...`,
    ``,
    `This copy is watermarked to your license token #${licenseTokenId}.`,
    `Delivering your file now.`,
  ].join("\n");
}

export function accessDeniedMessage(assetName: string, _platform: Platform): string {
  return [
    `❌ Access denied for ${assetName}`,
    ``,
    `You don't hold a license for this asset.`,
    `Buy access with: buy @owner/${assetName.toLowerCase().replace(/\s+/g, "-")}`,
  ].join("\n");
}

export function notifyShareRecipientMessage(fromUsername: string, assetName: string, _platform: Platform): string {
  return [
    `📁 @${fromUsername} shared a file with you!`,
    ``,
    `Asset: ${assetName}`,
    ``,
    `Reply: access @${fromUsername}/${assetName.toLowerCase().replace(/\s+/g, "-")}`,
    `to download it.`,
  ].join("\n");
}

export function privateShareSuccessMessage(assetName: string, targetUsername: string, _platform: Platform): string {
  return [
    `✅ ${assetName} shared privately with ${targetUsername}!`,
    ``,
    `They've been notified and can download it anytime.`,
    `Only ${targetUsername} can access this file.`,
  ].join("\n");
}

export function timedShareSuccessMessage(assetName: string, targetUsername: string, hours: number, _platform: Platform): string {
  return [
    `✅ ${assetName} shared with ${targetUsername} for ${hours} hours!`,
    ``,
    `Access expires automatically after ${hours}h.`,
    `They've been notified.`,
  ].join("\n");
}

export function assetNotFoundMessage(assetRef: string, _platform: Platform): string {
  return [
    `❌ Asset not found: ${assetRef}`,
    ``,
    `Check the username and asset name and try again.`,
    `Format: @username/asset-name`,
  ].join("\n");
}

export function cancelledMessage(_platform: Platform): string {
  return `✅ Cancelled. Text help to see what you can do.`;
}
