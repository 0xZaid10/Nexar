// src/routes/royalty.ts
// Royalty endpoints — check claimable earnings, claim revenue.

import { Router }        from "express";
import { body, validationResult } from "express-validator";
import { asyncHandler }  from "../middleware/errorHandler.js";
import { getOperator }    from "../core/operator.js";
import { RoyaltyEngine } from "../licensing/RoyaltyEngine.js";
import type { HexAddress } from "../core/types.js";

export const royaltyRouter = Router();

// GET /api/royalty/:ipId/claimable
// Check how much WIP is claimable for an IP Asset
royaltyRouter.get(
  "/:ipId/claimable",
  asyncHandler(async (req, res) => {
    const { storyClient } = await getOperator();
    const engine          = new RoyaltyEngine(storyClient);
    const claimable       = await engine.getClaimable(req.params.ipId as HexAddress);

    res.json({
      ok:        true,
      ipId:      req.params.ipId,
      claimable: claimable.toString(),
      claimableEth: (Number(claimable) / 1e18).toFixed(6),
    });
  })
);

// POST /api/royalty/claim
// Claim all revenue for an IP Asset from its derivatives
// Body: { ancestorIpId, childIpIds[] }
royaltyRouter.post(
  "/claim",
  body("ancestorIpId").isString().notEmpty(),
  body("childIpIds").isArray(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ ok: false, error: "VALIDATION_ERROR", details: errors.array() });
      return;
    }

    const { ancestorIpId, childIpIds } = req.body as {
      ancestorIpId: string;
      childIpIds:   string[];
    };

    const { storyClient } = await getOperator();
    const engine          = new RoyaltyEngine(storyClient);

    const result = await engine.claimAll(
      ancestorIpId as HexAddress,
      childIpIds   as HexAddress[]
    );

    res.json({
      ok:           true,
      ancestorIpId,
      childIpIds,
      txHash:       result.txHash ?? null,
    });
  })
);

// POST /api/royalty/pay
// Pay royalties to an IP Asset
// Body: { receiverIpId, amount (wei string), payerIpId? }
royaltyRouter.post(
  "/pay",
  body("receiverIpId").isString().notEmpty(),
  body("amount").isString().notEmpty(),
  asyncHandler(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ ok: false, error: "VALIDATION_ERROR", details: errors.array() });
      return;
    }

    const { receiverIpId, amount, payerIpId } = req.body as {
      receiverIpId: string;
      amount:       string;
      payerIpId?:   string;
    };

    const { storyClient } = await getOperator();
    const engine          = new RoyaltyEngine(storyClient);

    const txHash = await engine.pay(
      receiverIpId as HexAddress,
      (payerIpId ?? null) as HexAddress | null,
      BigInt(amount)
    );

    res.json({ ok: true, receiverIpId, amount, txHash });
  })
);
