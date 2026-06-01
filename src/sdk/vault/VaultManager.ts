// src/sdk/vault/VaultManager.ts
// Main CDR vault lifecycle: create, access, update, revoke.
// Full abstraction over CDR SDK — callers never touch raw CDR APIs.
// Confirmed against:
//   sdk-reference/cdr/uploader.md  (uploadCDR, uploadFile, allocate, write)
//   sdk-reference/cdr/consumer.md  (accessCDR, downloadFile)
//   developers/cdr-sdk/ip-asset-vaults.md

import type { CDRClient } from "@piplabs/cdr-sdk";
import { encodeAbiParameters } from "viem";

import {
  CDR_TIMEOUT_MS,
  type VaultRecord,
  type VaultCreateParams,
  type VaultAccessParams,
  type VaultAccessResult,
  type HexAddress,
  type TxHash,
  NexarError,
  createLogger,
} from "../../core/index.js";

import { getCDRStorageProvider }      from "./StorageProvider.js";
import { encodeLicenseTokenIds, ownerOnly, licenseGated } from "./ConditionBuilder.js";

const log = createLogger("VaultManager");

// ─── VaultManager ─────────────────────────────────────────────────────────────

export class VaultManager {
  private readonly cdr: CDRClient;

  constructor(cdrClient: CDRClient) {
    this.cdr = cdrClient;
  }

  // ─── Create vault (on-chain secret — ≤1024 bytes payload) ─────────────────

  /**
   * Create an on-chain secret vault (uploadCDR).
   * Use for: API keys, symmetric keys, prompts, strategies (<1KB).
   * Confirmed params from sdk-reference/cdr/uploader.md uploadCDR().
   */
  async createSecretVault(
    params: VaultCreateParams
  ): Promise<VaultRecord> {
    log.info("Creating secret vault...", {
      conditionType: params.conditionData.toString(),
      updatable:     params.updatable.toString(),
      bytes:         params.content.length.toString(),
    });

    if (params.content.length > 1024) {
      throw new NexarError(
        "INVALID_PARAMS",
        `Secret vault payload too large: ${params.content.length} bytes (max 1024). Use createFileVault() for larger content.`
      );
    }

    const { writeConditionAddr, readConditionAddr, writeConditionData, readConditionData } =
      this.buildConditionArgs(params);

    try {
      const globalPubKey = await this.cdr.observer.getGlobalPubKey();

      console.log("[uploadCDR DEBUG] writeAddr:", writeConditionAddr, "readAddr:", readConditionAddr);
    const result = await this.cdr.uploader.uploadCDR({
        dataKey:            params.content,
        globalPubKey,
        updatable:          params.updatable,
        writeConditionAddr,
        readConditionAddr,
        writeConditionData,
        readConditionData,
        accessAuxData:      "0x",
      });

      const record: VaultRecord = {
        uuid:          BigInt(result.uuid),
        conditionType: params.conditionData as unknown as VaultRecord["conditionType"],
        createdAt:     Date.now(),
        txHashes: {
          allocate: result.txHashes.allocate as TxHash,
          write:    result.txHashes.write    as TxHash,
        },
      };

      log.success("Secret vault created", {
        uuid:     record.uuid.toString(),
        allocate: record.txHashes.allocate,
        write:    record.txHashes.write,
      });

      return record;
    } catch (err) {
      if (err instanceof NexarError) throw err;
      throw new NexarError("VAULT_CREATE_FAILED", "uploadCDR failed", { cause: err });
    }
  }

  // ─── Create file vault (off-chain file + on-chain key) ─────────────────────

