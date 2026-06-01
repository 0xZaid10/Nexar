// src/messaging/state/ConversationState.ts
// Conversation state machine — tracks multi-step flows per user.
// In-memory for speed, DB-backed for persistence across restarts.

import { getDB }       from "../../db/index.js";
import { createLogger } from "../../core/index.js";

const log = createLogger("ConversationState");

// ─── State types ───────────────────────────────────────────────────────────

export type ConversationStateType =
  | "idle"
  | "awaiting_access_type"      // who can access? anyone / @user / timed
  | "awaiting_share_target"     // private share: who? @username
  | "awaiting_timed_target"     // timed share: who? @username
  | "awaiting_timed_hours"      // timed share: how many hours?
  | "awaiting_license_type"     // strict / open
  | "awaiting_price"            // set price in $IP
  | "awaiting_name"             // name the asset
  | "awaiting_buy_confirm"      // confirm purchase
  | "awaiting_plagiarism_check"; // user sent file, check or register?

export interface PendingFile {
  telegramFileId: string;
  fileName:       string;
  mimeType:       string;
  sizeBytes:      number;
}

export interface ConversationContext {
  // File registration
  pendingFile?:    PendingFile;
  assetName?:      string;
  accessType?:     "anyone" | "private" | "timed";
  licenseType?:    "strict" | "open";
  price?:          string;         // "$IP amount or 'free'"
  shareTarget?:    string;         // @username for private share
  timedTarget?:    string;         // @username for timed access
  timedHours?:     number;

  // Buy flow
  pendingBuyIpId?:        string;
  pendingBuyAssetName?:   string;
  pendingBuyPrice?:       string;
  pendingBuyOwner?:       string;
  pendingBuyTermsId?:     string;
}

export interface ConversationState {
  platform:   string;
  platformId: string;
  state:      ConversationStateType;
  context:    ConversationContext;
  updatedAt:  number;
}

// ─── In-memory cache ───────────────────────────────────────────────────────

const cache = new Map<string, ConversationState>();

function key(platform: string, platformId: string): string {
  return `${platform}:${platformId}`;
}

// ─── Public API ────────────────────────────────────────────────────────────

export function getState(platform: string, platformId: string): ConversationState {
  const k = key(platform, platformId);

  // Check memory first
  if (cache.has(k)) return cache.get(k)!;

  // Fall back to DB
  const db  = getDB();
  const row = db.prepare(
    "SELECT * FROM conversation_states WHERE platform = ? AND platform_id = ?"
  ).get(platform, platformId) as { state: string; context: string; updated_at: number } | undefined;

  const state: ConversationState = {
    platform,
    platformId,
    state:     (row?.state ?? "idle") as ConversationStateType,
    context:   row?.context ? JSON.parse(row.context) : {},
    updatedAt: row?.updated_at ?? 0,
  };

  cache.set(k, state);
  return state;
}

export function setState(
  platform:   string,
  platformId: string,
  state:      ConversationStateType,
  context:    ConversationContext = {}
): void {
  const k   = key(platform, platformId);
  const now = Math.floor(Date.now() / 1000);

  const updated: ConversationState = { platform, platformId, state, context, updatedAt: now };
  cache.set(k, updated);

  // Persist to DB
  try {
    getDB().prepare(
      `INSERT OR REPLACE INTO conversation_states (platform, platform_id, state, context, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(platform, platformId, state, JSON.stringify(context), now);
  } catch (err) {
    log.warn("Failed to persist conversation state", { platform, platformId, err });
  }
}

export function clearState(platform: string, platformId: string): void {
  setState(platform, platformId, "idle", {});
}

export function updateContext(
  platform:   string,
  platformId: string,
  patch:      Partial<ConversationContext>
): void {
  const current = getState(platform, platformId);
  setState(platform, platformId, current.state, { ...current.context, ...patch });
}

export function isIdle(platform: string, platformId: string): boolean {
  return getState(platform, platformId).state === "idle";
}
