// src/sdk/fingerprint/fingerprint.ts
// Unified content fingerprinting — SHA256 + type-specific perceptual hashing.
// Covers: images (pHash), audio (energy fingerprint), video (frame sampling),
// PDF (text extraction), text/data (chunk sampling).

import { createHash }        from "node:crypto";
import { getDB }             from "../../db/index.js";
import { computePHash, pHashSimilarity, type PHash } from "./pHash.js";
import { computeAudioFingerprint, audioFingerprintSimilarity, isAudioFile } from "./audioFingerprint.js";
import { computeVideoFingerprint, videoFingerprintSimilarity, isVideoFile } from "./videoFingerprint.js";
import { computePDFFingerprint, pdfSimilarity, isPDFFile, type PDFFingerprint } from "./pdfFingerprint.js";
import { createLogger }      from "../../core/index.js";

const log = createLogger("Fingerprint");

// ─── Types ─────────────────────────────────────────────────────────────────

export type FileType = "image" | "video" | "audio" | "pdf" | "text" | "data" | "other";

export interface ContentFingerprint {
  sha256:       string;
  pHash:        PHash | null;
  audioHash:    string | null;
  videoHash:    string | null;
  pdfData:      PDFFingerprint | null;
  samples:      string[] | null;
  fileType:     FileType;
  mimeType:     string;
  sizeBytes:    number;
}

export interface DuplicateMatch {
  ipId:       string;
  owner:      string;
  assetName:  string;
  similarity: number;
  matchType:  "exact" | "perceptual" | "audio" | "video" | "pdf_text" | "fingerprint";
}

// ─── File type detection ────────────────────────────────────────────────────

export function detectFileType(mimeType: string): FileType {
  if (!mimeType) return "other";
  const m = mimeType.toLowerCase();
  if (m.startsWith("image/"))                                    return "image";
  if (isVideoFile(m))                                            return "video";
  if (isAudioFile(m))                                            return "audio";
  if (isPDFFile(m))                                              return "pdf";
  if (m.startsWith("text/") || m === "application/json"
    || m === "application/xml" || m === "application/javascript") return "text";
  if (m.includes("csv") || m.includes("spreadsheet")
    || m.includes("parquet") || m.includes("arrow"))             return "data";
  return "other";
}

// ─── Fingerprint computation ─────────────────────────────────────────────────

export function computeFingerprint(buffer: Buffer, mimeType: string): ContentFingerprint {
  const fileType   = detectFileType(mimeType);
  const sha256     = createHash("sha256").update(buffer).digest("hex");
  let   pHash:     PHash | null       = null;
  let   audioHash: string | null      = null;
  let   videoHash: string | null      = null;
  let   pdfData:   PDFFingerprint | null = null;
  let   samples:   string[] | null    = null;

  try {
    switch (fileType) {
      case "image":
        pHash = computePHash(buffer);
        break;
      case "audio":
        audioHash = computeAudioFingerprint(buffer);
        break;
      case "video":
        videoHash = computeVideoFingerprint(buffer);
        break;
      case "pdf":
        pdfData   = computePDFFingerprint(buffer);
        samples   = pdfData.textSamples;
        break;
      case "text":
      case "data":
        samples   = sampleFingerprints(buffer, 20);
        break;
    }
  } catch (err) {
    log.warn("Fingerprint computation partial failure", { fileType, err });
  }

  return { sha256, pHash, audioHash, videoHash, pdfData, samples, fileType, mimeType, sizeBytes: buffer.length };
}

export function sampleFingerprints(buffer: Buffer, n = 20): string[] {
  const chunkSize = 64;
  const step      = Math.max(chunkSize, Math.floor(buffer.length / n));
  const hashes: string[] = [];
  for (let i = 0; i < buffer.length && hashes.length < n; i += step) {
    const chunk = buffer.slice(i, i + chunkSize);
    hashes.push(createHash("sha256").update(chunk).digest("hex").slice(0, 16));
  }
  return hashes;
}

// ─── Duplicate detection ─────────────────────────────────────────────────────

