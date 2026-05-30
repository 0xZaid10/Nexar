// src/licensing/LicensingEngine.ts
// Main licensing orchestrator: register terms, attach, mint, config.
// Confirmed against sdk-reference/license.md — all method names and params exact.

import type { StoryClient } from "@story-protocol/core-sdk";
import { zeroAddress }       from "viem";

import { STORY_CONTRACTS, NEXAR_CONTRACTS } from "../core/config.js";
import { NexarError }                       from "../core/errors.js";
import { createLogger }                      from "../core/logger.js";
import type { HexAddress, TxHash, LicenseRecord, PILConfig } from "../core/types.js";
import { PILBuilder, type LicenseTerms, type LicensingConfig } from "./PILBuilder.js";

const log = createLogger("LicensingEngine");

export class LicensingEngine {
  private readonly story:      ReturnType<typeof StoryClient.newClient>;
  private readonly pilBuilder: PILBuilder;

  constructor(storyClient: ReturnType<typeof StoryClient.newClient>) {
    this.story      = storyClient;
    this.pilBuilder = new PILBuilder();
  }

  // ─── Register PIL Terms ───────────────────────────────────────────────────

  /**
   * Register new PIL terms on Story Protocol.
   * If identical terms already exist, returns existing licenseTermsId.
   * Confirmed from sdk-reference/license.md registerPILTerms().
   * Multi-user: PIL terms are protocol-global, reusable by any IP owner.
   */
  async registerPILTerms(terms: LicenseTerms): Promise<{
    licenseTermsId: bigint;
    txHash?:        TxHash;
  }> {
    log.info("Registering PIL terms...", {
      commercial:  terms.commercialUse.toString(),
      revShare:    terms.commercialRevShare.toString(),
      derivatives: terms.derivativesAllowed.toString(),
    });

    try {
      const response = await this.story.license.registerPILTerms({
        ...terms,
      });

      const licenseTermsId = BigInt(response.licenseTermsId);
      log.success("PIL terms registered", {
        licenseTermsId: licenseTermsId.toString(),
        txHash:         response.txHash ?? "existing",
      });

      return {
        licenseTermsId,
        txHash: response.txHash as TxHash | undefined,
      };
    } catch (err) {
      throw new NexarError("LICENSE_TERMS_REGISTER_FAILED", "Failed to register PIL terms", { cause: err });
    }
  }

  /**
   * Register PIL terms from a PILConfig (convenience wrapper).
   * Multi-user: each asset type gets terms registered once, shared globally.
   */
  async registerFromConfig(config: PILConfig): Promise<{ licenseTermsId: bigint; txHash?: TxHash }> {
    const terms = this.pilBuilder.build(config);
    return this.registerPILTerms(terms);
  }

  // ─── Attach License Terms ─────────────────────────────────────────────────

  /**
   * Attach existing license terms to an IP Asset.
   * Confirmed from sdk-reference/license.md attachLicenseTerms().
   *
   * @param ipId            - IP Asset to attach terms to
   * @param licenseTermsId  - Terms ID (from registerPILTerms)
   */
  async attachLicenseTerms(
    ipId:           HexAddress,
    licenseTermsId: bigint
  ): Promise<{ txHash?: TxHash }> {
    log.info("Attaching license terms...", {
      ipId,
      licenseTermsId: licenseTermsId.toString(),
    });

    try {
      const response = await this.story.license.attachLicenseTerms({
        ipId,
        licenseTermsId: licenseTermsId.toString(),
        licenseTemplate: STORY_CONTRACTS.PILicenseTemplate as HexAddress,
      });

      log.success("License terms attached", { ipId, licenseTermsId: licenseTermsId.toString() });
      return { txHash: response.txHash as TxHash | undefined };
    } catch (err) {
      if ((err as Error)?.message?.includes("already attached")) {
        log.warn("Terms already attached to this IP", { ipId, licenseTermsId: licenseTermsId.toString() });
        return {};
      }
      throw new NexarError("LICENSE_ATTACH_FAILED", `Failed to attach terms to ${ipId}`, { cause: err });
    }
  }

  // ─── Set Licensing Config ─────────────────────────────────────────────────

