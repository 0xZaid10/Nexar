// src/runtime/InferenceRuntime.ts
// Confidential inference execution.
// CDR vault decrypted → inference executed → output returned only.
// HuggingFace Inference API wired and ready.
// Set HF_API_TOKEN + HF_MODEL_ID in .env to activate real inference.

import type { CDRClient } from "@piplabs/cdr-sdk";

import { CDR_TIMEOUT_MS }          from "../core/config.js";
import { NexarError as CipherError }             from "../core/errors.js";
import { createLogger }            from "../core/logger.js";
import { SessionTokens }           from "./SessionTokens.js";
import { QuotaEnforcer }           from "./QuotaEnforcer.js";
import { getCDRStorageProvider }   from "../sdk/vault/StorageProvider.js";
import { encodeLicenseTokenIds }   from "../sdk/vault/ConditionBuilder.js";
import type { HexAddress, TxHash, InferenceRequest, InferenceResult, RuntimeQuota } from "../core/types.js";

const log = createLogger("InferenceRuntime");

// ─── HuggingFace inference ────────────────────────────────────────────────────

async function runHuggingFaceInference(
  modelContext: string,
  prompt:       string,
  modelId:      string,
  maxTokens:    number = 512
): Promise<string> {
  const hfToken = process.env.HF_API_TOKEN;
  if (!hfToken) throw new Error("HF_API_TOKEN not set");

  const url = `https://api-inference.huggingface.co/models/${modelId}`;

  const body = {
    inputs: `${modelContext}\n\nUser: ${prompt}\nAssistant:`,
    parameters: {
      max_new_tokens:    maxTokens,
      temperature:       0.7,
      return_full_text:  false,
      do_sample:         true,
    },
  };

  const res = await fetch(url, {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${hfToken}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`HuggingFace API error ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json() as Array<{ generated_text?: string }> | { generated_text?: string };

  if (Array.isArray(data)) {
    return data[0]?.generated_text?.trim() ?? "";
  }
  return (data as { generated_text?: string }).generated_text?.trim() ?? "";
}

// ─── InferenceRuntime ─────────────────────────────────────────────────────────

export class InferenceRuntime {
  private readonly cdr:    CDRClient;
  private readonly tokens: SessionTokens;
  private readonly quota:  QuotaEnforcer;

  constructor(cdrClient: CDRClient, sessionTokens: SessionTokens, quotaEnforcer: QuotaEnforcer) {
    this.cdr    = cdrClient;
    this.tokens = sessionTokens;
    this.quota  = quotaEnforcer;
  }

  async runInference(request: InferenceRequest): Promise<InferenceResult> {
    // Verify runtime token
    const tokenPayload = this.tokens.verify(request.sessionToken ?? "", "inference");
    const vaultUuid    = BigInt(tokenPayload.vault);
    const caller       = tokenPayload.sub;
    const ipId         = tokenPayload.ipId as HexAddress;

    log.info("Running inference...", {
      caller,
      vault:  vaultUuid.toString(),
      prompt: request.prompt.slice(0, 50) + "...",
    });

    // Pre-flight quota check
    const quotaBefore = await this.quota.check(caller, ipId);

    // CDR decryption — recover vault content
    const accessAuxData = request.licenseTokenId
      ? encodeLicenseTokenIds([request.licenseTokenId])
      : "0x";

    let vaultContent: Uint8Array;

    try {
      const storageProvider = await getCDRStorageProvider();
      const result = await this.cdr.consumer.downloadFile({
        uuid: Number(vaultUuid), accessAuxData, storageProvider, timeoutMs: CDR_TIMEOUT_MS,
      });
      vaultContent = result.content;
    } catch {
      try {
        const result = await this.cdr.consumer.accessCDR({
          uuid: Number(vaultUuid), accessAuxData, timeoutMs: CDR_TIMEOUT_MS,
        });
        vaultContent = result.dataKey;
      } catch (err) {
        throw new CipherError("INFERENCE_FAILED", `Failed to decrypt inference vault ${vaultUuid}`, { cause: err });
      }
    }

    // Execute inference — vault content is the model context
    const output = await this._executeInference(vaultContent, request.prompt, request.maxTokens);

    // Update quota cache
    this.quota.incrementLocalCache(caller, ipId);

    const quotaAfter: RuntimeQuota = {
      address:   caller,
      ipId,
      used:      quotaBefore.used + 1,
      max:       quotaBefore.max,
      remaining: Math.max(0, quotaBefore.remaining - 1),
    };

    log.success("Inference complete", {
      caller,
      vault:          vaultUuid.toString(),
      outputLength:   output.length.toString(),
      quotaRemaining: quotaAfter.remaining.toString(),
    });

    return { output, computeUsed: quotaAfter.used, quotaRemaining: quotaAfter.remaining, ipId, executedAt: Date.now() };
  }

  private async _executeInference(
    vaultContent: Uint8Array,
    prompt:       string,
    maxTokens?:   number
  ): Promise<string> {
    const modelContext = new TextDecoder().decode(vaultContent);

    // ── REAL INFERENCE: HuggingFace ──────────────────────────────────────────
    const hfToken  = process.env.HF_API_TOKEN;
    const hfModel  = process.env.HF_MODEL_ID;

    if (hfToken && hfModel) {
      log.info("Running HuggingFace inference...", { model: hfModel });
      try {
        const output = await runHuggingFaceInference(modelContext, prompt, hfModel, maxTokens);
        log.success("HuggingFace inference complete", { outputLength: output.length.toString() });
        return output;
      } catch (err) {
        log.warn("HuggingFace inference failed — falling back to simulation", { err: String(err) });
      }
    }

    // ── FALLBACK SIMULATION (until HF_API_TOKEN + HF_MODEL_ID set) ──────────
    log.warn("HF_API_TOKEN or HF_MODEL_ID not set — using simulation. Set both in .env for real inference.");
    await new Promise((r) => setTimeout(r, 150));

    return [
      `[NEXAR Inference — Simulation Mode]`,
      `Prompt: "${prompt.slice(0, 100)}"`,
      `Context: ${modelContext.length} bytes loaded from CDR vault (confidential)`,
      `Output: Set HF_API_TOKEN and HF_MODEL_ID in .env for real inference.`,
      `Timestamp: ${new Date().toISOString()}`,
    ].join("\n");
  }
}
