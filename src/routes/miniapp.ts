
import { createHmac } from "crypto";

// Verify Telegram Mini App initData signature
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function verifyTelegramInitData(initData: string): {
  ok: boolean;
  userId?: string;
  username?: string;
} {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
    const params   = new URLSearchParams(initData);
    const hash     = params.get("hash");
    if (!hash) return { ok: false };

    // Build data check string (sorted keys, exclude hash)
    params.delete("hash");
    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    // HMAC-SHA256 with secret key = HMAC-SHA256("WebAppData", botToken)
    const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
    const computed  = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

    if (computed !== hash) return { ok: false };

    // Parse user
    const userStr = params.get("user");
    if (!userStr) return { ok: true }; // no user field (desktop)
    const user = JSON.parse(userStr);
    return { ok: true, userId: String(user.id), username: user.username };
  } catch {
    return { ok: false };
  }
}

// src/routes/miniapp.ts
// Mini App API endpoints:
//   POST /api/auth/delegate   — store signed EIP-712 delegation
//   GET  /api/auth/delegation — check delegation status
//   DELETE /api/auth/delegation — revoke delegation
//   POST /api/miniapp/claim   — claim royalties using delegation

import { Router }          from "express";
import { body, validationResult } from "express-validator";
import { getDB } from "../db/index.js";
import { asyncHandler }    from "../middleware/errorHandler.js";
import { delegationStore } from "../auth/DelegationStore.js";
import { getUsernameByPlatform } from "../auth/IdentityManager.js";
import { createLogger }    from "../core/logger.js";

export const miniappRouter = Router();
const log = createLogger("MiniAppRoute");

// ─── POST /api/auth/delegate ──────────────────────────────────────────────────
// Called from Mini App after user signs EIP-712 delegation.

miniappRouter.post(
  "/auth/delegate",
  body("username").isString().notEmpty(),
  body("walletAddress").isString().matches(/^0x[0-9a-fA-F]{40}$/),
  body("signature").isString().matches(/^0x/),
  body("validUntil").isInt({ min: 1 }),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ ok: false, error: "VALIDATION_ERROR", details: errors.array() });
      return;
    }

    const { username, walletAddress, signature, validUntil } = req.body;

    // Verify Telegram identity if initData provided
    const initData = req.body.tgInitData as string | undefined;
    if (initData) {
      const tgVerify = verifyTelegramInitData(initData);
      if (!tgVerify.ok) {
        res.status(403).json({ ok: false, error: "INVALID_TELEGRAM_DATA" });
        return;
      }

      // Verify this Telegram user owns the handle
      const { getUsernameByPlatform } = await import("../auth/IdentityManager.js");
      const { getDB } = await import("../db/index.js");
      const platformId = `telegram:${tgVerify.userId}`;
      const ownerHandle = getUsernameByPlatform("telegram", platformId);

      if (ownerHandle && ownerHandle !== username) {
        res.status(403).json({
          ok:    false,
          error: "HANDLE_NOT_YOURS",
          message: `This Telegram account owns handle "${ownerHandle}", not "${username}".`
        });
        return;
      }
    }

    const result = await delegationStore.store({ username, walletAddress, signature, validUntil });

    if (!result.ok) {
      res.status(400).json({ ok: false, error: result.reason });
      return;
    }

    log.info("Delegation stored via Mini App", { username });
    res.json({
      ok:        true,
      username,
      message:   "Authorization successful. You can now access files from Telegram.",
      expiresAt: new Date(validUntil * 1000).toISOString(),
    });
  })
);

// ─── GET /api/auth/delegation/:username ───────────────────────────────────────

miniappRouter.get(
  "/auth/delegation/:username",
  asyncHandler(async (req, res) => {
    const { username } = req.params;
    const info = delegationStore.getExpiryInfo(username);
    res.json({ ok: true, username, ...info });
  })
);

// ─── DELETE /api/auth/delegation/:username ────────────────────────────────────

miniappRouter.delete(
  "/auth/delegation/:username",
  asyncHandler(async (req, res) => {
    delegationStore.revoke(req.params.username);
    res.json({ ok: true, message: "Delegation revoked." });
  })
);

