// src/runtime/StreamingRuntime.ts
// Server-side streaming: CDR vault decryption → chunked ReadableStream.
// CDR decrypts the AES key via threshold decryption.
// The decrypted file bytes are then chunked and streamed to the caller.
// Caller never touches raw CDR SDK — just gets a ReadableStream.
// Multi-user: each stream is independently initiated per session token.

import type { CDRClient } from "@piplabs/cdr-sdk";
import { Readable }       from "node:stream";

import { CDR_TIMEOUT_MS }         from "../core/config.js";
import { NexarError }            from "../core/errors.js";
import { createLogger }           from "../core/logger.js";
import { AccessVerifier }         from "./AccessVerifier.js";
import { SessionTokens }          from "./SessionTokens.js";
import { getCDRStorageProvider }  from "../sdk/vault/StorageProvider.js";
import { encodeLicenseTokenIds }  from "../sdk/vault/ConditionBuilder.js";
import type { HexAddress, TxHash } from "../core/types.js";

const log = createLogger("StreamingRuntime");

const DEFAULT_CHUNK_SIZE = 64 * 1024; // 64KB chunks

// ─── Stream result ────────────────────────────────────────────────────────────

export interface StreamResult {
  stream:      Readable;
  totalBytes:  number;
  contentType: string;
  txHash:      TxHash;
  vaultUuid:   bigint;
}

// ─── StreamingRuntime ─────────────────────────────────────────────────────────

export class StreamingRuntime {
  private readonly cdr:       CDRClient;
  private readonly verifier:  AccessVerifier;
  private readonly tokens:    SessionTokens;

  constructor(
    cdrClient:      CDRClient,
    accessVerifier: AccessVerifier,
    sessionTokens:  SessionTokens
  ) {
    this.cdr      = cdrClient;
    this.verifier = accessVerifier;
    this.tokens   = sessionTokens;
  }

  /**
   * Create a decrypted ReadableStream from a CDR vault.
   * Used for: encrypted video, audio, datasets, model weights delivery.
   *
   * Flow:
   *   1. Verify runtime token (scoped to this vault + "stream" op)
   *   2. CDR threshold decryption → recover AES key + download file from IPFS
   *   3. Return decrypted bytes as a chunked Readable stream
   *
   * Multi-user: each call is independently authenticated + decrypted.
   * The CDR read tx is submitted by the caller's wallet (in their session).
   *
   * @param params.runtimeToken    - JWT from SessionTokens.issueStreamToken()
   * @param params.ipId            - Story IP Asset ID (for license verification)
   * @param params.licenseTokenIds - License tokens proving access (optional for owner)
   * @param params.contentType     - MIME type to pass through to caller
   * @param params.chunkSize       - Bytes per chunk (default 64KB)
   */
  async createStream(params: {
    runtimeToken:     string;
    ipId:             HexAddress;
    licenseTokenIds?: bigint[];
    contentType?:     string;
    chunkSize?:       number;
  }): Promise<StreamResult> {

    // ── 1. Verify runtime token ───────────────────────────────────────────────
    const tokenPayload = this.tokens.verify(params.runtimeToken, "stream");
    const vaultUuid    = BigInt(tokenPayload.vault);
    const caller       = tokenPayload.sub;

    log.info("Creating stream...", {
      caller,
      vault:       vaultUuid.toString(),
      contentType: params.contentType ?? "application/octet-stream",
    });

    // Build accessAuxData from license tokens
    const accessAuxData = params.licenseTokenIds?.length
      ? encodeLicenseTokenIds(params.licenseTokenIds)
      : "0x";

    // ── 2. CDR threshold decryption + IPFS download ───────────────────────────
    // Confirmed from sdk-reference/cdr/consumer.md downloadFile():
    //   { content, dataKey, cid, txHash } = await consumer.downloadFile({
    //     uuid, accessAuxData, storageProvider, timeoutMs })
    try {
      const storageProvider = await getCDRStorageProvider();

      const result = await this.cdr.consumer.downloadFile({
        uuid:            Number(vaultUuid),
        accessAuxData,
        storageProvider,
        timeoutMs:       CDR_TIMEOUT_MS,
      });

      const content = result.content;
      const txHash  = result.txHash as TxHash;

      log.success("Vault decrypted", {
        vault:  vaultUuid.toString(),
        bytes:  content.length.toString(),
        txHash,
      });

      // ── 3. Chunk decrypted bytes into ReadableStream ─────────────────────────
      const chunkSize = params.chunkSize ?? DEFAULT_CHUNK_SIZE;
      const stream    = this._bytesToStream(content, chunkSize);

      return {
        stream,
        totalBytes:  content.length,
        contentType: params.contentType ?? "application/octet-stream",
        txHash,
        vaultUuid,
      };
    } catch (err) {
      if (err instanceof NexarError) throw err;
      const name = (err as Error)?.name ?? "";
      if (name === "EmptyVaultError") {
        throw new NexarError("VAULT_EMPTY", `Vault ${vaultUuid} is empty`);
      }
      if (name === "PartialCollectionTimeoutError") {
        throw new NexarError("VAULT_TIMEOUT", `Vault ${vaultUuid} timed out`);
      }
      throw new NexarError("STREAM_FAILED", `Stream creation failed for vault ${vaultUuid}`, { cause: err });
    }
  }

  /**
   * Stream a small on-chain secret vault (≤1024 bytes).
   * For strategies, prompts, API keys — returned as a complete buffer stream.
   */
  async createSecretStream(params: {
    runtimeToken:     string;
    licenseTokenIds?: bigint[];
  }): Promise<StreamResult> {

    const tokenPayload = this.tokens.verify(params.runtimeToken, "stream");
    const vaultUuid    = BigInt(tokenPayload.vault);

    log.info("Streaming secret vault...", { vault: vaultUuid.toString() });

    const accessAuxData = params.licenseTokenIds?.length
      ? encodeLicenseTokenIds(params.licenseTokenIds)
      : "0x";

    try {
      // Confirmed from sdk-reference/cdr/consumer.md accessCDR():
      //   { dataKey, txHash } = await consumer.accessCDR({ uuid, accessAuxData, timeoutMs })
      const result = await this.cdr.consumer.accessCDR({
        uuid:          Number(vaultUuid),
        accessAuxData,
        timeoutMs:     CDR_TIMEOUT_MS,
      });

      const stream = this._bytesToStream(result.dataKey, DEFAULT_CHUNK_SIZE);

      return {
        stream,
        totalBytes:  result.dataKey.length,
        contentType: "application/octet-stream",
        txHash:      result.txHash as TxHash,
        vaultUuid,
      };
    } catch (err) {
      if (err instanceof NexarError) throw err;
      throw new NexarError("STREAM_FAILED", `Secret stream failed for vault ${vaultUuid}`, { cause: err });
    }
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _bytesToStream(bytes: Uint8Array, chunkSize: number): Readable {
    const buf = Buffer.from(bytes);
    let offset = 0;

    return new Readable({
      read() {
        if (offset >= buf.length) {
          this.push(null); // end of stream
          return;
        }
        const chunk = buf.subarray(offset, offset + chunkSize);
        offset += chunkSize;
        this.push(chunk);
      },
    });
  }
}
