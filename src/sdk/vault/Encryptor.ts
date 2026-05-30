// src/sdk/vault/Encryptor.ts
// AES-256-GCM encryption and decryption utilities.
// Used to encrypt file content before uploading to IPFS (for file vaults).
// Works in Node.js using the built-in crypto module.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { NexarError } from "../../core/errors.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const ALGORITHM  = "aes-256-gcm";
const KEY_BYTES  = 32; // 256-bit key
const IV_BYTES   = 12; // 96-bit IV (recommended for GCM)
const TAG_BYTES  = 16; // 128-bit auth tag

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EncryptedPayload {
  nexartext: Uint8Array; // encrypted content
  iv:         Uint8Array; // 12-byte initialisation vector
  tag:        Uint8Array; // 16-byte GCM auth tag
  key:        Uint8Array; // 32-byte AES key (store this in CDR vault)
}

export interface EncryptResult {
  encrypted: Uint8Array; // iv + tag + nexartext concatenated (for storage)
  key:       Uint8Array; // the AES key — this goes into the CDR vault
}

// ─── Key generation ───────────────────────────────────────────────────────────

/**
 * Generate a cryptographically secure 256-bit AES key.
 * This key is what gets encrypted and stored in the CDR vault.
 */
export function generateKey(): Uint8Array {
  return new Uint8Array(randomBytes(KEY_BYTES));
}

/**
 * Generate a 96-bit initialisation vector for AES-GCM.
 */
export function generateIV(): Uint8Array {
  return new Uint8Array(randomBytes(IV_BYTES));
}

// ─── Encryption ───────────────────────────────────────────────────────────────

/**
 * Encrypt arbitrary bytes with AES-256-GCM.
 *
 * The returned `encrypted` bytes are laid out as:
 *   [12 bytes IV][16 bytes auth tag][N bytes nexartext]
 *
 * This layout is self-contained — the decryptor only needs the key + encrypted bytes.
 * The key itself is stored in the CDR vault (encrypted with TDH2).
 *
 * @param plaintext - Raw bytes to encrypt
 * @param key       - Optional 32-byte AES key; one is generated if omitted
 */
export function encrypt(plaintext: Uint8Array, key?: Uint8Array): EncryptResult {
  const aesKey = key ?? generateKey();
  const iv     = generateIV();

  try {
    const nexar = createCipheriv(ALGORITHM, aesKey, iv);
    const encryptedParts = [
      nexar.update(Buffer.from(plaintext)),
      nexar.final(),
    ];
    const nexartext = Buffer.concat(encryptedParts);
    const tag        = nexar.getAuthTag();

    // Layout: [IV 12b][TAG 16b][NEXARTEXT Nb]
    const encrypted = new Uint8Array(IV_BYTES + TAG_BYTES + nexartext.length);
    encrypted.set(iv,                          0);
    encrypted.set(tag,                         IV_BYTES);
    encrypted.set(new Uint8Array(nexartext),  IV_BYTES + TAG_BYTES);

    return { encrypted, key: aesKey };
  } catch (err) {
    throw new NexarError(
      "VAULT_CREATE_FAILED",
      "AES-GCM encryption failed",
      { cause: err }
    );
  }
}

// ─── Decryption ───────────────────────────────────────────────────────────────

/**
 * Decrypt AES-256-GCM encrypted bytes.
 *
 * Expects the same layout produced by `encrypt()`:
 *   [12 bytes IV][16 bytes auth tag][N bytes nexartext]
 *
 * The key comes from the CDR vault (recovered via threshold decryption).
 *
 * @param encrypted - Encrypted bytes (iv + tag + nexartext)
 * @param key       - 32-byte AES key recovered from CDR vault
 */
export function decrypt(encrypted: Uint8Array, key: Uint8Array): Uint8Array {
  if (encrypted.length < IV_BYTES + TAG_BYTES + 1) {
    throw new NexarError(
      "VAULT_DECRYPT_FAILED",
      `Encrypted payload too short: ${encrypted.length} bytes`
    );
  }

  const iv         = encrypted.slice(0, IV_BYTES);
  const tag        = encrypted.slice(IV_BYTES, IV_BYTES + TAG_BYTES);
  const nexartext = encrypted.slice(IV_BYTES + TAG_BYTES);

  try {
    const denexar = createDecipheriv(ALGORITHM, key, iv);
    denexar.setAuthTag(Buffer.from(tag));

    const decryptedParts = [
      denexar.update(Buffer.from(nexartext)),
      denexar.final(),
    ];

    return new Uint8Array(Buffer.concat(decryptedParts));
  } catch (err) {
    throw new NexarError(
      "VAULT_DECRYPT_FAILED",
      "AES-GCM decryption failed — wrong key or corrupted data",
      { cause: err }
    );
  }
}

// ─── SHA-256 content hashing (for IPA metadata mediaHash) ────────────────────

import { createHash } from "node:crypto";

/**
 * Compute SHA-256 hash of bytes and return as hex string (0x-prefixed).
 * Used for IPA metadata `mediaHash` and `ipMetadataHash` fields.
 */
export function sha256Hex(data: Uint8Array): `0x${string}` {
  const hash = createHash("sha256").update(data).digest("hex");
  return `0x${hash}`;
}

/**
 * Compute SHA-256 of a JSON object (for ipMetadataHash).
 */
export function sha256Json(obj: unknown): `0x${string}` {
  const json = JSON.stringify(obj);
  return sha256Hex(new TextEncoder().encode(json));
}
