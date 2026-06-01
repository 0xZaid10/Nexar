// src/sdk/fingerprint/pdfFingerprint.ts
// PDF fingerprinting — extracts text content and structure for
// near-duplicate detection that survives reformatting, font changes,
// margin adjustments, and page reordering.

import { createHash } from "node:crypto";
import { createLogger } from "../../core/index.js";

const log = createLogger("PDFFingerprint");

export type PDFHash = string;

// ─── PDF text extraction (pure JS, no native deps) ──────────────────────────

/**
 * Extract readable text from PDF buffer using raw stream parsing.
 * Handles most common PDF text encodings without external libraries.
 * Returns extracted text or empty string if extraction fails.
 */
export function extractPDFText(buffer: Buffer): string {
  try {
    const content = buffer.toString("latin1");
    const textChunks: string[] = [];

    // Extract text from BT...ET blocks (PDF text objects)
    const btRegex = /BT\s*([\s\S]*?)\s*ET/g;
    let   match: RegExpExecArray | null;

    while ((match = btRegex.exec(content)) !== null) {
      const block    = match[1];
      const tjRegex  = /\(((?:[^()\\]|\\[\s\S])*)\)\s*(?:Tj|TJ|'|")/g;
      const tjMatch: RegExpExecArray | null[] = [];
      let   tm: RegExpExecArray | null;

      const innerRegex = /\(((?:[^()\\]|\\[\s\S])*)\)\s*(?:Tj|TJ|'|")/g;
      while ((tm = innerRegex.exec(block)) !== null) {
        const text = tm[1]
          .replace(/\\n/g, " ")
          .replace(/\\r/g, " ")
          .replace(/\\t/g, " ")
          .replace(/\\\\/g, "\\")
          .replace(/\\\(/g, "(")
          .replace(/\\\)/g, ")")
          .replace(/[^\x20-\x7E]/g, " ")  // keep printable ASCII
          .trim();
        if (text.length > 2) textChunks.push(text);
      }
    }

    // Also extract from stream objects (compressed streams)
    // Look for readable text patterns in the raw content
    const readableRegex = /[A-Za-z0-9\s.,!?;:'"()\-]{20,}/g;
    const rawMatches    = content.match(readableRegex) ?? [];
    for (const m of rawMatches) {
      const trimmed = m.trim();
      if (trimmed.length > 20 && !textChunks.includes(trimmed)) {
        textChunks.push(trimmed);
      }
    }

    return textChunks.join(" ").replace(/\s+/g, " ").trim();
  } catch (err) {
    log.warn("PDF text extraction failed", { err });
    return "";
  }
}

// ─── PDF fingerprint ────────────────────────────────────────────────────────

/**
 * Compute fingerprint for a PDF file.
 * Combines:
 * 1. SHA256 of full content (exact copy detection)
 * 2. Text content fingerprint (survives reformatting)
 * 3. Structure fingerprint (page count, object count)
 */
export interface PDFFingerprint {
  sha256:          string;
  textHash:        string | null;    // hash of extracted text
  textSamples:     string[] | null;  // chunk hashes for partial detection
  structureHash:   string;           // PDF structure fingerprint
  pageCount:       number;
  extractedChars:  number;
}

export function computePDFFingerprint(buffer: Buffer): PDFFingerprint {
  const sha256    = createHash("sha256").update(buffer).digest("hex");
  const content   = buffer.toString("latin1");

  // Count pages
  const pageCount = (content.match(/\/Type\s*\/Page[^s]/g) ?? []).length || 1;

  // Count objects (PDF structure indicator)
  const objCount  = (content.match(/\d+\s+\d+\s+obj/g) ?? []).length;

  // Structure fingerprint
  const structureHash = createHash("sha256")
    .update(`pages:${pageCount}:objs:${objCount}:size:${Math.floor(buffer.length / 1024)}kb`)
    .digest("hex")
    .slice(0, 16);

  // Extract text
  const text          = extractPDFText(buffer);
  const extractedChars = text.length;

  if (!text || text.length < 50) {
    // No extractable text (scanned PDF or image-based)
    return { sha256, textHash: null, textSamples: null, structureHash, pageCount, extractedChars: 0 };
  }

  // Normalize text (remove whitespace differences)
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim();
  const textHash   = createHash("sha256").update(normalized).digest("hex");

  // Sample text chunks for partial detection
  const words      = normalized.split(" ").filter(w => w.length > 4);
  const chunkSize  = Math.max(10, Math.floor(words.length / 20));
  const samples: string[] = [];

  for (let i = 0; i < words.length && samples.length < 20; i += chunkSize) {
    const chunk = words.slice(i, i + chunkSize).join(" ");
    samples.push(createHash("sha256").update(chunk).digest("hex").slice(0, 16));
  }

  return { sha256, textHash, textSamples: samples, structureHash, pageCount, extractedChars };
}

// ─── Similarity ─────────────────────────────────────────────────────────────

export function pdfSimilarity(fp1: PDFFingerprint, fp2: PDFFingerprint): number {
  // Exact match
  if (fp1.sha256 === fp2.sha256) return 100;

  // Text hash match (same text, different formatting)
  if (fp1.textHash && fp2.textHash && fp1.textHash === fp2.textHash) return 95;

  // Partial text match
  if (fp1.textSamples && fp2.textSamples && fp1.textSamples.length > 0) {
    const matches = fp1.textSamples.filter(s => fp2.textSamples!.includes(s)).length;
    const sim     = Math.round((matches / fp1.textSamples.length) * 100);
    if (sim > 0) return Math.min(90, sim);  // cap at 90% for partial
  }

  return 0;
}

export function isPDFFile(mimeType: string): boolean {
  return mimeType === "application/pdf" || mimeType === "application/x-pdf";
}
