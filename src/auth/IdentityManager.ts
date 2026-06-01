// src/auth/IdentityManager.ts
// Username-first identity — registration, platform linking, recovery, pending shares.

import { getDB }          from "../db/index.js";
import { WalletManager }  from "./WalletManager.js";
import { createLogger }   from "../core/index.js";

const log = createLogger("IdentityManager");

export type Platform = "imessage" | "whatsapp" | "telegram" | "email";

export interface Identity {
  username:      string;
  walletAddress: string;
  platforms:     PlatformLink[];
  createdAt:     number;
}

export interface PlatformLink {
  platform:   Platform;
  platformId: string;
  linkedAt:   number;
}

const USERNAME_RE      = /^[a-z0-9_]{3,20}$/;
const RECOVERY_TTL_SEC = 10 * 60;
const PENDING_TTL_SEC  = 5  * 60;

const walletMgr = new WalletManager();

// ─── Resolution ────────────────────────────────────────────────────────────

export function getUsernameByPlatform(platform: Platform, platformId: string): string | null {
  const db  = getDB();
  const row = db.prepare(
    "SELECT username FROM platform_identities WHERE platform = ? AND platform_id = ?"
  ).get(platform, platformId) as { username: string } | undefined;
  return row?.username ?? null;
}

export function getIdentity(username: string): Identity | null {
  const db  = getDB();
  const row = db.prepare(
    "SELECT username, privy_wallet_id, created_at FROM usernames WHERE username = ?"
  ).get(username) as { username: string; privy_wallet_id: string; created_at: number } | undefined;
  if (!row) return null;

  const platforms = db.prepare(
    "SELECT platform, platform_id, linked_at FROM platform_identities WHERE username = ?"
  ).all(username) as PlatformLink[];

  return { username: row.username, walletAddress: "", platforms, createdAt: row.created_at };
}

export async function getWalletAddress(username: string): Promise<string | null> {
  if (!walletMgr.hasWallet(username)) return null;
  return walletMgr.getAddress(username);
}

// ─── Registration ──────────────────────────────────────────────────────────

export type RegisterResult =
  | { ok: true;  username: string; walletAddress: string; isNew: boolean }
  | { ok: false; reason: "USERNAME_TAKEN" | "INVALID_USERNAME" | "ALREADY_REGISTERED" | "ERROR" };

export async function registerUsername(
  platform:   Platform,
  platformId: string,
  username:   string,
  onRegistered?: (username: string) => Promise<void>
): Promise<RegisterResult> {
  const db = getDB();

  if (!USERNAME_RE.test(username.toLowerCase())) return { ok: false, reason: "INVALID_USERNAME" };
  const normalised = username.toLowerCase();

  const existing = getUsernameByPlatform(platform, platformId);
  if (existing) return { ok: false, reason: "ALREADY_REGISTERED" };

  const taken = db.prepare("SELECT 1 FROM usernames WHERE username = ?").get(normalised);
  if (taken)  return { ok: false, reason: "USERNAME_TAKEN" };

  try {
    if (!walletMgr.hasWallet(normalised)) await walletMgr.createWallet(normalised);
    const walletAddress = await walletMgr.getAddress(normalised);

    db.transaction(() => {
      db.prepare("INSERT INTO usernames (username, privy_wallet_id) VALUES (?, ?)").run(normalised, normalised);
      db.prepare("INSERT INTO platform_identities (username, platform, platform_id) VALUES (?, ?, ?)").run(normalised, platform, platformId);
    })();

    db.prepare("DELETE FROM pending_registrations WHERE platform = ? AND platform_id = ?").run(platform, platformId);

    log.success("Username registered", { username: normalised, platform, platformId });

    // Grant any pending shares
    if (onRegistered) {
      onRegistered(normalised).catch(err => log.warn("grantPendingShares failed", { err }));
    }

    return { ok: true, username: normalised, walletAddress, isNew: true };
  } catch (err) {
    log.error("Registration failed", { username: normalised, err });
    return { ok: false, reason: "ERROR" };
  }
}

// ─── Platform linking ──────────────────────────────────────────────────────

