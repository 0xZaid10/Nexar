// src/routes/spectrum.ts
// Spectrum webhook handler — processes iMessage/WhatsApp messages.
// Each message is routed to the appropriate NEXAR SDK function.
// Users interact via natural language — no wallet or crypto knowledge needed.

import { Router }          from "express";
import { asyncHandler }    from "../middleware/errorHandler.js";
import { WalletManager }   from "../auth/WalletManager.js";
import { SessionManager }  from "../auth/SessionManager.js";
import { getOperator }      from "../core/operator.js";
import { LicensingEngine } from "../licensing/LicensingEngine.js";
import { RoyaltyEngine }   from "../licensing/RoyaltyEngine.js";
import { getDB }           from "../db/index.js";
import { createLogger }    from "../core/logger.js";
import type { HexAddress } from "../core/types.js";

export const spectrumRouter = Router();

const log        = createLogger("Spectrum");
const walletMgr  = new WalletManager();
const sessionMgr = new SessionManager();

// ─── Message types from Spectrum ─────────────────────────────────────────────

interface SpectrumMessage {
  id:        string;
  text:      string;
  sender:    string;   // phone number or email
  platform:  "imessage" | "whatsapp" | "terminal";
  timestamp: string;
  attachments?: Array<{ url: string; type: string; name: string }>;
}

interface SpectrumWebhookBody {
  type:    "message";
  message: SpectrumMessage;
}

// ─── Intent detection ─────────────────────────────────────────────────────────

type Intent =
  | "share_file"
  | "check_earnings"
  | "claim_earnings"
  | "buy_access"
  | "my_wallet"
  | "help"
  | "unknown";

function detectIntent(text: string): Intent {
  const t = text.toLowerCase().trim();

  if (/(share|send|upload|nda|review|film|video|document|dataset|model)/i.test(t)) return "share_file";
  if (/(earn|revenue|royalt|how much|balance|made|income)/i.test(t))               return "check_earnings";
  if (/(claim|withdraw|collect|pay me|send me)/i.test(t))                           return "claim_earnings";
  if (/(buy|purchase|access|license|get|acquire)/i.test(t))                         return "buy_access";
  if (/(wallet|address|my address|my wallet)/i.test(t))                             return "my_wallet";
  if (/(help|what|how|hi|hello|hey|start)/i.test(t))                               return "help";

  return "unknown";
}

// ─── Response builders ────────────────────────────────────────────────────────

function helpMessage(): string {
  return [
    "👋 *NEXAR — Private Intelligence Graph*",
    "",
    "What I can do for you:",
    "📁 *Share a file* — Send any file to share it securely with time-limited access",
    "💰 *Check earnings* — See how much you've earned from your IP",
    "💸 *Claim earnings* — Withdraw your royalties",
    "🔑 *Buy access* — License a dataset, model, or strategy",
    "👛 *My wallet* — See your NEXAR wallet address",
    "",
    "Just message me naturally — I'll figure out what you need.",
    "",
    "Powered by Story Protocol + CDR encryption 🔐",
  ].join("\n");
}

// ─── Webhook handler ──────────────────────────────────────────────────────────

// POST /webhook/spectrum
spectrumRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const body = req.body as SpectrumWebhookBody;

    // Spectrum expects 200 OK quickly — process async
    res.status(200).json({ ok: true });

    // Process message asynchronously
    handleMessage(body.message).catch((err) => {
      log.error("Message handling failed", { err: String(err) });
    });
  })
);

async function handleMessage(msg: SpectrumMessage): Promise<void> {
  const sender  = msg.sender;
  const text    = msg.text?.trim() ?? "";
  const intent  = detectIntent(text);

  log.info("Message received", { sender, intent, platform: msg.platform });

  // Ensure sender has a wallet (create silently if not)
  if (!walletMgr.hasWallet(sender)) {
    await walletMgr.createWallet(sender);
    log.info("New wallet created for sender", { sender });
  }

  const address = await walletMgr.getAddress(sender);

  // Route to handler
  let reply: string;

  try {
    switch (intent) {
      case "my_wallet":
        reply = await handleWalletQuery(sender, address);
        break;

      case "check_earnings":
        reply = await handleCheckEarnings(address);
        break;

      case "claim_earnings":
        reply = await handleClaimEarnings(address);
        break;

      case "share_file":
        reply = await handleShareFile(msg, sender, address);
        break;

      case "help":
        reply = helpMessage();
        break;

      default:
        reply = [
          "I'm not sure what you're asking. Here's what I can do:\n",
          helpMessage(),
        ].join("\n");
    }
  } catch (err) {
    reply = `❌ Something went wrong: ${(err as Error).message?.slice(0, 100) ?? "Unknown error"}`;
    log.error("Handler failed", { intent, err: String(err) });
  }

  // Send reply via Spectrum API
  await sendSpectrumReply(msg, reply);
}

