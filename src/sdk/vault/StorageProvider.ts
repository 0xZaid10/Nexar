// src/sdk/vault/StorageProvider.ts
// IPFS storage via Pinata only — no local Helia storage.
// Encrypted bytes go directly to Pinata. No files stored on our server.
// CDR vault stores only the AES key + CID pointer.
// Security model: Pinata holds ciphertext (useless without key), CDR holds key.

import { CID }          from "multiformats/cid";
import { NexarError as CipherError }  from "../../core/errors.js";
import { createLogger } from "../../core/logger.js";

const log = createLogger("StorageProvider");

const PINATA_JWT     = () => process.env.PINATA_JWT;
const PINATA_GATEWAY = () => process.env.PINATA_GATEWAY || "https://gateway.pinata.cloud";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StorageUploadResult {
  cid:     string;
  bytes:   number;
  url:     string;
}

// ─── Upload encrypted bytes to Pinata ────────────────────────────────────────

/**
 * Upload encrypted file bytes directly to Pinata.
 * No local storage — bytes go straight to Pinata's IPFS nodes.
 * Returns CID + public gateway URL (content is encrypted, URL is safe to share).
 */
export async function uploadToIPFS(encryptedBytes: Uint8Array): Promise<StorageUploadResult> {
  const jwt = PINATA_JWT();
  if (!jwt) throw new CipherError("VAULT_CREATE_FAILED", "PINATA_JWT not set — cannot upload to IPFS");

  log.info("Uploading encrypted content to Pinata...", { bytes: encryptedBytes.length.toString() });

  try {
    const formData = new FormData();
    const blob     = new Blob([encryptedBytes], { type: "application/octet-stream" });
    formData.append("file", blob, "nexar-encrypted-asset");
    formData.append("pinataMetadata", JSON.stringify({ name: `nexar-${Date.now()}` }));
    formData.append("pinataOptions",  JSON.stringify({ cidVersion: 1 }));

    const res = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method:  "POST",
      headers: { "Authorization": `Bearer ${jwt}` },
      body:    formData,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Pinata upload failed ${res.status}: ${err.slice(0, 200)}`);
    }

    const data = await res.json() as { IpfsHash: string; PinSize: number };
    const url  = `${PINATA_GATEWAY()}/ipfs/${data.IpfsHash}`;

    log.success("Uploaded to Pinata IPFS", { cid: data.IpfsHash, bytes: data.PinSize.toString() });

    return { cid: data.IpfsHash, bytes: data.PinSize, url };
  } catch (err) {
    throw new CipherError("VAULT_CREATE_FAILED", "Pinata upload failed", { cause: err });
  }
}

/**
 * Download encrypted bytes from IPFS via Pinata gateway.
 * Returns raw encrypted bytes — caller decrypts with the recovered AES key from CDR.
 */
export async function downloadFromIPFS(cidStr: string): Promise<Uint8Array> {
  const gateway = PINATA_GATEWAY();
  const url     = `${gateway}/ipfs/${cidStr}`;

  log.info("Downloading from IPFS...", { cid: cidStr });

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Gateway returned ${res.status}`);

    const buffer = await res.arrayBuffer();
    log.success("Downloaded from IPFS", { cid: cidStr, bytes: buffer.byteLength.toString() });
    return new Uint8Array(buffer);
  } catch (err) {
    throw new CipherError("VAULT_DECRYPT_FAILED", `IPFS download failed for CID: ${cidStr}`, { cause: err });
  }
}

/**
 * Upload JSON metadata to Pinata.
 * Returns public IPFS URL. Metadata is NOT encrypted — it's the public IP description.
 */
export async function uploadJSONToIPFS(obj: unknown): Promise<string> {
  return pinJSONToPinata(obj, `nexar-meta-${Date.now()}`) ?? "https://nexar.foundation/meta/fallback.json";
}

/**
 * Pin JSON directly to Pinata.
 */
export async function pinJSONToPinata(obj: unknown, name: string): Promise<string | null> {
  const jwt = PINATA_JWT();
  if (!jwt) {
    log.warn("PINATA_JWT not set — metadata will not be pinned");
    return null;
  }

  try {
    const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method:  "POST",
      headers: { "Authorization": `Bearer ${jwt}`, "Content-Type": "application/json" },
      body:    JSON.stringify({ pinataContent: obj, pinataMetadata: { name } }),
    });

    if (!res.ok) {
      log.warn("Pinata pinJSON failed", { status: res.status.toString() });
      return null;
    }

    const data = await res.json() as { IpfsHash: string };
    const url  = `${PINATA_GATEWAY()}/ipfs/${data.IpfsHash}`;
    log.debug("JSON pinned to Pinata", { cid: data.IpfsHash });
    return url;
  } catch (err) {
    log.warn("Pinata pinJSON error", { err: String(err) });
    return null;
  }
}

/**
 * No-op stub — kept for CDR SDK compatibility.
 * CDR SDK's uploadFile() needs a storageProvider param.
 * We handle uploads ourselves via uploadToIPFS() so this is never actually called.
 */
export async function getCDRStorageProvider(): Promise<null> {
  return null;
}
