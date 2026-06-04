// src/db/Database.ts
import BetterSqlite3 from "better-sqlite3";
import { mkdirSync }  from "node:fs";
import { createLogger } from "../core/logger.js";

const log = createLogger("Database");

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS wallets (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    label            TEXT    NOT NULL UNIQUE,
    address          TEXT    NOT NULL UNIQUE,
    encrypted_pk     TEXT,
    privy_wallet_id  TEXT,
    created_at       INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS vault_secrets (
    vault_uuid  TEXT PRIMARY KEY,
    cid         TEXT NOT NULL,
    aes_key     BLOB NOT NULL,
    created_at  INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    jti         TEXT    NOT NULL UNIQUE,
    address     TEXT    NOT NULL,
    vault_uuid  TEXT,
    ip_id       TEXT,
    role        TEXT    NOT NULL,
    expires_at  INTEGER NOT NULL,
    revoked     INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS relayer_spend (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    address     TEXT    NOT NULL UNIQUE,
    total_reads INTEGER NOT NULL DEFAULT 0,
    last_read   INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS assets (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id        TEXT,
    ip_id           TEXT    NOT NULL UNIQUE,
    vault_uuid      TEXT    NOT NULL,
    vault_cid       TEXT,
    tier            INTEGER NOT NULL,
    owner           TEXT    NOT NULL,
    name            TEXT    NOT NULL,
    asset_type      TEXT    NOT NULL,
    license_terms_id TEXT,
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS licenses (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    license_token_id TEXT    NOT NULL UNIQUE,
    licensor_ip_id   TEXT    NOT NULL,
    license_terms_id TEXT    NOT NULL,
    holder_address   TEXT    NOT NULL,
    minted_at        INTEGER NOT NULL DEFAULT (unixepoch()),
    tx_hash          TEXT
  );

  -- ── Identity ──────────────────────────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS usernames (
    username        TEXT PRIMARY KEY,
    privy_wallet_id TEXT NOT NULL,
    created_at      INTEGER DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS platform_identities (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT NOT NULL REFERENCES usernames(username),
    platform    TEXT NOT NULL,
    platform_id TEXT NOT NULL,
    verified    INTEGER DEFAULT 1,
    linked_at   INTEGER DEFAULT (unixepoch()),
    UNIQUE(platform, platform_id)
  );

  CREATE TABLE IF NOT EXISTS pending_registrations (
    platform_id      TEXT NOT NULL,
    platform         TEXT NOT NULL,
    desired_username TEXT NOT NULL,
    created_at       INTEGER DEFAULT (unixepoch()),
    expires_at       INTEGER NOT NULL,
    PRIMARY KEY (platform, platform_id)
  );

  CREATE TABLE IF NOT EXISTS recovery_codes (
    username        TEXT NOT NULL REFERENCES usernames(username),
    code            TEXT NOT NULL,
    new_platform    TEXT NOT NULL,
    new_platform_id TEXT NOT NULL,
    created_at      INTEGER DEFAULT (unixepoch()),
    expires_at      INTEGER NOT NULL,
    PRIMARY KEY (username)
  );

  -- ── Conversation state ────────────────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS conversation_states (
    platform    TEXT NOT NULL,
    platform_id TEXT NOT NULL,
    state       TEXT NOT NULL DEFAULT 'idle',
    context     TEXT NOT NULL DEFAULT '{}',
    updated_at  INTEGER DEFAULT (unixepoch()),
    PRIMARY KEY (platform, platform_id)
  );

  -- ── Content fingerprints ──────────────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS asset_fingerprints (
    ip_id        TEXT PRIMARY KEY,
    owner        TEXT NOT NULL,
    asset_name   TEXT NOT NULL,
    sha256       TEXT NOT NULL,
    phash        TEXT,
    audio_hash   TEXT,
    video_hash   TEXT,
    fingerprints TEXT,
    file_type    TEXT NOT NULL DEFAULT 'other',
    mime_type    TEXT,
    created_at   INTEGER DEFAULT (unixepoch())
  );

  -- ── Pending shares (invite path) ──────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS pending_shares (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_id           TEXT    NOT NULL,
    vault_uuid      TEXT    NOT NULL,
    owner_username  TEXT    NOT NULL,
    asset_name      TEXT    NOT NULL,
    target_username TEXT    NOT NULL,
    created_at      INTEGER DEFAULT (unixepoch())
  );

  -- ── Access tokens (link path) ─────────────────────────────────────────────

  CREATE TABLE IF NOT EXISTS access_tokens (
    token           TEXT PRIMARY KEY,
    vault_uuid      TEXT    NOT NULL,
    ip_id           TEXT    NOT NULL,
    owner_username  TEXT    NOT NULL,
    asset_name      TEXT    NOT NULL,
    single_use      INTEGER NOT NULL DEFAULT 1,
    uses_remaining  INTEGER,
    expires_at      INTEGER NOT NULL,
    created_at      INTEGER DEFAULT (unixepoch())
  );

  -- ── EIP-712 session delegations ───────────────────────────────────────────
  -- User signs once in Mini App → server uses delegation for CDR reads + claims.
  -- Replaces vault_secrets for new assets.

  CREATE TABLE IF NOT EXISTS delegations (
    username       TEXT    PRIMARY KEY,
    wallet_address TEXT    NOT NULL,
    signature      TEXT    NOT NULL,
    valid_until    INTEGER NOT NULL,
    created_at     INTEGER DEFAULT (unixepoch())
  );

  -- ── Indexes ───────────────────────────────────────────────────────────────

  CREATE INDEX IF NOT EXISTS idx_sessions_jti                  ON sessions(jti);
  CREATE INDEX IF NOT EXISTS idx_sessions_address              ON sessions(address);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires              ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_assets_ip_id                  ON assets(ip_id);
  CREATE INDEX IF NOT EXISTS idx_assets_owner                  ON assets(owner);
  CREATE INDEX IF NOT EXISTS idx_assets_tier                   ON assets(tier);
  CREATE INDEX IF NOT EXISTS idx_licenses_holder               ON licenses(holder_address);
  CREATE INDEX IF NOT EXISTS idx_licenses_licensor             ON licenses(licensor_ip_id);
  CREATE INDEX IF NOT EXISTS idx_platform_identities_username  ON platform_identities(username);
  CREATE INDEX IF NOT EXISTS idx_fingerprints_sha256           ON asset_fingerprints(sha256);
  CREATE INDEX IF NOT EXISTS idx_fingerprints_phash            ON asset_fingerprints(phash);
  CREATE INDEX IF NOT EXISTS idx_fingerprints_owner            ON asset_fingerprints(owner);
  CREATE INDEX IF NOT EXISTS idx_pending_shares_target         ON pending_shares(target_username);
  CREATE INDEX IF NOT EXISTS idx_access_tokens_expires         ON access_tokens(expires_at);
  CREATE INDEX IF NOT EXISTS idx_delegations_valid_until       ON delegations(valid_until);
`;

const MIGRATIONS = [
  `ALTER TABLE wallets ADD COLUMN privy_wallet_id TEXT`,
  `ALTER TABLE assets ADD COLUMN license_terms_id TEXT`,
  `ALTER TABLE asset_fingerprints ADD COLUMN audio_hash TEXT`,
  `ALTER TABLE asset_fingerprints ADD COLUMN video_hash TEXT`,
];

let _db: BetterSqlite3.Database | null = null;

export function getDB(): BetterSqlite3.Database {
  if (_db) return _db;

  const dbPath = process.env.DB_PATH || "./nexar.db";
  const dir    = dbPath.substring(0, dbPath.lastIndexOf("/"));
  if (dir) mkdirSync(dir, { recursive: true });

  log.info("Opening SQLite database...", { path: dbPath });

  _db = new BetterSqlite3(dbPath, {
    verbose: process.env.LOG_LEVEL === "debug" ? (sql) => log.debug(sql as string) : undefined,
  });

  _db.exec(SCHEMA);

  for (const migration of MIGRATIONS) {
    try { _db.exec(migration); } catch { /* already exists */ }
  }

  const cleaned = _db.prepare(
    "DELETE FROM sessions WHERE expires_at < ? AND revoked = 0"
  ).run(Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60);

  _db.prepare("DELETE FROM access_tokens WHERE expires_at < ?")
     .run(Math.floor(Date.now() / 1000));

  _db.prepare("DELETE FROM delegations WHERE valid_until < ?")
     .run(Math.floor(Date.now() / 1000));

  log.success("Database ready", { path: dbPath, cleaned: `${cleaned.changes} expired sessions` });
  return _db;
}

export function closeDB(): void {
  if (_db) { _db.close(); _db = null; log.info("Database closed"); }
}

export type WalletRow            = { id: number; label: string; address: string; encrypted_pk: string | null; privy_wallet_id: string | null; created_at: number; };
export type SessionRow           = { id: number; jti: string; address: string; vault_uuid: string | null; ip_id: string | null; role: string; expires_at: number; revoked: number; created_at: number; };
export type SpendRow             = { id: number; address: string; total_reads: number; last_read: number; };
export type AssetRow             = { id: number; asset_id: string | null; ip_id: string; vault_uuid: string; vault_cid: string | null; tier: number; owner: string; name: string; asset_type: string; license_terms_id: string | null; active: number; created_at: number; };
export type LicenseRow           = { id: number; license_token_id: string; licensor_ip_id: string; license_terms_id: string; holder_address: string; minted_at: number; tx_hash: string | null; };
export type UsernameRow          = { username: string; privy_wallet_id: string; created_at: number; };
export type PlatformIdentityRow  = { id: number; username: string; platform: string; platform_id: string; verified: number; linked_at: number; };
export type ConversationStateRow = { platform: string; platform_id: string; state: string; context: string; updated_at: number; };
export type FingerprintRow       = { ip_id: string; owner: string; asset_name: string; sha256: string; phash: string | null; audio_hash: string | null; video_hash: string | null; fingerprints: string | null; file_type: string; mime_type: string | null; created_at: number; };
export type PendingShareRow      = { id: number; ip_id: string; vault_uuid: string; owner_username: string; asset_name: string; target_username: string; created_at: number; };
export type AccessTokenRow       = { token: string; vault_uuid: string; ip_id: string; owner_username: string; asset_name: string; single_use: number; uses_remaining: number | null; expires_at: number; created_at: number; };
export type DelegationRow        = { username: string; wallet_address: string; signature: string; valid_until: number; created_at: number; };
