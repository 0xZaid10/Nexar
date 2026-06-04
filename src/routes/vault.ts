// src/routes/vault.ts
// Vault endpoints — access CDR vaults with proper user-signed reads.
// POST /api/vault/access  → uses delegation → CDR read with user wallet
// POST /api/vault/timed   → create time-limited vault (unchanged)
// POST /api/vault/session → create reviewer session (unchanged)

import { Router }                    from "express";
import { body, validationResult }    from "express-validator";
import { asyncHandler }              from "../middleware/errorHandler.js";
import { getDB }                     from "../db/index.js";
import { getOperator }               from "../core/operator.js";
import { getUserClients }            from "../core/userClients.js";
import { VaultManager }              from "../sdk/vault/VaultManager.js";
import { SessionManager }            from "../auth/SessionManager.js";
import { WalletManager }             from "../auth/WalletManager.js";
import { delegationStore }           from "../auth/DelegationStore.js";
import { timed }                     from "../sdk/vault/ConditionBuilder.js";
import { NEXAR_CONTRACTS, CDR_TIMEOUT_MS, SESSION_TTL } from "../core/config.js";
import { createLogger }              from "../core/logger.js";
import type { HexAddress }           from "../core/types.js";

export const vaultRouter = Router();
const log        = createLogger("VaultRoute");
const sessionMgr = new SessionManager();
const walletMgr  = new WalletManager();

// ─── POST /api/vault/access ───────────────────────────────────────────────────
// Decrypt a CDR vault.
// Priority order:
//   1. User has delegation → CDR read with user's wallet (proper, trustless)
//   2. Fallback → DB key store (backward compat for existing assets)

vaultRouter.post(
  "/access",
  body("vaultUuid").isString().notEmpty(),
  body("licenseTokenIds").isArray({ min: 1 }),
  body("label").isString().notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ ok: false, error: "VALIDATION_ERROR", details: errors.array() });
      return;
    }

    const { label, vaultUuid, licenseTokenIds } = req.body as {
      label:           string;
      vaultUuid:       string;
      licenseTokenIds: string[];
    };

    log.info("Vault access request", { label, vaultUuid });

    // ── Path 1: User has delegation → proper CDR read ───────────────────────
    if (delegationStore.hasValidDelegation(label)) {
      log.info("Using CDR delegation path", { label });
      try {
        const { cdrClient } = await getUserClients(label);
        const vaultMgr      = new VaultManager(cdrClient);

        const result = await vaultMgr.accessFileVault({
          uuid:            BigInt(vaultUuid),
          licenseTokenIds: licenseTokenIds.map(BigInt),
        });

        res.json({
          ok:       true,
          vaultUuid,
          content:  Buffer.from(result.content!).toString("base64"),
          txHash:   result.txHash,
          path:     "cdr_delegation",
        });
        return;
      } catch (err: any) {
        log.warn("CDR delegation read failed, trying fallback", { label, err: err.message });
        // Fall through to DB path
      }
    }

    // No license found and not owner — access denied
    res.status(403).json({
      ok:      false,
      error:   "VAULT_ACCESS_DENIED",
      message: `No valid license found for vault ${vaultUuid}. Purchase a license to access this file.`,
    });
  })
);

// ─── POST /api/vault/timed ────────────────────────────────────────────────────
// Create a time-limited vault (NDA use case). Unchanged.

vaultRouter.post(
  "/timed",
  body("label").isString().notEmpty(),
  body("ipId").isString().notEmpty(),
  body("content").isString().notEmpty(),
  body("contentType").isString().notEmpty(),
  body("ttlSeconds").isInt({ min: 60 }),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ ok: false, error: "VALIDATION_ERROR", details: errors.array() });
      return;
    }

    const { label, ipId, content, contentType, ttlSeconds } = req.body as {
      label:       string;
      ipId:        string;
      content:     string;
      contentType: string;
      ttlSeconds:  number;
    };

    if (!walletMgr.hasWallet(label)) await walletMgr.createWallet(label);
    const { cdrClient, account: opAccount } = await getOperator();
    const operatorAddr  = opAccount.address as HexAddress;
    const vaultMgr      = new VaultManager(cdrClient);
    const expiryTimestamp = BigInt(Math.floor(Date.now() / 1000) + ttlSeconds);
    const contentBytes    = new Uint8Array(Buffer.from(content, "base64"));
    const condition       = timed({ ownerAddress: operatorAddr, ipId: ipId as HexAddress, expiryTimestamp });
    const isLargeContent  = contentBytes.length > 800;

    let vault: any;
    if (isLargeContent) {
      vault = await vaultMgr.createFileVault({
        content: contentBytes, contentType,
        conditionData: { ownerAddress: operatorAddr, ipId: ipId as HexAddress, expiryTimestamp } as any,
        writeConditionAddr: condition.writeConditionAddr, readConditionAddr: condition.readConditionAddr,
        writeConditionData: condition.writeConditionData, readConditionData: condition.readConditionData,
        updatable: false,
      });
    } else {
      vault = await vaultMgr.createSecretVault({
        dataKey: contentBytes,
        conditionData: { ownerAddress: operatorAddr, ipId: ipId as HexAddress } as any,
        writeConditionAddr: condition.writeConditionAddr, readConditionAddr: condition.readConditionAddr,
        writeConditionData: condition.writeConditionData, readConditionData: condition.readConditionData,
        updatable: false,
      });
    }

    // Store in DB for backward compat
    try {
      getDB().prepare("INSERT OR REPLACE INTO vault_secrets (vault_uuid, cid, aes_key) VALUES (?,?,?)").run(
        vault.uuid.toString(), vault.cid ?? "", Buffer.from(vault.aesKey ?? [])
      );
    } catch { /* ignore */ }

    res.status(201).json({
      ok:              true,
      vaultUuid:       vault.uuid.toString(),
      expiryAt:        new Date(Number(expiryTimestamp) * 1000).toISOString(),
      expiryTimestamp: expiryTimestamp.toString(),
      ttlSeconds,
    });
  })
);

// ─── POST /api/vault/session ──────────────────────────────────────────────────

vaultRouter.post(
  "/session",
  body("reviewerLabel").isString().notEmpty(),
  body("vaultUuid").isString().notEmpty(),
  body("ipId").isString().notEmpty(),
  body("ttlSeconds").optional().isInt({ min: 60 }),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ ok: false, error: "VALIDATION_ERROR", details: errors.array() });
      return;
    }
    const { reviewerLabel, vaultUuid, ipId, ttlSeconds } = req.body;
    if (!walletMgr.hasWallet(reviewerLabel)) await walletMgr.createWallet(reviewerLabel);
    const address = await walletMgr.getAddress(reviewerLabel);
    const session = sessionMgr.createReviewerSession({
      reviewerAddress: address,
      vaultUuid:       BigInt(vaultUuid),
      ipId:            ipId as HexAddress,
      ttl:             ttlSeconds ?? SESSION_TTL.MEDIUM,
    });
    res.json({ ok: true, token: session.token, address, expiresAt: new Date(session.expiresAt * 1000).toISOString() });
  })
);
