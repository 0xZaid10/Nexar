// src/sdk/asset/MetadataBuilder.ts
// Build and upload IPA metadata to IPFS via Pinata (persistent).
// Falls back to local Helia if Pinata not configured.

import { createHash }         from "node:crypto";
import { pinJSONToPinata, uploadJSONToIPFS } from "../vault/StorageProvider.js";
import { NexarError as CipherError }        from "../../core/errors.js";
import { createLogger }       from "../../core/logger.js";
import type { IpCreator, HexAddress } from "../../core/types.js";
import type { AssetTier }     from "../../core/config.js";
import { ASSET_TYPE_CONFIGS } from "./AssetTypes.js";

const log = createLogger("MetadataBuilder");

export interface IPAMetadata {
  title:        string;
  description:  string;
  createdAt:    string;
  image?:       string;
  mediaUrl?:    string;
  mediaHash?:   string;
  mediaType?:   string;
  ipType?:      string;
  tags?:        string[];
  creators:     IpCreator[];
}

export interface NFTMetadata {
  name:        string;
  description: string;
  image:       string;
}

export interface BuiltMetadata {
  ipMetadataURI:   string;
  ipMetadataHash:  `0x${string}`;
  nftMetadataURI:  string;
  nftMetadataHash: `0x${string}`;
}

export interface BuildMetadataParams {
  name:         string;
  description:  string;
  tier:         AssetTier;
  creators:     IpCreator[];
  mediaHash?:   string;
  mediaUrl?:    string;
  image?:       string;
  tags?:        string[];
}

export class MetadataBuilder {

  buildIPAMetadata(params: BuildMetadataParams): IPAMetadata {
    const config = ASSET_TYPE_CONFIGS[params.tier];
    return {
      title:       params.name,
      description: params.description,
      createdAt:   new Date().toISOString(),
      image:       params.image,
      mediaUrl:    params.mediaUrl,
      mediaHash:   params.mediaHash,
      mediaType:   config.mediaType,
      ipType:      config.label,
      tags:        params.tags ?? [config.label, "NEXAR", "AI"],
      creators:    params.creators,
    };
  }

  buildNFTMetadata(params: BuildMetadataParams): NFTMetadata {
    return {
      name:        `NEXAR — ${params.name}`,
      description: `Ownership NFT for NEXAR intelligence asset: ${params.description}`,
      image:       params.image ?? "https://nexar.foundation/default-asset.png",
    };
  }

  hashJSON(obj: unknown): `0x${string}` {
    const json = JSON.stringify(obj);
    const hash = createHash("sha256").update(json).digest("hex");
    return `0x${hash}`;
  }

  async uploadJSON(obj: unknown, name?: string): Promise<string> {
    // Try Pinata first (persistent, redundant)
    const pinataUrl = await pinJSONToPinata(obj, name ?? "nexar-metadata");
    if (pinataUrl) return pinataUrl;

    // Fall back to local Helia
    return uploadJSONToIPFS(obj);
  }

  async build(params: BuildMetadataParams): Promise<BuiltMetadata> {
    log.info("Building and uploading metadata...", { name: params.name });

    const ipaMeta = this.buildIPAMetadata(params);
    const nftMeta = this.buildNFTMetadata(params);

    const [ipMetadataURI, nftMetadataURI] = await Promise.all([
      this.uploadJSON(ipaMeta, `ipa-${params.name}`),
      this.uploadJSON(nftMeta, `nft-${params.name}`),
    ]);

    const result: BuiltMetadata = {
      ipMetadataURI,
      ipMetadataHash:  this.hashJSON(ipaMeta),
      nftMetadataURI,
      nftMetadataHash: this.hashJSON(nftMeta),
    };

    log.success("Metadata uploaded", { ipURI: ipMetadataURI });
    return result;
  }
}
