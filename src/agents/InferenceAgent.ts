// src/agents/InferenceAgent.ts
// Inference-specialised consumer agent.
// Extends ConsumerAgent with inference-specific: quota awareness,
// inference license purchasing, runtime execution, derivative output registration.
// Multi-user: each instance is one inference agent identity (one wallet).

import type { StoryClient }   from "@story-protocol/core-sdk";
import type { CDRClient }      from "@piplabs/cdr-sdk";
import type { Account, PublicClient, WalletClient } from "viem";

import { MAX_COMPUTE_UNITS }           from "../core/config.js";
import { NexarError }                 from "../core/errors.js";
import { ConsumerAgent }               from "./ConsumerAgent.js";
import type { AgentConfig }            from "./BaseAgent.js";
import { InferenceRuntime }            from "../runtime/InferenceRuntime.js";
import { SessionTokens }               from "../runtime/SessionTokens.js";
import { QuotaEnforcer }               from "../runtime/QuotaEnforcer.js";
import type { DiscoveryFilters, DiscoveredAsset } from "./negotiation/Discovery.js";
import type {
  HexAddress,
  TxHash,
  InferenceResult,
  DerivativeRecord,
  IpCreator,
  SettlementResult,
} from "../core/types.js";
import type { AssetTier } from "../core/config.js";

export class InferenceAgent extends ConsumerAgent {
  private readonly inferenceRuntime: InferenceRuntime;
  private readonly sessionTokens:    SessionTokens;
  private readonly quotaEnforcer:    QuotaEnforcer;

  // Track all inference results produced by this agent
  readonly inferenceHistory: InferenceResult[] = [];

  constructor(
    config:       AgentConfig,
    account:      Account,
    storyClient:  ReturnType<typeof StoryClient.newClient>,
    cdrClient:    CDRClient,
    publicClient: PublicClient,
    walletClient: WalletClient
  ) {
    super(config, account, storyClient, cdrClient, publicClient, walletClient);

    this.sessionTokens    = new SessionTokens();
    this.quotaEnforcer    = new QuotaEnforcer(publicClient, MAX_COMPUTE_UNITS);
    this.inferenceRuntime = new InferenceRuntime(cdrClient, this.sessionTokens, this.quotaEnforcer);
  }

  // ─── Purchase inference license ───────────────────────────────────────────

  /**
   * Discover, negotiate, and purchase an INFERENCE-tier license.
   * Inference licenses are non-transferable, quota-bounded.
   * Multi-user: each agent purchases independently — quota tracked per (agent, ipId).
   *
   * @param filters         - Discovery filters (tier should be AssetTier.INFERENCE)
   * @param licenseTermsId  - Inference-tier terms ID
   */
  async purchaseInferenceLicense(
    filters:        DiscoveryFilters,
    licenseTermsId: bigint
  ): Promise<{ asset: DiscoveredAsset; settlement: SettlementResult }> {
    this.log.separator("Purchasing inference license");

    // Discover inference assets
    const assets = await this.discover(filters);
    if (assets.length === 0) {
      throw new NexarError("DISCOVERY_FAILED", "No inference assets found");
    }

    // Pick cheapest available asset
    const asset = assets.sort((a, b) => Number(a.currentPrice - b.currentPrice))[0]!;

    // Pre-flight quota check — won't buy if we already exhausted quota
    const quota = await this.quotaEnforcer.check(this.address, asset.ipId).catch(() => null);
    if (quota && quota.remaining === 0) {
      throw new NexarError(
        "QUOTA_EXCEEDED",
        `Inference quota already exhausted for ${asset.ipId}`
      );
    }

    // Negotiate and settle
    const negotiation  = await this.negotiate(asset);
    const settlement   = await this.license(negotiation, licenseTermsId);

    this.log.success("Inference license purchased", {
      ipId:          asset.ipId,
      licenseTokenId: settlement.licenseTokenId.toString(),
    });

    return { asset, settlement };
  }

  // ─── Run inference ────────────────────────────────────────────────────────

