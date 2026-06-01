// src/server.ts
// NEXAR HTTP server — Express with separate routers for API, Spectrum, Telegram, and access links.

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
import { accessRouter }     from "./routes/access.js";
import { spectrumRouter, setSpectrumApp } from "./routes/spectrum.js";
import { telegramRouter }   from "./routes/telegram.js";
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

getDB();

getOperator().catch((err) => {
  log.error("Failed to initialize operator client", { err: String(err) });
  process.exit(1);
});

const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN ?? "*", methods: ["GET", "POST", "PUT", "DELETE"] }));

// ── Raw body for Spectrum webhook MUST come before express.json() ──────────
app.use(
  "/webhook/spectrum",
  express.raw({ type: "application/json" }),
  spectrumLimiter,
  spectrumRouter
);

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, _res, next) => {
  log.info(`${req.method} ${req.path}`);
  next();
});

// ─── Routes ──────────────────────────────────────────────────────────────────

app.use("/health",              healthRouter);
app.use("/api/wallet",          walletLimiter,  walletRouter);
app.use("/api/asset",           assetLimiter,   assetRouter);
app.use("/api/vault",           apiLimiter,     vaultRouter);
app.use("/api/license",         apiLimiter,     licenseRouter);
app.use("/api/royalty",         apiLimiter,     royaltyRouter);
app.use("/access",              accessRouter);   // public download links — no auth needed
app.use("/webhook/telegram",    telegramRouter);

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
    access:   "GET  /access/:token",
    spectrum: "POST /webhook/spectrum",
    telegram: "POST /webhook/telegram",
  });

  log.info("Services", {
    db:       "SQLite — " + (process.env.DB_PATH ?? "./nexar.db"),
    privy:    process.env.PRIVY_APP_ID        ? "✓ MPC wallets"    : "⚠ local mode",
    pinata:   process.env.PINATA_JWT          ? "✓ IPFS pinning"   : "⚠ no pinning",
    hf:       process.env.HF_API_TOKEN        ? "✓ real inference" : "⚠ simulation",
    spectrum: process.env.SPECTRUM_PROJECT_ID ? "✓ connected"      : "⚠ dev mode",
    telegram: process.env.TELEGRAM_BOT_TOKEN  ? "✓ connected"      : "⚠ not configured",
    appUrl:   process.env.NEXAR_APP_URL       ?? "https://nexar.io",
  });

  initSpectrum();
});

// ─── Spectrum SDK init ────────────────────────────────────────────────────────

async function initSpectrum(): Promise<void> {
  const projectId     = process.env.SPECTRUM_PROJECT_ID;
  const projectSecret = process.env.SPECTRUM_PROJECT_SECRET;

  if (!projectId || !projectSecret) {
    log.warn("Spectrum running in dev mode — replies will be logged only");
    return;
  }

  try {
    const { Spectrum } = await import("spectrum-ts");
    const { imessage } = await import("spectrum-ts/providers/imessage");

    const spectrumApp = await Spectrum({
      projectId,
      projectSecret,
      providers: [imessage.config()],
    });

    setSpectrumApp(spectrumApp);
    log.success("Spectrum SDK ready — iMessage live");

    (async () => {
      for await (const [, message] of spectrumApp.messages) {
        if ((message as any).direction === "inbound") continue;
      }
    })().catch((err) => log.error("Spectrum stream error", { err }));

  } catch (err) {
    log.error("Spectrum SDK init failed — messaging in dev mode", { err });
  }
}

export default app;
