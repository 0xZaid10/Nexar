// src/db/Database.ts
// SQLite database — persistent storage for wallets, sessions, spend records, assets.

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
    encrypted_pk     TEXT,                        -- null for Privy wallets
    privy_wallet_id  TEXT,                        -- Privy MPC wallet ID (null for local wallets)
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
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id     TEXT,
    ip_id        TEXT    NOT NULL UNIQUE,
    vault_uuid   TEXT    NOT NULL,
    vault_cid    TEXT,
    tier         INTEGER NOT NULL,
    owner        TEXT    NOT NULL,
    name         TEXT    NOT NULL,
    asset_type   TEXT    NOT NULL,
    active       INTEGER NOT NULL DEFAULT 1,
    created_at   INTEGER NOT NULL DEFAULT (unixepoch())
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

  CREATE INDEX IF NOT EXISTS idx_sessions_jti       ON sessions(jti);
  CREATE INDEX IF NOT EXISTS idx_sessions_address   ON sessions(address);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires   ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_assets_ip_id       ON assets(ip_id);
  CREATE INDEX IF NOT EXISTS idx_assets_owner       ON assets(owner);
  CREATE INDEX IF NOT EXISTS idx_assets_tier        ON assets(tier);
  CREATE INDEX IF NOT EXISTS idx_licenses_holder    ON licenses(holder_address);
  CREATE INDEX IF NOT EXISTS idx_licenses_licensor  ON licenses(licensor_ip_id);
`;

// Migration: add privy_wallet_id to existing databases
const MIGRATIONS = [
  `ALTER TABLE wallets ADD COLUMN privy_wallet_id TEXT`,
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

  // Run migrations (ignore errors if column already exists)
  for (const migration of MIGRATIONS) {
    try { _db.exec(migration); } catch { /* column already exists — ignore */ }
  }

  // Cleanup expired sessions older than 7 days
  const cleaned = _db.prepare(
    "DELETE FROM sessions WHERE expires_at < ? AND revoked = 0"
  ).run(Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60);

  log.success("Database ready", { path: dbPath, cleaned: `${cleaned.changes} expired sessions` });
  return _db;
}

export function closeDB(): void {
  if (_db) { _db.close(); _db = null; log.info("Database closed"); }
}

export type WalletRow = {
  id: number; label: string; address: string;
  encrypted_pk: string | null; privy_wallet_id: string | null; created_at: number;
};
export type SessionRow = {
  id: number; jti: string; address: string; vault_uuid: string | null;
  ip_id: string | null; role: string; expires_at: number; revoked: number; created_at: number;
};
export type SpendRow = { id: number; address: string; total_reads: number; last_read: number; };
export type AssetRow = {
  id: number; asset_id: string | null; ip_id: string; vault_uuid: string;
  vault_cid: string | null; tier: number; owner: string; name: string;
  asset_type: string; active: number; created_at: number;
};
export type LicenseRow = {
  id: number; license_token_id: string; licensor_ip_id: string;
  license_terms_id: string; holder_address: string; minted_at: number; tx_hash: string | null;
};
