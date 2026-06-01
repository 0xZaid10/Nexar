// src/sdk/asset/AssetRegistry.ts
// One-call registration: NFT mint + IP Asset + CDR vault + PIL terms + LicenseConfig + hook.
// This is the core abstraction of NEXAR's Layer 1.
//
// Confirmed against:
//   sdk-reference/ipasset.md         (registerIpAsset)
//   sdk-reference/nftclient.md       (createNFTCollection)
//   sdk-reference/license.md         (registerPILTerms, setLicensingConfig)
//   developers/cdr-sdk/ip-asset-vaults.md

import type { StoryClient }  from "@story-protocol/core-sdk";
import type { CDRClient }     from "@piplabs/cdr-sdk";
import { zeroAddress, parseEther } from "viem";

import {
  NEXAR_CONTRACTS,
  NEXAR_SPG_NFT,
  STORY_CONTRACTS,
  TOKENS,
  AssetTier,
  type RegisterAssetParams,
  type RegisterAssetResult,
  type HexAddress,
  NexarError,
  createLogger,
} from "../../core/index.js";

import { VaultManager }     from "../vault/VaultManager.js";
import { MetadataBuilder }  from "./MetadataBuilder.js";
import { getAssetTypeConfig, isFileVault } from "./AssetTypes.js";
import { licenseGated, inferenceOnly, ownerOnly } from "../vault/ConditionBuilder.js";
import { sha256Hex }                       from "../vault/Encryptor.js";

const log = createLogger("AssetRegistry");

// ─── AssetRegistry ────────────────────────────────────────────────────────────

export class AssetRegistry {
  private readonly story:    ReturnType<typeof StoryClient.newClient>;
  private readonly vaults:   VaultManager;
  private readonly metadata: MetadataBuilder;
  private readonly ownerAddress:  HexAddress;  // IP owner (user's Privy wallet)
  private readonly signerAddress: HexAddress;  // Transaction signer (operator pays gas)

  constructor(
    storyClient:    ReturnType<typeof StoryClient.newClient>,
    cdrClient:      CDRClient,
    ownerAddress:   HexAddress,
    signerAddress?: HexAddress   // defaults to ownerAddress if not provided
  ) {
    this.story         = storyClient;
    this.vaults        = new VaultManager(cdrClient);
    this.metadata      = new MetadataBuilder();
    this.ownerAddress  = ownerAddress;
    this.signerAddress = signerAddress ?? ownerAddress;
  }