  /**
   * Execute inference on a CDR-vaulted model or strategy.
   * Callers never see raw vault content — only the output is returned.
   * Multi-user: each call is independently session-authenticated + quota-checked.
   *
   * @param asset           - The inference asset (from discovery)
   * @param licenseTokenId  - Inference license token ID proving access
   * @param prompt          - Input prompt / query
   * @param maxTokens       - Optional output token limit
   */
  async runInference(params: {
    asset:          DiscoveredAsset;
    licenseTokenId: bigint;
    prompt:         string;
    maxTokens?:     number;
  }): Promise<InferenceResult> {
    this.log.info("Running inference...", {
      ipId:   params.asset.ipId,
      prompt: params.prompt.slice(0, 50) + "...",
    });

    // Issue a short-lived inference session token for this specific vault
    const sessionToken = this.sessionTokens.issueInferenceToken(
      this.address,
      params.asset.vaultUuid,
      params.asset.ipId
    );

    const result = await this.inferenceRuntime.runInference({
      uuid:           params.asset.vaultUuid,
      prompt:         params.prompt,
      licenseTokenId: params.licenseTokenId,
      sessionToken:   sessionToken.token,
      maxTokens:      params.maxTokens,
    });

    this.inferenceHistory.push(result);

    this.log.success("Inference complete", {
      ipId:           params.asset.ipId,
      quotaRemaining: result.quotaRemaining.toString(),
    });

    return result;
  }

  // ─── Register derivative output as IP ────────────────────────────────────

  /**
   * Register an inference output as a derivative IP Asset on Story.
   * Creates the royalty chain: output → model/strategy → dataset.
   * Every downstream use of this output routes royalties upstream automatically.
   * Multi-user: each agent registers their own outputs independently.
   *
   * @param inferenceResult - Output from runInference()
   * @param parentIpId      - The inference asset's IP ID
   * @param licenseTermsId  - Terms ID inherited from parent
   * @param outputTier      - Tier for the output IP (usually STRATEGY or PROMPT)
   */
  async registerDerivativeOutput(params: {
    inferenceResult: InferenceResult;
    parentIpId:      HexAddress;
    licenseTermsId:  bigint;
    outputName:      string;
    outputTier:      AssetTier;
    creators?:       IpCreator[];
  }): Promise<DerivativeRecord> {
    this.log.info("Registering inference output as derivative IP...", {
      parent: params.parentIpId,
      name:   params.outputName,
    });

    const record = await this.registerOutput({
      parentIpIds:     [params.parentIpId],
      licenseTermsIds: [params.licenseTermsId],
      name:            params.outputName,
      description:     `Inference output generated by ${this.name} from ${params.parentIpId}`,
      tier:            params.outputTier,
      creators:        params.creators ?? [
        {
          name:                this.name,
          address:             this.address,
          contributionPercent: 100,
        },
      ],
      content: new TextEncoder().encode(params.inferenceResult.output),
    });

    this.log.success("Derivative output registered", {
      childIpId: record.childIpId,
      parent:    params.parentIpId,
    });

    return record;
  }

  // ─── Check remaining quota ────────────────────────────────────────────────

  /**
   * Check how many inference calls remain for this agent on a specific IP.
   * Multi-user: quota is per (agent address, ipId) — fully isolated.
   */
  async getRemainingQuota(ipId: HexAddress): Promise<number> {
    const used = await this.quotaEnforcer.getUsedUnits(this.address, ipId);
    return Math.max(0, MAX_COMPUTE_UNITS - Number(used));
  }

  // ─── Full inference flow ──────────────────────────────────────────────────

  /**
   * Complete end-to-end inference transaction:
   * discover → purchase license → run inference → register output as derivative IP.
   * Multi-user: fully independent per agent instance.
   */
  async fullInferenceFlow(params: {
    filters:          DiscoveryFilters;
    licenseTermsId:   bigint;
    prompt:           string;
    outputName:       string;
    outputTier:       AssetTier;
    registerOutput?:  boolean; // default true
  }): Promise<{
    asset:       DiscoveredAsset;
    result:      InferenceResult;
    derivative?: DerivativeRecord;
  }> {
    // 1. Purchase license
    const { asset } = await this.purchaseInferenceLicense(
      params.filters,
      params.licenseTermsId
    );

    const settlement = this.mintedLicenses[this.mintedLicenses.length - 1]!;

    // 2. Run inference
    const result = await this.runInference({
      asset,
      licenseTokenId: settlement.licenseTokenId,
      prompt:         params.prompt,
    });

    // 3. Register output as derivative (optional)
    let derivative: DerivativeRecord | undefined;
    if (params.registerOutput !== false) {
      derivative = await this.registerDerivativeOutput({
        inferenceResult: result,
        parentIpId:      asset.ipId,
        licenseTermsId:  params.licenseTermsId,
        outputName:      params.outputName,
        outputTier:      params.outputTier,
      });
    }

    return { asset, result, derivative };
  }
}
