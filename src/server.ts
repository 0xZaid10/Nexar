// src/server.ts
// NEXAR HTTP server — Express with separate routers for API and Spectrum.

import "dotenv/config";
import express              from "express";
import helmet               from "helmet";
import cors                 from "cors";

import { validateEnv, validateDeployedContracts, NETWORK } from "./core/config.js";
import { getDB }            from "./db/index.js";
import { getOperator }      from "./core/operator.js";
import { createLogger }     from "./core/logger.js";

import { healthRouter }     from "./routes/health.js";
import { walletRouter }     from "./routes/wallet.js";
import { assetRouter }      from "./routes/asset.js";
import { vaultRouter }      from "./routes/vault.js";
import { licenseRouter }    from "./routes/license.js";
import { royaltyRouter }    from "./routes/royalty.js";
import { spectrumRouter }   from "./routes/spectrum.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import {
  apiLimiter,
  walletLimiter,
  assetLimiter,
  spectrumLimiter,
} from "./middleware/rateLimiter.js";

const log  = createLogger("Server");
const PORT = Number(process.env.PORT ?? 3001);

validateEnv();
validateDeployedContracts();

// Init DB
getDB();

// Pre-warm operator client (avoids cold start on first request)
getOperator().catch((err) => {
  log.error("Failed to initialize operator client", { err: String(err) });
  process.exit(1);
});

const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN ?? "*", methods: ["GET", "POST", "PUT", "DELETE"] }));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, _res, next) => {
  log.info(`${req.method} ${req.path}`);
  next();
});

// ─── Routes ──────────────────────────────────────────────────────────────────

app.use("/health",                         healthRouter);
app.use("/api/wallet",   walletLimiter,    walletRouter);
app.use("/api/asset",    assetLimiter,     assetRouter);
app.use("/api/vault",    apiLimiter,       vaultRouter);
app.use("/api/license",  apiLimiter,       licenseRouter);
app.use("/api/royalty",  apiLimiter,       royaltyRouter);
app.use("/webhook/spectrum", spectrumLimiter, spectrumRouter);

app.use(notFound);
app.use(errorHandler);

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`
  ██╗   ██╗███████╗██╗  ██╗ █████╗ ██████╗
  ████╗  ██║██╔════╝╚██╗██╔╝██╔══██╗██╔══██╗
  ██╔██╗ ██║█████╗   ╚███╔╝ ███████║██████╔╝
  ██║╚██╗██║██╔══╝   ██╔██╗ ██╔══██║██╔══██╗
  ██║ ╚████║███████╗██╔╝ ██╗██║  ██║██║  ██║
  ╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝

  Private Intelligence Graph — Server v1.0.0
  `);

  log.success(`Server running on port ${PORT}`, {
    network: NETWORK.name,
    chainId: NETWORK.chainId.toString(),
  });

  log.info("Routes", {
    health:   "GET  /health",
    wallet:   "POST /api/wallet/create",
    asset:    "POST /api/asset/register",
    vault:    "POST /api/vault/access",
    license:  "POST /api/license/mint",
    royalty:  "GET  /api/royalty/:ipId/claimable",
    spectrum: "POST /webhook/spectrum",
  });

  log.info("Services", {
    db:      "SQLite — " + (process.env.DB_PATH ?? "./nexar.db"),
    privy:   process.env.PRIVY_APP_ID    ? "✓ MPC wallets"    : "⚠ local mode",
    pinata:  process.env.PINATA_JWT      ? "✓ IPFS pinning"   : "⚠ no pinning",
    hf:      process.env.HF_API_TOKEN    ? "✓ real inference" : "⚠ simulation",
    spectrum:process.env.SPECTRUM_PROJECT_ID ? "✓ connected"  : "⚠ dev mode",
  });
});

export default app;
