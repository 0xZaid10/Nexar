// src/index.ts
// NEXAR root entry point — exports all 5 layers and the full-stack orchestrator.
// Developers import from here for the complete NEXAR experience,
// or from individual layer paths for standalone use:
//   import { VaultManager }     from "@nexar/sdk"
//   import { SessionManager }   from "@nexar/auth"
//   import { LicensingEngine }  from "@nexar/licensing"
//   import { InferenceRuntime } from "@nexar/runtime"
//   import { ConsumerAgent }    from "@nexar/agents"

// ─── Core (shared across all layers) ─────────────────────────────────────────
export * from "./core/index.js";

// ─── Layer 1: Confidential Asset SDK ─────────────────────────────────────────
export * from "./sdk/index.js";

// ─── Layer 2: Identity + Access ───────────────────────────────────────────────
export * from "./auth/index.js";

// ─── Layer 3: Programmable Licensing ─────────────────────────────────────────
export * from "./licensing/index.js";
export { RoyaltyEngine } from "./licensing/RoyaltyEngine.js";

// ─── Layer 4: Confidential Runtime ───────────────────────────────────────────
export * from "./runtime/index.js";

// ─── Layer 5: Agent Coordination ─────────────────────────────────────────────
export * from "./agents/index.js";
export { InferenceAgent }           from "./agents/InferenceAgent.js";
export { PoolManager }              from "./agents/pool/PoolManager.js";

// ─── Full-stack convenience re-exports ────────────────────────────────────────

/**
 * Initialize the full NEXAR stack in one call.
 * Returns all clients and layer instances pre-wired.
 *
 * @param privateKey - Operator private key (hex string)
 */
export async function initNEXAR(privateKey: string) {
  const { initClients } = await import("./core/clients.js");
  const { validateEnv } = await import("./core/config.js");

  validateEnv();

  const clients = await initClients(privateKey);

  const { LicensingEngine }  = await import("./licensing/LicensingEngine.js");
  const { DerivativeEngine } = await import("./licensing/DerivativeEngine.js");
  const { RoyaltyEngine }    = await import("./licensing/RoyaltyEngine.js");
  const { HookManager }      = await import("./licensing/HookManager.js");
  const { PILBuilder }       = await import("./licensing/PILBuilder.js");
  const { VaultManager }     = await import("./sdk/vault/VaultManager.js");
  const { AssetRegistry }    = await import("./sdk/asset/AssetRegistry.js");
  const { SessionManager }   = await import("./auth/SessionManager.js");
  const { GasRelayer }       = await import("./auth/GasRelayer.js");
  const { AccessDelegate }   = await import("./auth/AccessDelegate.js");
  const { SessionTokens }    = await import("./runtime/SessionTokens.js");
  const { QuotaEnforcer }    = await import("./runtime/QuotaEnforcer.js");
  const { AccessVerifier }   = await import("./runtime/AccessVerifier.js");
  const { StreamingRuntime } = await import("./runtime/StreamingRuntime.js");
  const { InferenceRuntime } = await import("./runtime/InferenceRuntime.js");

  const sessionManager   = new SessionManager();
  const sessionTokens    = new SessionTokens();
  const quotaEnforcer    = new QuotaEnforcer(clients.publicClient);
  const accessVerifier   = new AccessVerifier(clients.publicClient, sessionManager);
  const hookManager      = new HookManager(clients.publicClient, clients.walletClient, clients.account);
  const gasRelayer       = new GasRelayer(clients.cdrClient, sessionManager);
  const accessDelegate   = new AccessDelegate(clients.storyClient);
  const streamingRuntime = new StreamingRuntime(clients.cdrClient, accessVerifier, sessionTokens);
  const inferenceRuntime = new InferenceRuntime(clients.cdrClient, sessionTokens, quotaEnforcer);

  return {
    // Raw clients
    ...clients,

    // Layer 1
    vaults:          new VaultManager(clients.cdrClient),
    assetRegistry:   new AssetRegistry(clients.storyClient, clients.cdrClient, clients.account.address as import("./core/types.js").HexAddress),

    // Layer 2
    sessionManager,
    gasRelayer,
    accessDelegate,

    // Layer 3
    licensing:       new LicensingEngine(clients.storyClient),
    derivatives:     new DerivativeEngine(clients.storyClient, new (await import("./sdk/asset/MetadataBuilder.js")).MetadataBuilder(), clients.account.address as import("./core/types.js").HexAddress),
    royalties:       new RoyaltyEngine(clients.storyClient),
    hooks:           hookManager,
    pilBuilder:      new PILBuilder(),

    // Layer 4
    sessionTokens,
    quotaEnforcer,
    accessVerifier,
    streamingRuntime,
    inferenceRuntime,
  };
}

export type NEXARStack = Awaited<ReturnType<typeof initNEXAR>>;
