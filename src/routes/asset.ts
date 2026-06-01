// src/routes/asset.ts
// Asset endpoints — register intelligence assets as Story IP + CDR vault.
// Per-user signing: creator's Privy wallet owns and registers the IP.

import { Router }          from "express";
import { body, validationResult } from "express-validator";
import { asyncHandler }    from "../middleware/errorHandler.js";
import { AssetRegistry }   from "../sdk/asset/AssetRegistry.js";
import { WalletManager }   from "../auth/WalletManager.js";
import { getOperator }     from "../core/operator.js";
import { AssetTier }       from "../core/config.js";
import { getDB }           from "../db/index.js";
import type { HexAddress } from "../core/types.js";

export const assetRouter = Router();
const walletMgr = new WalletManager();

// POST /api/asset/register
// Register an intelligence asset — creator's Privy wallet is the IP owner
// Body: { label, name, description, tier, content (base64), contentType, commercial, revShare, basePrice }
assetRouter.post(
  "/register",
  body("label").isString().notEmpty(),
  body("name").isString().notEmpty(),
  body("description").isString().notEmpty(),
  body("tier").isString().notEmpty(),
  body("content").isString().notEmpty(),
  body("contentType").isString().notEmpty(),
  body("commercial").isBoolean(),
  body("revShare").isFloat({ min: 0, max: 100 }),
  body("basePrice").isString(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ ok: false, error: "VALIDATION_ERROR", details: errors.array() });
      return;
    }

    const { label, name, description, tier, content, contentType, commercial, revShare, basePrice } =
      req.body as {
        label:       string;
        name:        string;
        description: string;
        tier:        string;
        content:     string;
        contentType: string;
        commercial:  boolean;
        revShare:    number;
        basePrice:   string;
      };

    // Accept both string names ("DATASET") and numeric values (0)
    const TIER_MAP: Record<string, AssetTier> = {
      "DATASET":   AssetTier.DATASET,
      "MODEL":     AssetTier.MODEL,
      "STRATEGY":  AssetTier.STRATEGY,
      "INFERENCE": AssetTier.INFERENCE,
      "PROMPT":    AssetTier.PROMPT,
      "0": AssetTier.DATASET, "1": AssetTier.MODEL,
      "2": AssetTier.STRATEGY, "3": AssetTier.INFERENCE, "4": AssetTier.PROMPT,
    };
    const resolvedTier = TIER_MAP[String(tier).toUpperCase()] ?? TIER_MAP[String(tier)];
    if (resolvedTier === undefined) {
      res.status(400).json({ ok: false, error: "VALIDATION_ERROR", message: `Unknown tier: ${tier}. Use DATASET, MODEL, STRATEGY, INFERENCE, or PROMPT` });
      return;
    }

    // Get or create user's Privy wallet — their address will own the IP
    if (!walletMgr.hasWallet(label)) await walletMgr.createWallet(label);
    const ownerAddress = await walletMgr.getAddress(label);

    // Operator pays gas — user owns the IP (NFT minted to their address)
    // Operator signs the CDR write transaction (signerAddress)
    // User's address is set as IP recipient (ownerAddress)
    const { storyClient, cdrClient, account } = await getOperator();
    const operatorAddress = account.address as HexAddress;
    const registry = new AssetRegistry(storyClient, cdrClient, ownerAddress, operatorAddress);

    const contentBytes = Buffer.from(content, "base64");

    const asset = await registry.register({
      tier:        resolvedTier,
      name,
      description,
      content:     new Uint8Array(contentBytes),
      contentType,
      creators:    [{ name: label, address: ownerAddress, contributionPercent: 100 }],
      commercial,
      revShare,
      basePrice,
    });

    // Persist to local DB
    const db = getDB();
    try {
      db.prepare(
        `INSERT OR IGNORE INTO assets (ip_id, vault_uuid, tier, owner, name, asset_type)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(asset.ipId, asset.vaultUuid.toString(), resolvedTier, ownerAddress, name, String(tier).toUpperCase());
    } catch { /* ignore duplicate */ }

    // Store AES key so vault access can decrypt without CDR read permission
    if ((asset as any).vaultAesKey) {
      try {
        db.prepare("INSERT OR REPLACE INTO vault_secrets (vault_uuid, cid, aes_key) VALUES (?,?,?)").run(
          asset.vaultUuid.toString(),
          (asset as any).vaultCid ?? "",
          Buffer.from((asset as any).vaultAesKey)
        );
      } catch { /* ignore */ }
    }

    res.status(201).json({
      ok:        true,
      ipId:      asset.ipId,
      vaultUuid: asset.vaultUuid.toString(),
      owner:     ownerAddress,
      name,
      tier,
      licenseTermsId: asset.licenseTermsId?.toString() ?? '0',
      explorer:  `https://aeneid.explorer.story.foundation/ipa/${asset.ipId}`,
    });
  })
);

// GET /api/asset/:ipId
assetRouter.get(
  "/:ipId",
  asyncHandler(async (req, res) => {
    const db  = getDB();
    const row = db.prepare("SELECT * FROM assets WHERE ip_id = ?").get(req.params.ipId) as {
      ip_id: string; vault_uuid: string; tier: number; owner: string;
      name: string; asset_type: string; active: number; created_at: number;
    } | undefined;

    if (!row) {
      res.status(404).json({ ok: false, error: "NOT_FOUND", message: "Asset not found" });
      return;
    }

    res.json({
      ok:        true,
      ipId:      row.ip_id,
      vaultUuid: row.vault_uuid,
      tier:      row.asset_type,
      owner:     row.owner,
      name:      row.name,
      active:    row.active === 1,
      createdAt: new Date(row.created_at * 1000).toISOString(),
      explorer:  `https://aeneid.explorer.story.foundation/ipa/${row.ip_id}`,
    });
  })
);

// GET /api/asset — list all assets (optional ?owner= filter)
assetRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const db    = getDB();
    const owner = req.query.owner as string | undefined;
    const rows  = owner
      ? db.prepare("SELECT * FROM assets WHERE owner = ? AND active = 1 ORDER BY created_at DESC").all(owner)
      : db.prepare("SELECT * FROM assets WHERE active = 1 ORDER BY created_at DESC").all();
    res.json({ ok: true, count: rows.length, assets: rows });
  })
);