// ─── Intent handlers ──────────────────────────────────────────────────────────

async function handleWalletQuery(sender: string, address: HexAddress): Promise<string> {
  const mode = walletMgr.isPrivyWallet(sender) ? "Privy MPC (non-custodial)" : "NEXAR encrypted";
  return [
    "👛 *Your NEXAR Wallet*",
    "",
    `Address: \`${address}\``,
    `Mode: ${mode}`,
    "",
    `View on explorer: https://aeneid.storyscan.io/address/${address}`,
  ].join("\n");
}

async function handleCheckEarnings(address: HexAddress): Promise<string> {
  const db   = getDB();
  const ips  = db.prepare("SELECT ip_id, name FROM assets WHERE owner = ? AND active = 1").all(address) as
    { ip_id: string; name: string }[];

  if (ips.length === 0) {
    return "You don't have any registered IP assets yet.\n\nSend me a file to register it as a NEXAR IP asset!";
  }

  const { storyClient } = await getOperator();
  const engine          = new RoyaltyEngine(storyClient);

  const lines = ["💰 *Your IP Earnings*\n"];
  let hasEarnings = false;

  for (const ip of ips.slice(0, 5)) { // cap at 5 to avoid timeout
    try {
      const claimable = await engine.getClaimable(ip.ip_id as HexAddress);
      const eth       = (Number(claimable) / 1e18).toFixed(4);
      lines.push(`• *${ip.name}*: ${eth} WIP claimable`);
      if (claimable > 0n) hasEarnings = true;
    } catch {
      lines.push(`• *${ip.name}*: unable to fetch`);
    }
  }

  if (hasEarnings) {
    lines.push('\nReply "claim earnings" to withdraw.');
  }

  return lines.join("\n");
}

async function handleClaimEarnings(address: HexAddress): Promise<string> {
  const db  = getDB();
  const ips = db.prepare("SELECT ip_id, name FROM assets WHERE owner = ? AND active = 1").all(address) as
    { ip_id: string; name: string }[];

  if (ips.length === 0) return "You don't have any IP assets to claim from yet.";

  const { storyClient } = await getOperator();
  const engine          = new RoyaltyEngine(storyClient);

  const claimed: string[] = [];

  for (const ip of ips.slice(0, 3)) {
    try {
      const claimable = await engine.getClaimable(ip.ip_id as HexAddress);
      if (claimable > 0n) {
        await engine.claimAll(ip.ip_id as HexAddress, []);
        claimed.push(`✓ ${ip.name}: ${(Number(claimable) / 1e18).toFixed(4)} WIP`);
      }
    } catch { /* skip */ }
  }

  if (claimed.length === 0) return "Nothing to claim right now. Earnings accumulate as others license your IP.";

  return ["💸 *Earnings Claimed*\n", ...claimed].join("\n");
}

async function handleShareFile(
  msg: SpectrumMessage,
  sender: string,
  address: HexAddress
): Promise<string> {
  if (!msg.attachments || msg.attachments.length === 0) {
    return [
      "To share a file securely:\n",
      "1️⃣ Attach the file to your message",
      "2️⃣ Tell me who should have access and for how long",
      "",
      "Example: *[attach file]* Share this with john@example.com for 48 hours",
    ].join("\n");
  }

  // File attached — acknowledge and guide
  const file = msg.attachments[0]!;
  return [
    `📁 Got your file: *${file.name}*\n`,
    "To complete the share, reply with:",
    "• Who should have access (email or phone)",
    "• How long they should have access (e.g. 48 hours, 7 days)",
    "",
    "Example: *Share with musician@example.com for 48 hours*",
    "",
    "The file will be encrypted and gated by Story Protocol — only your recipient can decrypt it, and access expires automatically.",
  ].join("\n");
}

// ─── Spectrum reply helper ────────────────────────────────────────────────────

async function sendSpectrumReply(
  originalMsg: SpectrumMessage,
  replyText:   string
): Promise<void> {
  const apiKey    = process.env.SPECTRUM_PROJECT_SECRET;
  const projectId = process.env.SPECTRUM_PROJECT_ID;

  if (!apiKey || !projectId) {
    // Dev mode — just log the reply
    log.info("SPECTRUM REPLY (dev mode — set SPECTRUM_PROJECT_ID + SPECTRUM_PROJECT_SECRET to send):", {
      to:    originalMsg.sender,
      reply: replyText.slice(0, 100),
    });
    return;
  }

  try {
    const res = await fetch(`https://api.photon.codes/v1/messages`, {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        projectId,
        recipient: originalMsg.sender,
        platform:  originalMsg.platform,
        text:      replyText,
      }),
    });

    if (!res.ok) {
      log.warn("Spectrum reply failed", { status: res.status.toString() });
    }
  } catch (err) {
    log.warn("Spectrum API error", { err: String(err) });
  }
}
