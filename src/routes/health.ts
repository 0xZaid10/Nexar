// src/routes/health.ts
// Health check endpoint for Railway/VPS uptime monitoring.

import { Router }      from "express";
import { getDB }       from "../db/index.js";
import { NEXAR_CONTRACTS, CDR_CONTRACTS, NETWORK } from "../core/config.js";

export const healthRouter = Router();

healthRouter.get("/", (_req, res) => {
  // Quick DB check
  let dbOk = false;
  try {
    const db  = getDB();
    const row = db.prepare("SELECT COUNT(*) as n FROM wallets").get() as { n: number };
    dbOk = typeof row.n === "number";
  } catch { dbOk = false; }

  const contracts = {
    ReputationRegistry:       !!NEXAR_CONTRACTS.ReputationRegistry,
    DynamicPricingHook:       !!NEXAR_CONTRACTS.DynamicPricingHook,
    InferenceAccessCondition: !!NEXAR_CONTRACTS.InferenceAccessCondition,
    TimedAccessCondition:     !!NEXAR_CONTRACTS.TimedAccessCondition,
    NEXARRegistry:            !!NEXAR_CONTRACTS.NEXARRegistry,
  };

  const allContractsSet = Object.values(contracts).every(Boolean);

  res.json({
    ok:        dbOk && allContractsSet,
    timestamp: new Date().toISOString(),
    version:   "1.0.0",
    network:   NETWORK.name,
    chainId:   NETWORK.chainId,
    services: {
      db:        dbOk,
      contracts: allContractsSet,
      pinata:    !!process.env.PINATA_JWT,
      privy:     !!process.env.PRIVY_APP_ID,
      hf:        !!process.env.HF_API_TOKEN,
    },
    contracts,
  });
});
