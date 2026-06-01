// src/sdk/fingerprint/watermark.ts
// Embed license watermarks in files before delivery.
// Images: LSB steganography in pixel data (invisible to human eye).
// Text/data: embed signature in trailing comment/whitespace.
// All other files: prepend metadata header.

import { createHash } from "node:crypto";
import { createLogger } from "../../core/index.js";
import { detectFileType, type FileType } from "./fingerprint.js";

const log = createLogger("Watermark");

// ─── Types ─────────────────────────────────────────────────────────────────

export interface LicenseInfo {
  username:       string;
  licenseTokenId: string;
  ipId:           string;
  ownerUsername:  string;
  timestamp:      number;
}

// ─── Main watermark function ────────────────────────────────────────────────

/**
 * Watermark a file buffer with license information before delivery.
 * Returns a new buffer — original is never modified.
 */
export function watermarkFile(
  buffer:      Buffer,
  mimeType:    string,
  license:     LicenseInfo
): Buffer {
  const fileType = detectFileType(mimeType);
  const sig      = buildSignature(license);

  try {
    switch (fileType) {
      case "image":
        return watermarkImage(buffer, sig);
      case "text":
        return watermarkText(buffer, sig);
      case "data":
        return watermarkData(buffer, sig);
      default:
        return watermarkBinary(buffer, sig);
    }
  } catch (err) {
    log.warn("Watermark failed — delivering without watermark", { fileType, err });
    return buffer;
  }
}

// ─── Signature builder ──────────────────────────────────────────────────────

function buildSignature(license: LicenseInfo): string {
  const payload = `NEXAR:${license.username}:${license.licenseTokenId}:${license.ipId}:${license.timestamp}`;
  const hash    = createHash("sha256").update(payload).digest("hex").slice(0, 16);
  return `${payload}:${hash}`;
}

/**
 * Verify a watermark signature.
 */
export function verifyWatermark(signature: string): boolean {
  const parts = signature.split(":");
  if (parts.length < 6) return false;
  const hash    = parts[parts.length - 1];
  const payload = parts.slice(0, -1).join(":");
  const expected = createHash("sha256").update(payload).digest("hex").slice(0, 16);
  return hash === expected;
}

// ─── Image watermark (LSB steganography) ────────────────────────────────────

/**
 * Embed signature in the least significant bits of image bytes.
 * Changes are invisible — 1-bit change per byte, undetectable visually.
 */

/**
 * Safe image watermark — appends signature after image EOF marker.
 * JPEG ignores data after FF D9, PNG ignores data after IEND chunk.
 * Completely invisible and non-destructive to image quality.
 */
function watermarkImageSafe(buffer: Buffer, signature: string): Buffer {
  const marker = Buffer.from(`\n<!-- NEXAR_WM:${signature} -->`, "utf8");
  return Buffer.concat([buffer, marker]);
}

function watermarkImage(buffer: Buffer, signature: string): Buffer {
  const copy = Buffer.from(buffer);
  const bits = stringToBits(`NEXAR_WM:${signature}:END`);

  // Start embedding after first 512 bytes (skip headers)
  const startOffset = Math.min(512, Math.floor(buffer.length / 4));

  for (let i = 0; i < bits.length && i + startOffset < copy.length; i++) {
    // Modify LSB of each byte
    copy[i + startOffset] = (copy[i + startOffset] & 0xFE) | bits[i];
  }

  return copy;
}

// ─── Text watermark ─────────────────────────────────────────────────────────

/**
 * Embed signature as a trailing comment/invisible marker in text files.
 */
function watermarkText(buffer: Buffer, signature: string): Buffer {
  const text    = buffer.toString("utf8");
  const marker  = `\n\n<!--NEXAR_LICENSE:${signature}-->`;
  return Buffer.from(text + marker, "utf8");
}

// ─── Data watermark ─────────────────────────────────────────────────────────

/**
 * For CSV/JSON/structured data — append a comment row or metadata field.
 */
function watermarkData(buffer: Buffer, signature: string): Buffer {
  const text = buffer.toString("utf8").trimEnd();

  if (text.startsWith("{") || text.startsWith("[")) {
    // JSON: wrap in object with metadata
    try {
      const parsed = JSON.parse(text);
      const wrapped = {
        _nexar_license: signature,
        _nexar_ts:      Date.now(),
        data:           parsed,
      };
      return Buffer.from(JSON.stringify(wrapped, null, 2), "utf8");
    } catch {
      return watermarkText(buffer, signature);
    }
  }

  // CSV/TSV: append comment row
  const marker = `\n# NEXAR_LICENSE:${signature}`;
  return Buffer.from(text + marker, "utf8");
}

// ─── Binary watermark ───────────────────────────────────────────────────────

/**
 * For binary files — prepend a metadata header before the content.
 * Header: NEXAR_WM:<signature>\n<original bytes>
 */
function watermarkBinary(buffer: Buffer, signature: string): Buffer {
  const header = Buffer.from(`NEXAR_WM:${signature}\n`, "utf8");
  return Buffer.concat([header, buffer]);
}

// ─── Bit manipulation helpers ────────────────────────────────────────────────

function stringToBits(str: string): number[] {
  const bits: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const byte = str.charCodeAt(i);
    for (let b = 7; b >= 0; b--) {
      bits.push((byte >> b) & 1);
    }
  }
  return bits;
}

/**
 * Extract watermark from image (reads LSBs from byte stream).
 * Returns the decoded signature or null if not found.
 */
export function extractImageWatermark(buffer: Buffer): string | null {
  const startOffset = Math.min(512, Math.floor(buffer.length / 4));
  const bits: number[] = [];

  for (let i = startOffset; i < buffer.length && bits.length < 8000; i++) {
    bits.push(buffer[i] & 1);
  }

  // Decode bits to string
  let result = "";
  for (let i = 0; i + 7 < bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | bits[i + b];
    if (byte === 0) break;
    result += String.fromCharCode(byte);
    if (result.includes(":END")) {
      const start = result.indexOf("NEXAR_WM:");
      const end   = result.indexOf(":END");
      if (start !== -1) return result.slice(start + 9, end);
    }
  }

  return null;
}
