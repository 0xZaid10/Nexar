// src/routes/license.ts
// License endpoints — mint license tokens with WIP payment, query holdings.
// Per-user signing: buyer's Privy wallet signs and pays — not the operator.

import { Router }          from "express";
import { body, validationResult } from "express-validator";
import { asyncHandler }    from "../middleware/errorHandler.js";
import { LicensingEngine } from "../licensing/LicensingEngine.js";
import { WalletManager }   from "../auth/WalletManager.js";
import { getUserClients }  from "../core/userClients.js";
import { getOperator }      from "../core/operator.js";
import { getOperator }     from "../core/operator.js";
import { getDB }           from "../db/index.js";
import type { HexAddress } from "../core/types.js";

export const licenseRouter = Router();
const walletMgr = new WalletManager();

// POST /api/license/mint
// Mint a license token — buyer's wallet signs and pays WIP fee
// Body: { licensorIpId, licenseTermsId, buyerLabel, mintingFee?, amount? }
licenseRouter.post(
  "/mint",
  body("licensorIpId").isString().notEmpty(),
  body("licenseTermsId").isString().notEmpty(),
  body("buyerLabel").isString().notEmpty(),
  body("mintingFee").optional().isString(),   // WIP amount in wei (string for BigInt)
  body("amount").optional().isInt({ min: 1, max: 10 }),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ ok: false, error: "VALIDATION_ERROR", details: errors.array() });
      return;
    }

    const { licensorIpId, licenseTermsId, buyerLabel, mintingFee, amount } = req.body as {
      licensorIpId:   string;
      licenseTermsId: string;
      buyerLabel:     string;
      mintingFee?:    string;
      amount?:        number;
    };

    // Get buyer wallet address (they receive the token)
    // Operator signs the transaction (pays gas — buyer needs no IP)
    const buyerAddress = await walletMgr.getAddress(buyerLabel);
    const fee          = BigInt(mintingFee ?? "0");

    // Operator pays gas — buyer receives the license token
    const { storyClient } = await getOperator();
    const licensing = new LicensingEngine(storyClient);

    let result;
    if (fee > 0n) {
      // Real payment flow — approve WIP + mint
      result = await licensing.mintWithPayment({
        licensorIpId:      licensorIpId as HexAddress,
        licenseTermsId:    BigInt(licenseTermsId),
        receiver:          buyerAddress as HexAddress,
        amount:            amount ?? 1,
        mintingFee:        fee,
        buyerWalletClient: buyer.walletClient,
        buyerPublicClient: buyer.publicClient,
      });
    } else {
      // Free license (non-commercial, zero fee)
      result = await licensing.mintLicenseTokens({
        licensorIpId:   licensorIpId as HexAddress,
        licenseTermsId: BigInt(licenseTermsId),
        receiver:       buyerAddress as HexAddress,
        amount:         amount ?? 1,
      });
    }

    // Persist to local DB
    const db = getDB();
    for (const tokenId of result.licenseTokenIds) {
      try {
        db.prepare(
          `INSERT OR IGNORE INTO licenses
           (license_token_id, licensor_ip_id, license_terms_id, holder_address, tx_hash)
           VALUES (?, ?, ?, ?, ?)`
        ).run(tokenId.toString(), licensorIpId, licenseTermsId, buyerAddress, result.txHash ?? null);
      } catch { /* ignore duplicate */ }
    }

    res.status(201).json({
      ok:              true,
      licenseTokenIds: result.licenseTokenIds.map(String),
      licensorIpId,
      licenseTermsId,
      receiver:        buyerAddress,
      buyerLabel,
      feePaid:         fee.toString(),
      txHash:          result.txHash,
    });
  })
);

// POST /api/license/terms/get-fee
// Check minting fee for a license (so caller knows how much WIP to approve)
licenseRouter.post(
  "/terms/get-fee",
  body("licensorIpId").isString().notEmpty(),
  body("licenseTermsId").isString().notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ ok: false, error: "VALIDATION_ERROR", details: errors.array() });
      return;
    }

    const { licensorIpId, licenseTermsId } = req.body as { licensorIpId: string; licenseTermsId: string };
    const { storyClient } = await getOperator();
    const licensing       = new LicensingEngine(storyClient);
    const terms           = await licensing.getLicenseTerms(BigInt(licenseTermsId));

    res.json({
      ok:            true,
      licensorIpId,
      licenseTermsId,
      mintingFee:    terms?.defaultMintingFee?.toString() ?? "0",
      currency:      terms?.currency ?? "0x0",
      commercial:    terms?.commercialUse ?? false,
    });
  })
);

// GET /api/license/held/:label
licenseRouter.get(
  "/held/:label",
  asyncHandler(async (req, res) => {
    const { label } = req.params;
    if (!walletMgr.hasWallet(label)) {
      res.json({ ok: true, count: 0, licenses: [] });
      return;
    }
    const address = await walletMgr.getAddress(label);
    const db      = getDB();
    const rows    = db.prepare(
      "SELECT * FROM licenses WHERE holder_address = ? ORDER BY minted_at DESC"
    ).all(address);
    res.json({ ok: true, count: rows.length, address, licenses: rows });
  })
);

// GET /api/license/issued/:ipId
licenseRouter.get(
  "/issued/:ipId",
  asyncHandler(async (req, res) => {
    const db   = getDB();
    const rows = db.prepare(
      "SELECT * FROM licenses WHERE licensor_ip_id = ? ORDER BY minted_at DESC"
    ).all(req.params.ipId);
    res.json({ ok: true, count: rows.length, licenses: rows });
  })
);