export function linkPlatform(username: string, platform: Platform, platformId: string): { ok: boolean; reason?: string } {
  const db = getDB();
  if (!db.prepare("SELECT 1 FROM usernames WHERE username = ?").get(username)) return { ok: false, reason: "USERNAME_NOT_FOUND" };

  const existing = getUsernameByPlatform(platform, platformId);
  if (existing === username) return { ok: true };
  if (existing)             return { ok: false, reason: "PLATFORM_ALREADY_LINKED" };

  try {
    db.prepare("INSERT OR REPLACE INTO platform_identities (username, platform, platform_id) VALUES (?, ?, ?)").run(username, platform, platformId);
    log.info("Platform linked", { username, platform, platformId });
    return { ok: true };
  } catch { return { ok: false, reason: "ERROR" }; }
}

// ─── Pending registrations ─────────────────────────────────────────────────

export function setPendingRegistration(platform: Platform, platformId: string, username: string): void {
  const db      = getDB();
  const expires = Math.floor(Date.now() / 1000) + PENDING_TTL_SEC;
  db.prepare("INSERT OR REPLACE INTO pending_registrations (platform, platform_id, desired_username, expires_at) VALUES (?, ?, ?, ?)").run(platform, platformId, username.toLowerCase(), expires);
}

export function getPendingRegistration(platform: Platform, platformId: string): string | null {
  const db  = getDB();
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare("SELECT desired_username FROM pending_registrations WHERE platform = ? AND platform_id = ? AND expires_at > ?").get(platform, platformId, now) as { desired_username: string } | undefined;
  return row?.desired_username ?? null;
}

// ─── Recovery ──────────────────────────────────────────────────────────────

export interface RecoveryInitResult {
  ok: boolean; originalPlatform?: Platform; originalId?: string; reason?: string;
}

export function initiateRecovery(username: string, newPlatform: Platform, newPlatformId: string): RecoveryInitResult {
  const db = getDB();
  if (!db.prepare("SELECT 1 FROM usernames WHERE username = ?").get(username)) return { ok: false, reason: "USERNAME_NOT_FOUND" };

  const original = db.prepare(
    "SELECT platform, platform_id FROM platform_identities WHERE username = ? ORDER BY linked_at ASC LIMIT 1"
  ).get(username) as { platform: Platform; platform_id: string } | undefined;
  if (!original) return { ok: false, reason: "NO_PLATFORMS" };

  const code    = Math.floor(100000 + Math.random() * 900000).toString();
  const expires = Math.floor(Date.now() / 1000) + RECOVERY_TTL_SEC;
  db.prepare("INSERT OR REPLACE INTO recovery_codes (username, code, new_platform, new_platform_id, expires_at) VALUES (?, ?, ?, ?, ?)").run(username, code, newPlatform, newPlatformId, expires);

  log.info("Recovery initiated", { username, originalPlatform: original.platform });
  return { ok: true, originalPlatform: original.platform as Platform, originalId: original.platform_id };
}

export function getRecoveryCode(username: string): string | null {
  const db  = getDB();
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare("SELECT code FROM recovery_codes WHERE username = ? AND expires_at > ?").get(username, now) as { code: string } | undefined;
  return row?.code ?? null;
}

export function verifyRecovery(username: string, code: string): { ok: boolean; reason?: string } {
  const db  = getDB();
  const now = Math.floor(Date.now() / 1000);
  const row = db.prepare("SELECT code, new_platform, new_platform_id FROM recovery_codes WHERE username = ? AND expires_at > ?").get(username, now) as { code: string; new_platform: Platform; new_platform_id: string } | undefined;

  if (!row)              return { ok: false, reason: "NO_PENDING_RECOVERY" };
  if (row.code !== code) return { ok: false, reason: "INVALID_CODE" };

  const linked = linkPlatform(username, row.new_platform, row.new_platform_id);
  if (!linked.ok) return linked;

  db.prepare("DELETE FROM recovery_codes WHERE username = ?").run(username);
  log.success("Recovery complete", { username, newPlatform: row.new_platform });
  return { ok: true };
}

// ─── Availability ──────────────────────────────────────────────────────────

export function isUsernameAvailable(username: string): boolean {
  if (!USERNAME_RE.test(username.toLowerCase())) return false;
  return !getDB().prepare("SELECT 1 FROM usernames WHERE username = ?").get(username.toLowerCase());
}

// ─── Pending shares check ──────────────────────────────────────────────────

export function hasPendingShares(username: string): boolean {
  return !!getDB().prepare("SELECT 1 FROM pending_shares WHERE target_username = ? LIMIT 1").get(username);
}