  /**
   * Create a file vault (uploadFile).
   * Use for: datasets, model weights, video, audio, documents — any size.
   * File is encrypted locally → uploaded to Helia IPFS.
   * The AES key + CID are stored in the CDR vault.
   * Confirmed params from sdk-reference/cdr/uploader.md uploadFile().
   */
  async createFileVault(
    params: VaultCreateParams
  ): Promise<VaultRecord & { cid: string }> {
    log.info("Creating file vault via Pinata + CDR...", {
      bytes: params.content.length.toString(),
    });

    try {
      // 1. Encrypt content locally with AES-256-GCM
      const { encrypt } = await import("./Encryptor.js");
      const { encrypted, key } = encrypt(params.content);

      // 2. Upload encrypted bytes to Pinata (no local storage)
      const { uploadToIPFS } = await import("./StorageProvider.js");
      const { cid, url } = await uploadToIPFS(encrypted);

      log.info("Encrypted content pinned to Pinata", { cid, url });

      // 3. Store { cid, aesKey } in CDR secret vault
      // Payload: cid (string) + key (32 bytes) = well under 1024 byte limit
      const cidBytes  = new TextEncoder().encode(cid);
      const payload   = new Uint8Array(cidBytes.length + 1 + key.length);
      payload[0]      = cidBytes.length; // length prefix for cid
      payload.set(cidBytes, 1);
      payload.set(key, 1 + cidBytes.length);

      const { writeConditionAddr, readConditionAddr, writeConditionData, readConditionData } =
        this.buildConditionArgs(params);
      // CRITICAL: if ownerAddress in conditionData differs from signer, fix writeConditionData
      const _co = (params as any).conditionOverride;
      const _wca  = _co?.writeConditionAddr  ?? writeConditionAddr;
      const _rca  = _co?.readConditionAddr   ?? readConditionAddr;
      const _wcd  = _co?.writeConditionData  ?? writeConditionData;
      const _rcd  = _co?.readConditionData   ?? readConditionData;
      console.log("[vault] wca:", _wca, "wcd:", _wcd?.slice(0,20));
      const globalPubKey = await this.cdr.observer.getGlobalPubKey();
      const result = await this.cdr.uploader.uploadCDR({
        dataKey:            payload,
        globalPubKey,
        updatable:          params.updatable,
        writeConditionAddr,
        readConditionAddr,
        writeConditionData,
        readConditionData,
        accessAuxData:      "0x",
      });

      const record = {
        uuid:          BigInt(result.uuid),
        conditionType: params.conditionData as unknown as VaultRecord["conditionType"],
        cid,
        createdAt:     Date.now(),
        aesKey:        key,
        txHashes: {
          allocate: result.txHashes?.allocate as TxHash ?? "0x",
          write:    result.txHashes?.write    as TxHash ?? "0x",
        },
      };

      log.success("File vault created — content on Pinata, key in CDR", {
        uuid: record.uuid.toString(),
        cid,
      });

      return record;
    } catch (err) {
      if (err instanceof NexarError) throw err;
 throw new NexarError("VAULT_CREATE_FAILED", "File vault creation failed: " + String(err?.message ?? err), { cause: err });
    }
  }

  // ─── Access secret vault ───────────────────────────────────────────────────

  /**
   * Access (decrypt) an on-chain secret vault.
   * Submits read tx → collects validator partials → reconstructs key.
   * Confirmed from sdk-reference/cdr/consumer.md accessCDR().
   *
   * accessAuxData for license-gated vaults = abi.encode(uint256[] licenseTokenIds)
   */
  async accessSecretVault(params: VaultAccessParams): Promise<VaultAccessResult> {
    log.info("Accessing secret vault...", { uuid: params.uuid.toString() });

    const accessAuxData = this.buildAccessAuxData(params);

    try {
      const result = await this.cdr.consumer.accessCDR({
        uuid:          Number(params.uuid),
        accessAuxData,
        timeoutMs:     CDR_TIMEOUT_MS,
      });

      log.success("Secret vault decrypted", {
        uuid:   params.uuid.toString(),
        txHash: result.txHash,
      });

      return {
        dataKey: result.dataKey,
        txHash:  result.txHash as TxHash,
      };
    } catch (err) {
      if (err instanceof NexarError) throw err;
      // Map CDR SDK error names to NexarError codes
      const errName = (err as Error)?.name ?? "";
      if (errName === "EmptyVaultError") {
        throw new NexarError("VAULT_EMPTY",   `Vault ${params.uuid} has never been written to`, { cause: err });
      }
      if (errName === "PartialCollectionTimeoutError") {
        throw new NexarError("VAULT_TIMEOUT", `Vault ${params.uuid} timed out`, { cause: err });
      }
      throw new NexarError("VAULT_ACCESS_DENIED", `Failed to access vault ${params.uuid}`, { cause: err });
    }
  }

  // ─── Access file vault ─────────────────────────────────────────────────────