// ─── GET /api/miniapp/config ──────────────────────────────────────────────────
// Returns config the Mini App needs (domain, chain ID, etc.)

miniappRouter.get(
  "/miniapp/config",
  asyncHandler(async (_req, res) => {
    res.json({
      ok:      true,
      chainId: 1315,
      domain:  "NEXAR",
      version: "1",
      action:  "nexar_access",
      appName: "NEXAR Private Intelligence Graph",
    });
  })
);

// POST /api/miniapp/register
// Register a new handle from Mini App (replaces bot registration)
miniappRouter.post(
  "/miniapp/register",
  body("username").isString().matches(/^[a-z0-9_]{3,20}$/),
  body("walletAddress").isString().matches(/^0x[0-9a-fA-F]{40}$/),
  body("tgUserId").isString().notEmpty(),
  body("signature").isString().matches(/^0x/),
  body("validUntil").isInt({ min: 1 }),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) { res.status(400).json({ ok:false, error:"VALIDATION_ERROR", details:errors.array() }); return; }

    const { username, walletAddress, tgUserId, signature, validUntil } = req.body;

    // Import here to avoid circular deps
    const { registerUsername, getUsernameByPlatform } = await import("../auth/IdentityManager.js");
    const { WalletManager } = await import("../auth/WalletManager.js");
    const { getDB } = await import("../db/index.js");

    const db = getDB();

    // Check if already registered
    const existing = getUsernameByPlatform("telegram", `telegram:${tgUserId}`);
    if (existing && existing !== username) {
      res.status(400).json({ ok:false, error:"ALREADY_REGISTERED", existing });
      return;
    }

    if (!existing) {
      // Create wallet with the Mini App's address (not a new Privy server wallet)
      const wm = new WalletManager();
      if (!wm.hasWallet(username)) {
        // Insert wallet record directly with the user's Privy embedded wallet address
        db.prepare("INSERT OR IGNORE INTO wallets (label, address, privy_wallet_id) VALUES (?,?,?)")
          .run(username, walletAddress.toLowerCase(), `miniapp:${username}`);
      }

      // Register the handle
      const result = await registerUsername("telegram", `telegram:${tgUserId}`, username);
      if (!result.ok && result.reason !== "ALREADY_REGISTERED") {
        res.status(400).json({ ok:false, error:result.reason });
        return;
      }
    }

    // Store delegation
    const { delegationStore } = await import("../auth/DelegationStore.js");
    const delegResult = await delegationStore.store({ username, walletAddress, signature, validUntil });
    if (!delegResult.ok) { res.status(400).json({ ok:false, error:delegResult.reason }); return; }

    res.json({ ok:true, username, walletAddress, message:"Registration complete. Go back to Telegram!" });
  })
);