  /**
   * Set LicenseConfig on an IP Asset to enable DynamicPricingHook.
   * Confirmed from sdk-reference/license.md setLicensingConfig().
   *
   * @param ipId            - IP Asset
   * @param licenseTermsId  - Which terms to configure
   * @param config          - LicensingConfig object
   */
  async setLicensingConfig(
    ipId:           HexAddress,
    licenseTermsId: bigint,
    config:         LicensingConfig
  ): Promise<{ txHash?: TxHash }> {
    log.info("Setting licensing config...", {
      ipId,
      licenseTermsId: licenseTermsId.toString(),
      hook:           config.licensingHook,
    });

    try {
      const response = await this.story.license.setLicensingConfig({
        ipId,
        licenseTermsId:  licenseTermsId.toString(),
        licensingConfig: config,
      });

      log.success("Licensing config set", { ipId, txHash: response.txHash });
      return { txHash: response.txHash as TxHash | undefined };
    } catch (err) {
      throw new NexarError("LICENSE_CONFIG_FAILED", `Failed to set config for ${ipId}`, { cause: err });
    }
  }

  // ─── Mint License Tokens ──────────────────────────────────────────────────

  /**
   * Mint license tokens for a buyer.
   * Confirmed from sdk-reference/license.md mintLicenseTokens().
   * Multi-user: each mint is for a specific receiver — fully per-user.
   *
   * @param licensorIpId    - IP Asset being licensed
   * @param licenseTermsId  - Terms under which license is granted
   * @param receiver        - Address receiving the license token
   * @param amount          - Number of tokens to mint (default 1)
   */
  async mintLicenseTokens(params: {
    licensorIpId:   HexAddress;
    licenseTermsId: bigint;
    receiver:       HexAddress;
    amount?:        number;
  }): Promise<{ licenseTokenIds: bigint[]; txHash: TxHash }> {
    log.info("Minting license tokens...", {
      licensorIpId:   params.licensorIpId,
      licenseTermsId: params.licenseTermsId.toString(),
      receiver:       params.receiver,
      amount:         (params.amount ?? 1).toString(),
    });

    try {
      const response = await this.story.license.mintLicenseTokens({
        licensorIpId:   params.licensorIpId,
        licenseTermsId: params.licenseTermsId.toString(),
        receiver:       params.receiver,
        amount:         params.amount ?? 1,
      });

      const ids = (response.licenseTokenIds ?? []).map(BigInt);
      log.success("License tokens minted", {
        tokenIds: ids.map(String).join(", "),
        txHash:   response.txHash,
      });

      return {
        licenseTokenIds: ids,
        txHash:          response.txHash as TxHash,
      };
    } catch (err) {
      throw new NexarError(
        "LICENSE_MINT_FAILED",
        `Failed to mint license for ${params.licensorIpId}`,
        { cause: err }
      );
    }
  }

  // ─── Read terms ───────────────────────────────────────────────────────────

  /**
   * Get license terms by ID.
   * Multi-user: protocol-global read, no auth required.
   */
  async getLicenseTerms(licenseTermsId: bigint): Promise<LicenseTerms | null> {
    try {
      const terms = await this.story.license.getLicenseTerms({
        licenseTermsId: licenseTermsId.toString(),
      });
      return terms as unknown as LicenseTerms;
    } catch {
      return null;
    }
  }

  // ─── Convenience: full setup for an IP Asset ─────────────────────────────

  /**
   * One call: register PIL terms + attach to IP + set LicenseConfig with hook.
   * Used by AssetRegistry for the complete licensing setup.
   */
  async setupLicensing(params: {
    ipId:        HexAddress;
    config:      PILConfig;
    hookAddress: `0x${string}`;
  }): Promise<{ licenseTermsId: bigint }> {
    // 1. Build and register PIL terms
    const terms  = this.pilBuilder.build(params.config);
    const { licenseTermsId } = await this.registerPILTerms(terms);

    // 2. Attach to IP Asset
    await this.attachLicenseTerms(params.ipId, licenseTermsId);

    // 3. Set LicenseConfig pointing at DynamicPricingHook
    const licensingConfig = this.pilBuilder.buildLicensingConfig({
      hookAddress:  params.hookAddress,
      mintingFee:   params.config.mintingFee,
      revSharePct:  params.config.revShare,
    });
    await this.setLicensingConfig(params.ipId, licenseTermsId, licensingConfig);

    return { licenseTermsId };
  }
}
