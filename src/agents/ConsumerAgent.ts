// src/agents/ConsumerAgent.ts
// Consumer agent: discovers assets, negotiates, licenses, accesses vaults,
// registers derivative outputs. Full ATCP/IP buyer-side implementation.
// Multi-user: each instance is one buyer identity (one wallet).

import type { StoryClient }   from "@story-protocol/core-sdk";
import type { CDRClient }      from "@piplabs/cdr-sdk";
import type { Account, PublicClient, WalletClient } from "viem";

import { NexarError }               from "../core/errors.js";
import { BaseAgent, type AgentConfig } from "./BaseAgent.js";
import { Discovery, type DiscoveredAsset, type DiscoveryFilters } from "./negotiation/Discovery.js";
import { ATCPIP }                    from "./negotiation/ATCPIP.js";
import { VaultManager }              from "../sdk/vault/VaultManager.js";
import { encodeLicenseTokenIds }     from "../sdk/vault/ConditionBuilder.js";
import type {
  HexAddress,
  TxHash,
  NegotiationState,
  SettlementResult,
  VaultAccessResult,
  DerivativeRecord,
  IpCreator,
} from "../core/types.js";
import type { AssetTier }            from "../core/config.js";

export class ConsumerAgent extends BaseAgent {
  protected readonly discovery: Discovery;
  protected readonly atcpip:    ATCPIP;
  protected readonly vaults:    VaultManager;

  // Track all licenses minted by this consumer in this session
  readonly mintedLicenses: SettlementResult[] = [];

  constructor(
    config:       AgentConfig,
    account:      Account,
    storyClient:  ReturnType<typeof StoryClient.newClient>,
    cdrClient:    CDRClient,
    publicClient: PublicClient,
    walletClient: WalletClient
  ) {
    super(config, account, storyClient, cdrClient, publicClient, walletClient);

    this.discovery = new Discovery(publicClient, storyClient, this.hooks);
    this.atcpip    = new ATCPIP(this.licensing, this.hooks);
    this.vaults    = new VaultManager(cdrClient);
  }

  async run(): Promise<void> {
    this.log.info("Consumer agent running...", { address: this.address });
  }

  // ─── Step 1: Discover assets ──────────────────────────────────────────────

  /**
   * Discover available NEXAR assets with optional filters.
   * Multi-user: read-only, each agent discovers independently.
   */
  async discover(filters: DiscoveryFilters = {}): Promise<DiscoveredAsset[]> {
    this.log.info("Discovering assets...", { filters: JSON.stringify(filters) });
    const assets = await this.discovery.findAssets(filters, this.address);
    this.log.success("Assets discovered", { count: assets.length.toString() });
    return assets;
  }

  // ─── Step 2: Negotiate ────────────────────────────────────────────────────

  /**
   * Full ATCP/IP negotiation with a provider asset.
   * Implements: propose → (counter → revise)* → accept.
   * Multi-user: each negotiation is a fully independent instance.
   *
   * @param asset       - Discovered asset to negotiate for
   * @param maxRounds   - Max back-and-forth rounds (default 3)
   */
  async negotiate(asset: DiscoveredAsset, maxRounds = 3): Promise<NegotiationState> {
    this.log.separator(`Negotiating for: ${asset.name}`);

    // Start with a bid based on strategy
    const initialBid = this.calculateCounterOffer(asset.currentPrice, asset.marketPrice);

    this.log.info("Proposing initial bid...", {
      marketPrice:  asset.marketPrice.toString(),
      currentPrice: asset.currentPrice.toString(),
      ourBid:       initialBid.toString(),
    });

    // PROPOSED
    let state = this.atcpip.initiate({
      assetId:     asset.assetId,
      ipId:        asset.ipId,
      buyer:       this.address,
      proposedFee: initialBid,
    });

    // Simulate negotiation rounds
    // In production: send state.id to provider agent, receive counter via message queue
    // For NEXAR demo: provider auto-counters with the hook price
    for (let round = 0; round < maxRounds; round++) {
      // Provider counter = hook market price (simulated provider behavior)
      const providerCounter = asset.currentPrice;

      if (state.proposedFee >= providerCounter || this.shouldAccept(state.proposedFee, providerCounter)) {
        state = this.atcpip.accept(state.id);
        break;
      }

      // Provider counters with market price
      state = this.atcpip.counter(state.id, providerCounter);
      this.log.info("Counter received", {
        round:      (round + 1).toString(),
        counter:    providerCounter.toString(),
      });

      // We counter back at midpoint
      const ourCounter = this.calculateCounterOffer(providerCounter, asset.marketPrice);
      if (this.shouldAccept(ourCounter, providerCounter)) {
        state = this.atcpip.accept(state.id);
        break;
      }

      state = this.atcpip.counter(state.id, ourCounter);
    }

    // If still not accepted after max rounds, accept at market price if within budget
    if (state.status !== "ACCEPTED" && state.status !== "SETTLED") {
      if (asset.currentPrice <= this.maxBudget) {
        // Override proposed fee and accept
        (state as { proposedFee: bigint }).proposedFee = asset.currentPrice;
        state = this.atcpip.accept(state.id);
      } else {
        this.atcpip.reject(state.id, "Exceeded max budget");
        throw new NexarError(
          "NEGOTIATION_REJECTED",
          `Could not reach agreement for ${asset.name} within budget`,
          { context: { asset: asset.ipId, budget: this.maxBudget.toString() } }
        );
      }
    }

    this.log.success("Negotiation accepted", {
      agreedFee: state.agreedFee?.toString() ?? state.proposedFee.toString(),
    });

    return state;
  }