// POST /api/miniapp/setup
// Register handle + create server wallet + mark as authorized
miniappRouter.post(
  "/miniapp/setup",
  body("username").isString().matches(/^[a-z0-9_]{3,20}$/),
  body("tgInitData").isString(),
  body("validUntil").isInt({ min: 1 }),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) { res.status(400).json({ ok:false, error:"VALIDATION_ERROR", details:errors.array() }); return; }

    const { username, tgInitData, validUntil } = req.body as {
      username: string; tgInitData: string; validUntil: number;
    };

    // 1. Verify Telegram identity
    const tgVerify = verifyTelegramInitData(tgInitData ?? "");
    const platformId = `telegram:${tgVerify.userId ?? "dev"}`;

    const { getUsernameByPlatform, registerUsername } = await import("../auth/IdentityManager.js");
    const { WalletManager } = await import("../auth/WalletManager.js");
    const db = getDB();
    const wm = new WalletManager();

    // 2. Check Telegram user doesn't own a different handle
    const ownerHandle = tgVerify.userId ? getUsernameByPlatform("telegram", platformId) : null;
    if (ownerHandle && ownerHandle !== username) {
      res.status(403).json({ ok:false, error:"HANDLE_NOT_YOURS",
        message:`Your Telegram owns "${ownerHandle}", not "${username}".` });
      return;
    }

    // 3. Check handle not taken by different Telegram user
    const existingWallet = db.prepare("SELECT address FROM wallets WHERE label = ?").get(username) as any;
    if (existingWallet && !ownerHandle) {
      res.status(409).json({ ok:false, error:"HANDLE_TAKEN",
        message:`Handle "${username}" is already registered.` });
      return;
    }

    // 4. Register identity if new user
    if (!ownerHandle && tgVerify.userId) {
      const result = await registerUsername("telegram", platformId, username);
      if (!result.ok && result.reason !== "ALREADY_REGISTERED") {
        res.status(400).json({ ok:false, error:result.reason }); return;
      }
    }

    // 5. Create Privy server wallet if none exists (auto-funds 0.5 $IP)
    let finalAddress: string;
    if (!existingWallet) {
      const serverWallet = await wm.createWallet(username);
      finalAddress = serverWallet.address;
      log.info("Server wallet created for Mini App user", { username, address: finalAddress });
    } else {
      finalAddress = existingWallet.address;
      log.info("Existing wallet found", { username, address: finalAddress });
    }

    // 6. Store authorization record
    db.prepare(`
      INSERT OR REPLACE INTO delegations (username, wallet_address, signature, valid_until, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(username, finalAddress.toLowerCase(), "miniapp_auth", Number(validUntil), Math.floor(Date.now()/1000));

    log.info("Mini App setup complete", { username, address: finalAddress });
    res.json({ ok:true, username, address: finalAddress, message:"Setup complete! Go back to Telegram." });
  })
);

// POST /api/miniapp/lookup
// Look up handle for a Telegram user — used by Mini App to auto-fill
miniappRouter.post(
  "/miniapp/lookup",
  body("tgInitData").isString(),
  asyncHandler(async (req, res) => {
    const { tgInitData } = req.body;
    const tgVerify = verifyTelegramInitData(tgInitData ?? "");
    if (!tgVerify.ok || !tgVerify.userId) {
      res.json({ ok: false }); return;
    }
    const { getUsernameByPlatform } = await import("../auth/IdentityManager.js");
    const { delegationStore }        = await import("../auth/DelegationStore.js");
    const platformId = `telegram:${tgVerify.userId}`;
    const username   = getUsernameByPlatform("telegram", platformId);
    if (username) {
      const { WalletManager } = await import("../auth/WalletManager.js");
      const wm = new WalletManager();
      const address = wm.hasWallet(username) ? await wm.getAddress(username) : null;
      res.json({ ok: true, username, address, delegated: true });
    } else {
      res.json({ ok: false });
    }
  })
);

// POST /api/miniapp/authorize — just marks user as authorized (simple tgInitData check)
miniappRouter.post("/miniapp/authorize", asyncHandler(async (req, res) => {
  const { tgInitData } = req.body;
  const tgVerify = verifyTelegramInitData(tgInitData ?? "");
  if (!tgVerify.ok) { res.status(403).json({ ok:false, error:"INVALID_TELEGRAM_DATA" }); return; }

  const { getUsernameByPlatform } = await import("../auth/IdentityManager.js");
  const username = getUsernameByPlatform("telegram", `telegram:${tgVerify.userId}`);
  if (!username) { res.status(404).json({ ok:false, error:"NOT_REGISTERED", message:"Register via bot first: register yourhandle" }); return; }

  const { WalletManager } = await import("../auth/WalletManager.js");
  const wm      = new WalletManager();
  const address = await wm.getAddress(username);
  const validUntil = Math.floor(Date.now()/1000) + 7 * 86400;

  getDB().prepare(`
    INSERT OR REPLACE INTO delegations (username, wallet_address, signature, valid_until, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(username, address.toLowerCase(), "miniapp_auth", validUntil, Math.floor(Date.now()/1000));

  log.info("User authorized via Mini App", { username });
  res.json({ ok:true, username, address, message:"Authorized!" });
}));