export function checkDuplicate(fp: ContentFingerprint): DuplicateMatch | null {
  const db = getDB();

  // 1. Exact SHA256
  const exact = db.prepare(
    "SELECT ip_id, owner, asset_name FROM asset_fingerprints WHERE sha256 = ?"
  ).get(fp.sha256) as { ip_id: string; owner: string; asset_name: string } | undefined;
  if (exact) return { ipId: exact.ip_id, owner: exact.owner, assetName: exact.asset_name, similarity: 100, matchType: "exact" };

  // 2. Image pHash
  if (fp.pHash && fp.fileType === "image") {
    const rows = db.prepare(
      "SELECT ip_id, owner, asset_name, phash FROM asset_fingerprints WHERE phash IS NOT NULL AND file_type = 'image'"
    ).all() as { ip_id: string; owner: string; asset_name: string; phash: string }[];
    let best: DuplicateMatch | null = null;
    for (const row of rows) {
      const sim = pHashSimilarity(fp.pHash, row.phash);
      if (sim >= 85 && (!best || sim > best.similarity)) {
        best = { ipId: row.ip_id, owner: row.owner, assetName: row.asset_name, similarity: sim, matchType: "perceptual" };
      }
    }
    if (best) return best;
  }

  // 3. Audio fingerprint
  if (fp.audioHash && fp.fileType === "audio") {
    const rows = db.prepare(
      "SELECT ip_id, owner, asset_name, audio_hash FROM asset_fingerprints WHERE audio_hash IS NOT NULL AND file_type = 'audio'"
    ).all() as { ip_id: string; owner: string; asset_name: string; audio_hash: string }[];
    for (const row of rows) {
      const sim = audioFingerprintSimilarity(fp.audioHash, row.audio_hash);
      if (sim >= 85) return { ipId: row.ip_id, owner: row.owner, assetName: row.asset_name, similarity: sim, matchType: "audio" };
    }
  }

  // 4. Video fingerprint
  if (fp.videoHash && fp.fileType === "video") {
    const rows = db.prepare(
      "SELECT ip_id, owner, asset_name, video_hash FROM asset_fingerprints WHERE video_hash IS NOT NULL AND file_type = 'video'"
    ).all() as { ip_id: string; owner: string; asset_name: string; video_hash: string }[];
    for (const row of rows) {
      const sim = videoFingerprintSimilarity(fp.videoHash, row.video_hash);
      if (sim >= 80) return { ipId: row.ip_id, owner: row.owner, assetName: row.asset_name, similarity: sim, matchType: "video" };
    }
  }

  // 5. PDF text similarity
  if (fp.pdfData && fp.fileType === "pdf") {
    const rows = db.prepare(
      "SELECT ip_id, owner, asset_name, fingerprints, phash FROM asset_fingerprints WHERE file_type = 'pdf'"
    ).all() as { ip_id: string; owner: string; asset_name: string; fingerprints: string | null; phash: string | null }[];
    for (const row of rows) {
      try {
        if (row.phash && fp.pdfData.textHash && row.phash === fp.pdfData.textHash) {
          return { ipId: row.ip_id, owner: row.owner, assetName: row.asset_name, similarity: 95, matchType: "pdf_text" };
        }
        if (row.fingerprints && fp.pdfData.textSamples) {
          const existing: string[] = JSON.parse(row.fingerprints);
          const matches = fp.pdfData.textSamples.filter(s => existing.includes(s)).length;
          const sim = Math.round((matches / fp.pdfData.textSamples.length) * 100);
          if (sim >= 70) return { ipId: row.ip_id, owner: row.owner, assetName: row.asset_name, similarity: sim, matchType: "pdf_text" };
        }
      } catch { /* skip */ }
    }
  }

  // 6. Text/data chunk sampling
  if (fp.samples && fp.samples.length > 0 && ["text", "data"].includes(fp.fileType)) {
    const rows = db.prepare(
      "SELECT ip_id, owner, asset_name, fingerprints FROM asset_fingerprints WHERE fingerprints IS NOT NULL AND file_type IN ('text','data')"
    ).all() as { ip_id: string; owner: string; asset_name: string; fingerprints: string }[];
    for (const row of rows) {
      try {
        const existing: string[] = JSON.parse(row.fingerprints);
        const matches = fp.samples.filter(s => existing.includes(s)).length;
        const sim     = Math.round((matches / fp.samples.length) * 100);
        if (sim >= 70) return { ipId: row.ip_id, owner: row.owner, assetName: row.asset_name, similarity: sim, matchType: "fingerprint" };
      } catch { /* skip */ }
    }
  }

  return null;
}

// ─── Store fingerprint ──────────────────────────────────────────────────────

export function storeFingerprint(ipId: string, owner: string, assetName: string, fp: ContentFingerprint): void {
  try {
    // Store pdfData.textHash in phash column for PDFs (reuse column)
    const phashVal = fp.pHash ?? (fp.pdfData?.textHash ?? null);
    const samplesVal = fp.samples ?? (fp.pdfData?.textSamples ?? null);

    getDB().prepare(`
      INSERT OR REPLACE INTO asset_fingerprints
        (ip_id, owner, asset_name, sha256, phash, audio_hash, video_hash, fingerprints, file_type, mime_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ipId, owner, assetName,
      fp.sha256,
      phashVal,
      fp.audioHash ?? null,
      fp.videoHash ?? null,
      samplesVal ? JSON.stringify(samplesVal) : null,
      fp.fileType,
      fp.mimeType
    );
    log.info("Fingerprint stored", { ipId, fileType: fp.fileType, owner });
  } catch (err) {
    log.warn("Failed to store fingerprint", { ipId, err });
  }
}

export function getAssetsByOwner(owner: string): Array<{ ipId: string; assetName: string; fileType: string }> {
  const rows = getDB().prepare(
    "SELECT ip_id, asset_name, file_type FROM asset_fingerprints WHERE owner = ? ORDER BY created_at DESC"
  ).all(owner) as { ip_id: string; asset_name: string; file_type: string }[];
  return rows.map(r => ({ ipId: r.ip_id, assetName: r.asset_name, fileType: r.file_type }));
}