  // ─── Step 3: Mint license (settle on-chain) ───────────────────────────────

  /**
   * Settle an accepted negotiation — mint license token on-chain.
   * Multi-user: each settlement is an independent on-chain tx from this wallet.
   */
  async license(
    negotiationState: NegotiationState,
    licenseTermsId:   bigint
  ): Promise<SettlementResult> {
    this.log.info("Minting license token...", {
      negotiationId: negotiationState.id,
      ipId:          negotiationState.ipId,
      licenseTermsId: licenseTermsId.toString(),
    });

    const result = await this.atcpip.settle(
      negotiationState.id,
      licenseTermsId,
      this.address
    );

    this.mintedLicenses.push(result);
    return result;
  }

  // ─── Step 4: Access CDR vault ─────────────────────────────────────────────

  /**
   * Access a CDR vault after licensing.
   * Present the minted license token to prove access rights.
   * Multi-user: each access is independently authenticated via the license token.
   *
   * @param vaultUuid       - CDR vault UUID from asset record
   * @param licenseTokenId  - Token minted in license() step
   * @param isFilevault     - true for IPFS vaults, false for on-chain secrets
   */
  async accessVault(
    vaultUuid:      bigint,
    licenseTokenId: bigint,
    isFileVault:    boolean = true
  ): Promise<VaultAccessResult> {
    this.log.info("Accessing vault...", {
      uuid:          vaultUuid.toString(),
      licenseTokenId: licenseTokenId.toString(),
    });

    const result = isFileVault
      ? await this.vaults.accessFileVault({
          uuid:            vaultUuid,
          licenseTokenIds: [licenseTokenId],
        })
      : await this.vaults.accessSecretVault({
          uuid:            vaultUuid,
          licenseTokenIds: [licenseTokenId],
        });

    this.log.success("Vault decrypted", {
      uuid:   vaultUuid.toString(),
      bytes:  (result.content?.length ?? result.dataKey.length).toString(),
    });

    return result;
  }

  // ─── Step 5: Register derivative output as IP ─────────────────────────────

  /**
   * Register the derivative output as a new IP Asset on Story.
   * Creates the parent→child link — royalties flow automatically from here.
   * Confirmed from developers/typescript-sdk/register-derivative.md.
   * Multi-user: each consumer registers their own derivative independently.
   */
  async registerOutput(params: {
    parentIpIds:     HexAddress[];
    licenseTermsIds: bigint[];
    name:            string;
    description:     string;
    tier:            AssetTier;
    creators:        IpCreator[];
    content?:        Uint8Array;
  }): Promise<DerivativeRecord> {
    this.log.info("Registering derivative output...", {
      parents: params.parentIpIds.join(", "),
      name:    params.name,
    });

    const record = await this.derivatives.registerDerivative({
      parentIpIds:     params.parentIpIds,
      licenseTermsIds: params.licenseTermsIds,
      metadata: {
        name:        params.name,
        description: params.description,
        tier:        params.tier,
        creators:    params.creators,
        mediaHash:   params.content ? undefined : undefined,
      },
    });

    // Record reputation for derivative registration
    await this.hooks.recordDerivativeRegistered(this.address);

    this.log.success("Derivative registered", {
      childIpId: record.childIpId,
      txHash:    record.txHash,
    });

    return record;
  }

  // ─── Full ATCP/IP flow in one call ────────────────────────────────────────

  /**
   * Complete end-to-end ATCP/IP transaction: discover → negotiate → license → access.
   * Multi-user: fully independent per agent instance.
   */
  async fullTransaction(params: {
    filters:         DiscoveryFilters;
    licenseTermsId:  bigint;
    isFileVault?:    boolean;
  }): Promise<{ asset: DiscoveredAsset; vaultContent: VaultAccessResult; settlement: SettlementResult }> {
    // 1. Discover
    const assets = await this.discover(params.filters);
    if (assets.length === 0) {
      throw new NexarError("DISCOVERY_FAILED", "No assets found matching filters");
    }

    // Pick best asset: lowest price
    const asset = assets.sort((a, b) => Number(a.currentPrice - b.currentPrice))[0]!;

    // 2. Negotiate
    const negotiation = await this.negotiate(asset);

    // 3. License (settle on-chain)
    const settlement = await this.license(negotiation, params.licenseTermsId);

    // 4. Access vault
    const vaultContent = await this.accessVault(
      asset.vaultUuid,
      settlement.licenseTokenId,
      params.isFileVault ?? true
    );

    return { asset, vaultContent, settlement };
  }
}