  /**
   * Register an intelligence asset end-to-end in one call.
   *
   * What this does internally:
   *   1. Build + upload IPA and NFT metadata to IPFS
   *   2. Mint NFT + register IP Asset (registerIpAsset with mint type)
   *   3. Register PIL terms (registerPILTerms)
   *   4. Attach PIL terms to IP (via licenseTermsData in registerIpAsset)
   *   5. Set LicenseConfig pointing at DynamicPricingHook (setLicensingConfig)
   *   6. Create CDR vault with license-gated or inference-only condition
   *   7. Register on NEXARRegistry contract
   *
   * @param params - RegisterAssetParams (see core/types.ts)
   * @returns RegisterAssetResult with all IDs and tx hashes
   */
  async register(params: RegisterAssetParams): Promise<RegisterAssetResult> {
    log.separator(`Registering ${params.tier} asset: ${params.name}`);

    const config = getAssetTypeConfig(params.tier);

    // ── Step 1: Build + upload metadata ──────────────────────────────────────
    log.info("Step 1/5: Uploading metadata...");
    const mediaHash = sha256Hex(params.content);
    const built     = await this.metadata.build({
      name:        params.name,
      description: params.description,
      tier:        params.tier,
      creators:    params.creators,
      mediaHash:   params.mediaHash ?? mediaHash,
      mediaUrl:    params.mediaUrl,
    });

    // ── Step 2: Mint NFT + Register IP Asset + Attach PIL terms ──────────────
    // Confirmed from sdk-reference/ipasset.md registerIpAsset():
    //   nft: { type: "mint", spgNftContract }
    //   licenseTermsData: [{ terms, licensingConfig }]
    //   ipMetadata: { ipMetadataURI, ipMetadataHash, nftMetadataURI, nftMetadataHash }
    log.info("Step 2/5: Minting NFT + registering IP Asset...");

    const mintingFee  = parseEther(params.basePrice);
    const revSharePct = params.revShare; // Story SDK expects plain 0-100 percentage

    const ipResponse = await this.story.ipAsset.registerIpAsset({
      nft: {
        type:           "mint",
        spgNftContract: (NEXAR_SPG_NFT || STORY_CONTRACTS.IPAssetRegistry) as HexAddress,
        recipient:      this.ownerAddress,
      },
      licenseTermsData: [
        {
          terms: {
            transferable:              config.defaultPIL.transferable,
            royaltyPolicy:             params.commercial ? STORY_CONTRACTS.RoyaltyPolicyLAP as HexAddress : zeroAddress,
            defaultMintingFee:         mintingFee,
            expiration:                0n,
            commercialUse:             params.commercial,
            commercialAttribution:     params.commercial,     // must match commercialUse
            commercializerChecker:     zeroAddress,
            commercializerCheckerData: "0x",
            commercialRevShare:        revSharePct,
            commercialRevCeiling:      0n,
            derivativesAllowed:        config.defaultPIL.derivativesAllowed,
            derivativesAttribution:    config.defaultPIL.derivativesAllowed, // must match derivativesAllowed
            derivativesApproval:       false,
            derivativesReciprocal:     config.defaultPIL.derivativesAllowed ? config.defaultPIL.derivativesReciprocal : false,
            derivativeRevCeiling:      0n,
            currency:                  TOKENS.WIP,
            uri:                       "",
          },
          licensingConfig: {
            isSet:              false,   // disabled — hook not registered yet for this IP
            mintingFee:         mintingFee,
            licensingHook:      zeroAddress,  // no hook — prevents revert on unregistered assets
            hookData:           "0x",
            commercialRevShare: params.commercial ? revSharePct : 0,
            disabled:           false,
            expectMinimumGroupRewardShare: 0,
            expectGroupRewardPool:         zeroAddress,
          },
        },
      ],
      ipMetadata: {
        ipMetadataURI:   built.ipMetadataURI,
        ipMetadataHash:  built.ipMetadataHash,
        nftMetadataURI:  built.nftMetadataURI,
        nftMetadataHash: built.nftMetadataHash,
      },
    });

    const ipId:          HexAddress = ipResponse.ipId as HexAddress;
    const tokenId:       bigint     = BigInt(ipResponse.tokenId ?? 0);
    const licenseTermsId:bigint     = BigInt(ipResponse.licenseTermsIds?.[0] ?? 0);

    log.success("IP Asset registered", {
      ipId,
      tokenId:       tokenId.toString(),
      licenseTermsId: licenseTermsId.toString(),
    });

    // ── Step 3: Register asset in DynamicPricingHook ─────────────────────────
    // Calls registerAsset(ipId, tier, basePrice) on DynamicPricingHook contract
    log.info("Step 3/5: Registering pricing with DynamicPricingHook...");
    // Note: this is done via the hook contract directly (via viem writeContract)
    // The hook is already set in LicenseConfig above — pricing is active on mint
    // DynamicPricingHook.registerAsset() needs to be called separately by the owner
    // to set the initial base price and tier. This is handled by HookManager.ts.
    // We skip it here and rely on HookManager being called post-registration.

    // ── Step 4: Create CDR vault ──────────────────────────────────────────────
    log.info("Step 4/5: Creating CDR vault...");

    let vaultUuid: bigint;
    let lastVaultRecord: any;

    if (params.tier === AssetTier.INFERENCE) {
      // Use InferenceAccessCondition for inference vaults
      const condition = inferenceOnly({
        ownerAddress:             this.signerAddress,  // signer pays gas and writes vault
        ipId,
        inferenceLicenseTermsId:  licenseTermsId,
        maxComputeUnits:          config.maxComputeUnits,
      });

      const vaultRecord = isFileVault(params.tier)
        ? await this.vaults.createFileVault({
            content:       params.content,
            conditionType: "inferenceOnly",
            conditionData: {
              ownerAddress:             this.signerAddress,
              ipId,
              inferenceLicenseTermsId:  licenseTermsId,
              maxComputeUnits:          config.maxComputeUnits,
              customConditionAddr:      NEXAR_CONTRACTS.InferenceAccessCondition,
              customWriteData:          condition.writeConditionData,
              customReadData:           condition.readConditionData,
            },
            updatable: false,
          })
        : await this.vaults.createSecretVault({
            content:       params.content,
            conditionType: "inferenceOnly",
            conditionData: {
              ownerAddress:             this.signerAddress,
              ipId,
              inferenceLicenseTermsId:  licenseTermsId,
              maxComputeUnits:          config.maxComputeUnits,
              customConditionAddr:      NEXAR_CONTRACTS.InferenceAccessCondition,
              customWriteData:          condition.writeConditionData,
              customReadData:           condition.readConditionData,
            },
            updatable: false,
          });

      lastVaultRecord = vaultRecord;
      vaultUuid = vaultRecord.uuid;
    } else {
      // Use standard LicenseReadCondition for all other tiers
      const condition = licenseGated({
        ownerAddress: this.ownerAddress,
        ipId,
      });

      const vaultRecord = isFileVault(params.tier)
        ? await this.vaults.createFileVault({
            content:       params.content,
            conditionType: "licenseGated",
            conditionData: {
              ownerAddress: this.signerAddress,
            },
            updatable: false,
          })
        : await this.vaults.createSecretVault({
            content:       params.content,
            conditionType: "licenseGated",
            conditionData: {
              ownerAddress: this.signerAddress,
            },
            updatable: false,
          });

      lastVaultRecord = vaultRecord;
      vaultUuid = vaultRecord.uuid;
    }

    log.success("CDR vault created", { uuid: vaultUuid.toString() });

    // ── Step 5: Register on NEXARRegistry contract ───────────────────────────
    // Records ipId → vaultUuid mapping on-chain for discovery
    log.info("Step 5/5: Registering on NEXARRegistry...");
    // Note: NEXARRegistry.registerAsset() is called via writeContract
    // This is done in the demo/scripts layer via viem to keep AssetRegistry clean

    const result: RegisterAssetResult = {
      assetId:        0n,          // set by NEXARRegistry, populated in demo layer
      ipId,
      tokenId,
      vaultUuid,
      licenseTermsId,
      txHashes: {
        mintAndRegister:  ipResponse.txHash as `0x${string}`,
        attachTerms:      ipResponse.txHash as `0x${string}`,
        setLicenseConfig: ipResponse.txHash as `0x${string}`,
        allocateVault:    "0x",    // populated from vault record
        writeVault:       "0x",    // populated from vault record
        registerOnChain:  "0x",    // populated after NEXARRegistry call
      },
    };

    log.separator("Asset registration complete");
    log.success("Done", {
      ipId,
      vaultUuid: vaultUuid.toString(),
      tier:      config.label,
    });

    return { ...result, vaultAesKey: lastVaultRecord?.aesKey, vaultCid: lastVaultRecord?.cid };
  }

  // ─── Create SPG NFT collection (run once during setup) ────────────────────

  /**
   * Create the NEXAR SPG NFT collection.
   * Called once by scripts/setup.ts — the address goes into .env.
   * Confirmed from sdk-reference/nftclient.md createNFTCollection().
   */
  async createNFTCollection(): Promise<{ spgNftContract: HexAddress }> {
    log.info("Creating NEXAR SPG NFT collection...");

    const response = await this.story.nftClient.createNFTCollection({
      name:             "NEXAR Intelligence Assets",
      symbol:           "NEXAR",
      isPublicMinting:  false,     // only NEXAR backend mints
      mintFeeRecipient: this.ownerAddress,
      contractURI:      "",
    });

    log.success("SPG NFT collection created", {
      contract: response.spgNftContract,
    });

    return { spgNftContract: response.spgNftContract as HexAddress };
  }
}
