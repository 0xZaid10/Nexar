// src/agents/BaseAgent.ts
// Abstract base class for all NEXAR agents.
// Holds: wallet, StoryClient, CDRClient, HookManager, LicensingEngine.
// Multi-user: each agent instance is scoped to one wallet/identity.
// All agents extend this and get all clients pre-wired.

import type { StoryClient } from "@story-protocol/core-sdk";
import type { CDRClient }    from "@piplabs/cdr-sdk";
import type { Account, PublicClient, WalletClient } from "viem";

import { createLogger }       from "../core/logger.js";
import { NexarError }        from "../core/errors.js";
import { HookManager }        from "../licensing/HookManager.js";
import { LicensingEngine }    from "../licensing/LicensingEngine.js";
import { DerivativeEngine }   from "../licensing/DerivativeEngine.js";
import { MetadataBuilder }    from "../sdk/asset/MetadataBuilder.js";
import type { HexAddress }    from "../core/types.js";

// ─── Agent config ─────────────────────────────────────────────────────────────

export interface AgentConfig {
  name:       string;
  role:       "provider" | "consumer" | "inference";
  maxBudget?: bigint;   // max WIP willing to spend per negotiation (consumer agents)
  strategy?:  "aggressive" | "moderate" | "conservative";
}

// ─── BaseAgent ────────────────────────────────────────────────────────────────

export abstract class BaseAgent {
  // Identity
  readonly name:    string;
  readonly role:    AgentConfig["role"];
  readonly address: HexAddress;
  readonly account: Account;

  // Negotiation settings
  readonly maxBudget: bigint;
  readonly strategy:  NonNullable<AgentConfig["strategy"]>;

  // Clients — available to all subclasses
  protected readonly story:       ReturnType<typeof StoryClient.newClient>;
  protected readonly cdr:         CDRClient;
  protected readonly publicClient: PublicClient;
  protected readonly walletClient: WalletClient;

  // Shared engines — built once, shared across all agent operations
  protected readonly hooks:       HookManager;
  protected readonly licensing:   LicensingEngine;
  protected readonly derivatives: DerivativeEngine;
  protected readonly metadata:    MetadataBuilder;

  protected readonly log: ReturnType<typeof createLogger>;

  constructor(
    config:       AgentConfig,
    account:      Account,
    storyClient:  ReturnType<typeof StoryClient.newClient>,
    cdrClient:    CDRClient,
    publicClient: PublicClient,
    walletClient: WalletClient
  ) {
    this.name     = config.name;
    this.role     = config.role;
    this.address  = account.address as HexAddress;
    this.account  = account;

    this.maxBudget = config.maxBudget ?? BigInt(1e18); // 1 WIP default
    this.strategy  = config.strategy  ?? "moderate";

    this.story        = storyClient;
    this.cdr          = cdrClient;
    this.publicClient = publicClient;
    this.walletClient = walletClient;

    this.hooks        = new HookManager(publicClient, walletClient, account);
    this.licensing    = new LicensingEngine(storyClient);
    this.metadata     = new MetadataBuilder();
    this.derivatives  = new DerivativeEngine(storyClient, this.metadata, this.address);

    this.log = createLogger(`Agent:${config.name}`);
    this.log.info("Agent initialized", { role: config.role, address: this.address });
  }

  // ─── Shared utility methods ───────────────────────────────────────────────

  /**
   * Get on-chain reputation score for this agent.
   */
  async getReputation(): Promise<number> {
    return this.hooks.getReputation(this.address);
  }

  /**
   * Calculate negotiation counter-offer based on agent strategy.
   * Multi-user: each agent has its own strategy — no shared state.
   *
   * @param proposedFee - Fee proposed by the other party (in WIP, 18 dec)
   * @param marketPrice - Current hook preview price
   */
  calculateCounterOffer(proposedFee: bigint, marketPrice: bigint): bigint {
    switch (this.strategy) {
      case "aggressive":
        // Try to get 20% below market
        return (marketPrice * 80n) / 100n;

      case "moderate":
        // Meet halfway between proposed and market
        return (proposedFee + marketPrice) / 2n;

      case "conservative":
        // Accept anything at or below market price
        return marketPrice;
    }
  }

  /**
   * Decide whether to accept a proposed fee.
   * @param proposedFee - Fee being proposed
   * @param marketPrice - Current market price from DynamicPricingHook
   */
  shouldAccept(proposedFee: bigint, marketPrice: bigint): boolean {
    if (proposedFee > this.maxBudget) return false;

    switch (this.strategy) {
      case "aggressive":
        return proposedFee <= (marketPrice * 85n) / 100n; // accept if ≤85% of market
      case "moderate":
        return proposedFee <= marketPrice;                  // accept at or below market
      case "conservative":
        return proposedFee <= (marketPrice * 110n) / 100n; // accept up to 10% above market
    }
  }

  /**
   * Abstract: subclasses implement their primary action.
   */
  abstract run(): Promise<void>;
}
