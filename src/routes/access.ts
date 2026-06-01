// src/routes/access.ts
// Public access token endpoint — no NEXAR account needed.
// GET /access/:token → verifies token → decrypts file → streams to browser.

import { Router }          from "express";
import { asyncHandler }    from "../middleware/errorHandler.js";
import { getDB }           from "../db/index.js";
import { watermarkFile }   from "../sdk/fingerprint/watermark.js";
import { createLogger }    from "../core/index.js";

const log = createLogger("AccessRoute");

export const accessRouter = Router();

// ─── GET /access/:token ────────────────────────────────────────────────────

accessRouter.get(
  "/:token",
  asyncHandler(async (req, res) => {
    const { token } = req.params;
    const db        = getDB();
    const now       = Math.floor(Date.now() / 1000);

    // 1. Look up token
    const row = db.prepare(
      "SELECT * FROM access_tokens WHERE token = ?"
    ).get(token) as {
      token: string; vault_uuid: string; ip_id: string;
      owner_username: string; asset_name: string;
      single_use: number; uses_remaining: number | null;
      expires_at: number;
    } | undefined;

    if (!row) {
      res.status(404).json({ ok: false, error: "TOKEN_NOT_FOUND", message: "Invalid or expired link." });
      return;
    }

    // 2. Check expiry
    if (row.expires_at < now) {
      res.status(410).json({ ok: false, error: "TOKEN_EXPIRED", message: "This link has expired." });
      return;
    }

    // 3. Check uses remaining
    if (row.single_use && row.uses_remaining !== null && row.uses_remaining <= 0) {
      res.status(410).json({ ok: false, error: "TOKEN_USED", message: "This link has already been used." });
      return;
    }

    // 4. Fetch encrypted content from vault_secrets
    const secret = db.prepare(
      "SELECT cid, aes_key FROM vault_secrets WHERE vault_uuid = ?"
    ).get(row.vault_uuid) as { cid: string; aes_key: Buffer } | undefined;

    if (!secret) {
      log.error("Vault secret not found", { vaultUuid: row.vault_uuid });
      res.status(500).json({ ok: false, error: "VAULT_NOT_FOUND" });
      return;
    }

    // 5. Download from IPFS
    const { downloadFromIPFS } = await import("../sdk/vault/StorageProvider.js");
    const { decrypt }          = await import("../sdk/vault/Encryptor.js");

    let encryptedBytes: Uint8Array;
    try {
      encryptedBytes = await downloadFromIPFS(secret.cid);
    } catch (err) {
      log.error("IPFS download failed", { cid: secret.cid, err });
      res.status(500).json({ ok: false, error: "DOWNLOAD_FAILED" });
      return;
    }

    // 6. Decrypt
    const plainBuffer = Buffer.from(decrypt(encryptedBytes, new Uint8Array(secret.aes_key)));

    // 7. Get mime type
    const fpRow   = db.prepare("SELECT mime_type FROM asset_fingerprints WHERE ip_id = ?").get(row.ip_id) as { mime_type: string | null } | undefined;
    const mimeType = fpRow?.mime_type ?? "application/octet-stream";

    // 8. Watermark with token info
    const licenseInfo = {
      username:       `link:${token.slice(0, 8)}`,
      licenseTokenId: token.slice(0, 12),
      ipId:           row.ip_id,
      ownerUsername:  row.owner_username,
      timestamp:      now,
    };
    const watermarked = watermarkFile(plainBuffer, mimeType, licenseInfo);

    // 9. Decrement uses
    if (row.uses_remaining !== null) {
      db.prepare(
        "UPDATE access_tokens SET uses_remaining = uses_remaining - 1 WHERE token = ?"
      ).run(token);
    }

    log.info("Access token used", {
      token:     token.slice(0, 8) + "...",
      assetName: row.asset_name,
      singleUse: row.single_use,
    });

    // 10. Stream file to browser
    const safeFileName = row.asset_name.replace(/[^a-z0-9._-]/gi, "_");
    res.setHeader("Content-Type", mimeType);
    res.setHeader("Content-Disposition", `attachment; filename="${safeFileName}"`);
    res.setHeader("Content-Length", watermarked.length.toString());
    res.setHeader("X-Nexar-Asset", row.ip_id);
    res.setHeader("X-Nexar-Owner", row.owner_username);
    res.send(watermarked);
  })
);

// ─── GET /access/:token/info ───────────────────────────────────────────────
// Preview token metadata without downloading (for link preview pages).

accessRouter.get(
  "/:token/info",
  asyncHandler(async (req, res) => {
    const { token } = req.params;
    const db        = getDB();
    const now       = Math.floor(Date.now() / 1000);

    const row = db.prepare("SELECT * FROM access_tokens WHERE token = ?").get(token) as {
      asset_name: string; owner_username: string; single_use: number;
      uses_remaining: number | null; expires_at: number;
    } | undefined;

    if (!row) {
      res.status(404).json({ ok: false, error: "TOKEN_NOT_FOUND" });
      return;
    }

    const expired = row.expires_at < now;
    const used    = row.single_use && row.uses_remaining !== null && row.uses_remaining <= 0;

    res.json({
      ok:            true,
      assetName:     row.asset_name,
      ownerUsername: row.owner_username,
      singleUse:     row.single_use === 1,
      usesRemaining: row.uses_remaining,
      expiresAt:     new Date(row.expires_at * 1000).toISOString(),
      expired,
      used,
      valid:         !expired && !used,
    });
  })
);
