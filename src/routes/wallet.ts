// src/routes/wallet.ts
// Wallet endpoints — create Privy MPC wallet per user, lookup address.

import { Router }        from "express";
import { body, validationResult } from "express-validator";
import { WalletManager } from "../auth/WalletManager.js";
import { asyncHandler }  from "../middleware/errorHandler.js";

export const walletRouter = Router();
const mgr = new WalletManager();

// POST /api/wallet/create
// Body: { label: "email@example.com" }
walletRouter.post(
  "/create",
  body("label").isString().notEmpty().trim(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ ok: false, error: "VALIDATION_ERROR", details: errors.array() });
      return;
    }

    const { label } = req.body as { label: string };
    const record    = await mgr.createWallet(label);

    res.json({
      ok:      true,
      label:   record.label,
      address: record.address,
      mode:    mgr.isPrivyWallet(label) ? "privy_mpc" : "local_encrypted",
    });
  })
);

// GET /api/wallet/:label
walletRouter.get(
  "/:label",
  asyncHandler(async (req, res) => {
    const { label } = req.params;
    const record    = await mgr.getWallet(label);

    res.json({
      ok:      true,
      label:   record.label,
      address: record.address,
      mode:    mgr.isPrivyWallet(label) ? "privy_mpc" : "local_encrypted",
    });
  })
);

// GET /api/wallet
// List all wallet labels
walletRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const labels = mgr.listLabels();
    res.json({ ok: true, count: labels.length, labels });
  })
);