  /**
   * Access (decrypt) a file vault.
   * CDR decrypts the AES key → downloads encrypted file from IPFS → decrypts file.
   * Confirmed from sdk-reference/cdr/consumer.md downloadFile().
   */
  async accessFileVault(params: VaultAccessParams): Promise<VaultAccessResult & { cid: string }> {
    log.info("Accessing file vault (Pinata + CDR)...", { uuid: params.uuid.toString() });

    const accessAuxData = this.buildAccessAuxData(params);

    try {
      // 1. Recover payload from CDR vault (contains cid + aesKey)
      const result = await this.cdr.consumer.accessCDR({
        uuid:          Number(params.uuid),
        accessAuxData,
        timeoutMs:     CDR_TIMEOUT_MS,
      });

      const payload    = result.dataKey;
      const cidLen     = payload[0]!;
      const cidBytes   = payload.slice(1, 1 + cidLen);
      const aesKey     = payload.slice(1 + cidLen);
      const cid        = new TextDecoder().decode(cidBytes);

      log.info("CDR vault decrypted — fetching from Pinata...", { cid });

      // 2. Download encrypted bytes from Pinata
      const { downloadFromIPFS } = await import("./StorageProvider.js");
      const encryptedBytes = await downloadFromIPFS(cid);

      // 3. Decrypt with recovered AES key
      const { decrypt } = await import("./Encryptor.js");
      const content = decrypt(encryptedBytes, aesKey);

      log.success("File vault accessed and decrypted", {
        uuid:  params.uuid.toString(),
        cid,
        bytes: content.length.toString(),
      });

      return { dataKey: aesKey, content, txHash: result.txHash as TxHash, cid };
    } catch (err) {
      if (err instanceof NexarError) throw err;
      const errName = (err as Error)?.name ?? "";
      if (errName === "EmptyVaultError")               throw new NexarError("VAULT_EMPTY",   `Vault ${params.uuid} is empty`, { cause: err });
      if (errName === "PartialCollectionTimeoutError") throw new NexarError("VAULT_TIMEOUT", `Vault ${params.uuid} timed out`, { cause: err });
      throw new NexarError("VAULT_ACCESS_DENIED", `Failed to access file vault ${params.uuid}`, { cause: err });
    }
  }

  // ─── Query vault metadata (observer) ──────────────────────────────────────

  /**
   * Get vault metadata without decrypting.
   * Useful for checking if a vault exists, its condition type, etc.
   */
  async getVaultInfo(uuid: bigint): Promise<unknown> {
    try {
      return await this.cdr.observer.getVault(Number(uuid));
    } catch (err) {
      throw new NexarError("VAULT_NOT_FOUND", `Vault ${uuid} not found`, { cause: err });
    }
  }

  /**
   * Get the max payload size for on-chain secret vaults.
   * Currently 1024 bytes on Aeneid.
   */
  async getMaxSecretSize(): Promise<number> {
    return this.cdr.observer.getMaxEncryptedDataSize();
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  private buildConditionArgs(params: VaultCreateParams): {
    writeConditionAddr: `0x${string}`;
    readConditionAddr:  `0x${string}`;
    writeConditionData: `0x${string}`;
    readConditionData:  `0x${string}`;
  } {
    const d = params.conditionData;
    if (d.ipId) {
      const cond = licenseGated({ ownerAddress: d.ownerAddress as HexAddress, ipId: d.ipId as HexAddress });
      return { writeConditionAddr: cond.writeConditionAddr, readConditionAddr: cond.readConditionAddr, writeConditionData: cond.writeConditionData, readConditionData: cond.readConditionData };
    }
    const cond = ownerOnly({ ownerAddress: d.ownerAddress as HexAddress });
    return { writeConditionAddr: cond.writeConditionAddr, readConditionAddr: cond.readConditionAddr, writeConditionData: cond.writeConditionData, readConditionData: cond.readConditionData };
  }

  private buildAccessAuxData(params: VaultAccessParams): `0x${string}` {
    if (params.accessAuxData) return params.accessAuxData;
    if (params.licenseTokenIds && params.licenseTokenIds.length > 0) {
      return encodeLicenseTokenIds(params.licenseTokenIds);
    }
    return "0x";
  }
}
