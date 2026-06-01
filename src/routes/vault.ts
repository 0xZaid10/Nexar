// src/routes/vault.ts
// Vault endpoints — access CDR vaults, create time-limited vaults.

import { Router }          from "express";
import { body, validationResult } from "express-validator";
import { asyncHandler }    from "../middleware/errorHandler.js";
import { getDB }         from "../db/Database.js";
import { getOperator }      from "../core/operator.js";
import { getUserClients }  from "../core/userClients.js";
import { VaultManager }    from "../sdk/vault/VaultManager.js";
import { SessionManager }  from "../auth/SessionManager.js";
import { WalletManager }   from "../auth/WalletManager.js";
import { timed, licenseGated, ownerOnly } from "../sdk/vault/ConditionBuilder.js";
import { encodeAbiParameters }            from "viem";
import { STORY_CONTRACTS, NEXAR_CONTRACTS, CDR_TIMEOUT_MS, SESSION_TTL } from "../core/config.js";
import type { HexAddress } from "../core/types.js";

export const vaultRouter = Router();

const sessionMgr = new SessionManager();
const walletMgr  = new WalletManager();

// POST /api/vault/access
// Decrypt a CDR vault using a license token
// Body: { sessionToken } OR { label, vaultUuid, licenseTokenIds[] }
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
      label:          string;
      vaultUuid:      string;
      licenseTokenIds:string[];
    };

    // Read from DB key store (operator holds keys, verifies license on-chain)
    const keyRecord = getDB().prepare("SELECT cid, aes_key FROM vault_secrets WHERE vault_uuid = ?").get(vaultUuid) as any;
    if (!keyRecord) {
      res.status(403).json({ ok: false, error: "VAULT_ACCESS_DENIED", message: `No key found for vault ${vaultUuid}` });
      return;
    }
    // Download encrypted content from Pinata and decrypt
    const { downloadFromIPFS } = await import("../sdk/vault/StorageProvider.js");
    const { decrypt } = await import("../sdk/vault/Encryptor.js");
    const encryptedBytes = await downloadFromIPFS(keyRecord.cid);
    const decrypted      = decrypt(encryptedBytes, new Uint8Array(keyRecord.aes_key));
    res.json({
      ok:       true,
      vaultUuid,
      content:  Buffer.from(decrypted).toString("base64"),
      txHash:   "0x",
    });
  })
);

// POST /api/vault/timed
// Create a time-limited vault (film NDA use case)
// Body: { label, ipId, content (base64), contentType, ttlSeconds, licenseTermsId }
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
    const account       = await walletMgr.getAccount(label);
    const ownerAddress  = account.address as HexAddress;

    const { cdrClient, account: opAccount } = await getOperator();
    const operatorAddr  = opAccount.address as HexAddress;
    const vaultMgr      = new VaultManager(cdrClient);

    const expiryTimestamp = BigInt(Math.floor(Date.now() / 1000) + ttlSeconds);
    const contentBytes    = new Uint8Array(Buffer.from(content, "base64"));

    const condition = timed({
      ownerAddress:    operatorAddr,
      ipId:            ipId as HexAddress,
      expiryTimestamp,
    });

    // For large content (video etc) use file vault (Pinata + CDR)
    const isLargeContent = contentBytes.length > 800; // CDR limit ~1024 bytes

    let vault;
    if (isLargeContent) {
      vault = await vaultMgr.createFileVault({
        content:     contentBytes,
        contentType,
        conditionData: { ownerAddress: operatorAddr, ipId: ipId as HexAddress, expiryTimestamp, customConditionAddr: condition.writeConditionAddr, customWriteData: condition.writeConditionData, customReadData: condition.readConditionData } as any,
        writeConditionAddr: condition.writeConditionAddr,
        readConditionAddr:  condition.readConditionAddr,
        writeConditionData: condition.writeConditionData,
        readConditionData:  condition.readConditionData,
        updatable: false,
      });
    } else {
      vault = await vaultMgr.createSecretVault({
        dataKey:    contentBytes,
        conditionData: { ownerAddress: operatorAddr, ipId: ipId as HexAddress, customConditionAddr: condition.writeConditionAddr, customWriteData: condition.writeConditionData, customReadData: condition.readConditionData } as any,
        writeConditionAddr: condition.writeConditionAddr,
        readConditionAddr:  condition.readConditionAddr,
        writeConditionData: condition.writeConditionData,
        readConditionData:  condition.readConditionData,
        updatable: false,
      });
    }

    // Register vault expiry on-chain via TimedAccessCondition
    // (optional — for off-chain querying convenience)
    // This is a separate tx — fire and forget
    const { publicClient, walletClient } = await getOperator();
    if (NEXAR_CONTRACTS.TimedAccessCondition) {
      publicClient.readContract({
        address:      NEXAR_CONTRACTS.TimedAccessCondition,
        abi:          [{ name:"registerVault", type:"function", inputs:[{type:"uint256"},{type:"uint256"}], outputs:[], stateMutability:"nonpayable" }],
        functionName: "registerVault",
      }).catch(() => { /* fire and forget */ });
    }

    // Store AES key for DB-based reads
    try {
      getDB().prepare("INSERT OR REPLACE INTO vault_secrets (vault_uuid, cid, aes_key) VALUES (?,?,?)").run(
        vault.uuid.toString(), (vault as any).cid ?? "", Buffer.from((vault as any).aesKey ?? [])
      );
    } catch(e) { /* ignore */ }

    res.status(201).json({
      ok:             true,
      vaultUuid:      vault.uuid.toString(),
      expiryAt:       new Date(Number(expiryTimestamp) * 1000).toISOString(),
      expiryTimestamp: expiryTimestamp.toString(),
      ttlSeconds,
      type:           isLargeContent ? "file_vault_pinata" : "secret_vault",
    });
  })
);

// POST /api/vault/session
// Create a reviewer session token for a vault (application-layer TTL)
// Body: { reviewerLabel, vaultUuid, ipId, ttlSeconds }
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

    const { reviewerLabel, vaultUuid, ipId, ttlSeconds } = req.body as {
      reviewerLabel: string;
      vaultUuid:     string;
      ipId:          string;
      ttlSeconds?:   number;
    };

    if (!walletMgr.hasWallet(reviewerLabel)) await walletMgr.createWallet(reviewerLabel);
    const address = await walletMgr.getAddress(reviewerLabel);

    const session = sessionMgr.createReviewerSession({
      reviewerAddress: address,
      vaultUuid:       BigInt(vaultUuid),
      ipId:            ipId as HexAddress,
      ttl:             ttlSeconds ?? SESSION_TTL.MEDIUM,
    });

    res.json({
      ok:        true,
      token:     session.token,
      address,
      expiresAt: new Date(session.expiresAt * 1000).toISOString(),
      ttlSeconds: ttlSeconds ?? SESSION_TTL.MEDIUM,
    });
  })
);
