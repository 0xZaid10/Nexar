// src/auth/WalletManager.ts
// Per-user wallet management via Privy Wallets API (server-side MPC).
// Private keys NEVER touch our server — all signing delegated to Privy.
// Falls back to encrypted SQLite if PRIVY_APP_ID not configured (dev mode).
//
// Privy Wallets API docs: https://docs.privy.io/guide/server/wallets/creation

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { privateKeyToAccount, generatePrivateKey }                   from "viem/accounts";
import { createWalletClient, http }                           from "viem";
import { privateKeyToAccount, generatePrivateKey, toAccount } from "viem/accounts";
import type { Account, WalletClient, Address, Hex }                  from "viem";
import { serializeTransaction }                                       from "viem";

import { NETWORK }       from "../core/config.js";
import { NexarError as CipherError }   from "../core/errors.js";
import { createLogger }  from "../core/logger.js";
import { getDB }         from "../db/index.js";
import type { HexAddress, WalletRecord } from "../core/types.js";

const log = createLogger("WalletManager");

// ─── Privy API helpers ────────────────────────────────────────────────────────

const PRIVY_BASE = "https://api.privy.io/v1";

function privyHeaders(): HeadersInit {
  const appId     = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  if (!appId || !appSecret) throw new CipherError("MISSING_ENV", "PRIVY_APP_ID or PRIVY_APP_SECRET not set");

  const credentials = Buffer.from(`${appId}:${appSecret}`).toString("base64");
  return {
    "Authorization": `Basic ${credentials}`,
    "privy-app-id":  appId,
    "Content-Type":  "application/json",
  };
}

function isPrivyConfigured(): boolean {
  return !!(process.env.PRIVY_APP_ID && process.env.PRIVY_APP_SECRET);
}

// ─── Privy wallet creation ────────────────────────────────────────────────────

async function createPrivyWallet(): Promise<{ id: string; address: string }> {
  const res = await fetch(`${PRIVY_BASE}/wallets`, {
    method:  "POST",
    headers: privyHeaders(),
    body:    JSON.stringify({ chain_type: "ethereum" }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Privy wallet creation failed ${res.status}: ${err}`);
  }

  const data = await res.json() as { id: string; address: string };
  return { id: data.id, address: data.address };
}

// ─── Privy signing ────────────────────────────────────────────────────────────

// Lazy-loaded Privy server client
let _privyClient: any = null;
function getPrivyClient() {
  if (_privyClient) return _privyClient;
  const { PrivyClient } = require("@privy-io/server-auth");
  _privyClient = new PrivyClient(
    process.env.PRIVY_APP_ID!,
    process.env.PRIVY_APP_SECRET!,
  );
  return _privyClient;
}

async function privyRPC(walletId: string, method: string, params: unknown): Promise<string> {
  // caip2 must be at ROOT level of request body, not inside params
  const p = params as any;
  const caip2 = p?.caip2 ?? (method === "eth_sendTransaction" ? "eip155:1315" : undefined);
  const cleanParams = (caip2 && p?.caip2)
    ? (({ caip2: _, ...rest }) => rest)(p)
    : params;

  const body: Record<string, unknown> = { method, params: cleanParams };
  if (caip2) body.caip2 = caip2;

  const res = await fetch(`${PRIVY_BASE}/wallets/${walletId}/rpc`, {
    method:  "POST",
    headers: privyHeaders(),
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Privy RPC ${method} failed ${res.status}: ${errText}`);
  }
  const data = await res.json() as { data?: { signature?: string; signedTransaction?: string; hash?: string } };
  return data.data?.hash ?? data.data?.signature ?? data.data?.signedTransaction ?? "";
}

// ─── Build a viem-compatible Account backed by Privy signing ─────────────────

function buildPrivyAccount(walletId: string, address: Address): Account {
  return toAccount({
    address,

    async signMessage({ message }): Promise<Hex> {
      const msg = typeof message === "string" ? message : Buffer.from(message.raw).toString("hex");
      const sig = await privyRPC(walletId, "personal_sign", {
        message:  msg,
        encoding: "utf-8",
      });
      return sig as Hex;
    },

    async signTransaction(tx): Promise<Hex> {
      // Privy server wallets: use eth_sendTransaction (sign + broadcast atomically)
      // Strip fields Privy doesn't accept in transaction object
      const { chainId, gas, maxFeePerGas, maxPriorityFeePerGas, nonce, type, ...txFields } = tx as any;
      const cleanTx: Record<string, unknown> = {};
      if (txFields.to)    cleanTx.to    = txFields.to;
      if (txFields.data)  cleanTx.data  = txFields.data;
      if (txFields.value !== undefined) cleanTx.value = typeof txFields.value === "bigint"
        ? `0x${txFields.value.toString(16)}` : txFields.value ?? "0x0";

      const hash = await privyRPC(walletId, "eth_sendTransaction", {
        transaction: cleanTx,
        caip2: "eip155:1315",
      });
      // Return hash — viem's writeContract detects already-broadcast tx
      return (hash || "0x") as Hex;
    },

    async signTypedData(typedData): Promise<Hex> {
      const sig = await privyRPC(walletId, "eth_signTypedData_v4", { typedData });
      return sig as Hex;
    },
  });
}

// ─── Fallback: encrypted SQLite (dev mode, no Privy) ─────────────────────────

const ALGO     = "aes-256-gcm";
const IV_LEN   = 12;
const TAG_LEN  = 16;
const SALT_LEN = 32;

function deriveKey(salt: Buffer): Buffer {
  return scryptSync(process.env.JWT_SECRET ?? "nexar-dev-secret", salt, 32) as Buffer;
}

function encryptPK(pk: string): string {
  const salt = randomBytes(SALT_LEN);
  const key  = deriveKey(salt);
  const iv   = randomBytes(IV_LEN);
  const c    = createCipheriv(ALGO, key, iv);
  const enc  = Buffer.concat([c.update(pk, "utf8"), c.final()]);
  const tag  = c.getAuthTag();
  return Buffer.concat([salt, iv, tag, enc]).toString("base64");
}

function decryptPK(b64: string): string {
  const buf  = Buffer.from(b64, "base64");
  const salt = buf.subarray(0, SALT_LEN);
  const iv   = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const tag  = buf.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
  const ct   = buf.subarray(SALT_LEN + IV_LEN + TAG_LEN);
  const key  = deriveKey(salt);
  const d    = createDecipheriv(ALGO, key, iv);
  d.setAuthTag(tag);
  return d.update(ct) + d.final("utf8");
}

// ─── WalletManager ────────────────────────────────────────────────────────────

export class WalletManager {

  /**
   * Create a wallet for a user.
   *
   * With Privy configured:
   *   → Creates wallet via Privy MPC API
   *   → Stores privy_wallet_id + address in SQLite (NO private key)
   *   → Private key held by Privy's MPC infrastructure
   *
   * Without Privy (dev mode):
   *   → Generates keypair locally
   *   → Stores AES-encrypted private key in SQLite
   */
  async createWallet(label: string): Promise<WalletRecord> {
    const db = getDB();

    // Return existing
    const existing = db.prepare(
      "SELECT label, address, encrypted_pk, privy_wallet_id FROM wallets WHERE label = ?"
    ).get(label) as { label:string; address:string; encrypted_pk:string|null; privy_wallet_id:string|null } | undefined;

    if (existing) {
      log.debug("Returning existing wallet", { label, mode: existing.privy_wallet_id ? "privy" : "local" });
      return {
        address:             existing.address as HexAddress,
        encryptedPrivateKey: existing.encrypted_pk ?? "",
        createdAt:           Date.now(),
        label,
      };
    }

    if (isPrivyConfigured()) {
      return this._createPrivyWallet(label);
    } else {
      log.warn("PRIVY_APP_ID not set — using local encrypted wallet (dev mode). Set Privy credentials for production.");
      return this._createLocalWallet(label);
    }
  }

  private async _createPrivyWallet(label: string): Promise<WalletRecord> {
    log.info("Creating Privy MPC wallet...", { label });
    try {
      const { id, address } = await createPrivyWallet();
      const db = getDB();
      db.prepare(
        "INSERT INTO wallets (label, address, encrypted_pk, privy_wallet_id) VALUES (?, ?, ?, ?)"
      ).run(label, address, null, id);

      log.success("Privy wallet created — private key held by Privy MPC", { label, address });
      return { address: address as HexAddress, encryptedPrivateKey: "", createdAt: Date.now(), label };
    } catch (err) {
      throw new CipherError("WALLET_CREATE_FAILED", `Privy wallet creation failed for ${label}`, { cause: err });
    }
  }

  private async _createLocalWallet(label: string): Promise<WalletRecord> {
    try {
      const privateKey          = generatePrivateKey();
      const account             = privateKeyToAccount(privateKey);
      const encryptedPrivateKey = encryptPK(privateKey);
      const db = getDB();
      db.prepare(
        "INSERT INTO wallets (label, address, encrypted_pk, privy_wallet_id) VALUES (?, ?, ?, ?)"
      ).run(label, account.address, encryptedPrivateKey, null);

      log.success("Local wallet created (encrypted)", { label, address: account.address });
      return { address: account.address as HexAddress, encryptedPrivateKey, createdAt: Date.now(), label };
    } catch (err) {
      throw new CipherError("WALLET_CREATE_FAILED", `Failed to create wallet for ${label}`, { cause: err });
    }
  }

  /**
   * Get the viem Account for a user.
   *
   * Privy mode: returns a custom Account that signs via Privy RPC.
   *   → Private key NEVER on our server.
   * Local mode: decrypts private key from SQLite, constructs Account.
   *   → Key decrypted in memory only, not cached.
   */
  async getAccount(label: string): Promise<Account> {
    const db  = getDB();
    const row = db.prepare(
      "SELECT address, encrypted_pk, privy_wallet_id FROM wallets WHERE label = ?"
    ).get(label) as { address:string; encrypted_pk:string|null; privy_wallet_id:string|null } | undefined;

    if (!row) throw new CipherError("WALLET_CREATE_FAILED", `No wallet found for: ${label}`);

    if (row.privy_wallet_id) {
      log.debug("Using Privy MPC signing", { label });
      return buildPrivyAccount(row.privy_wallet_id, row.address as Address);
    }

    // Local fallback
    if (!row.encrypted_pk) throw new CipherError("WALLET_SIGN_FAILED", `No key found for: ${label}`);
    try {
      const pk = decryptPK(row.encrypted_pk);
      return privateKeyToAccount(pk as `0x${string}`);
    } catch (err) {
      throw new CipherError("WALLET_SIGN_FAILED", `Failed to decrypt wallet for ${label}`, { cause: err });
    }
  }

  async getWallet(label: string): Promise<WalletRecord> {
    const db  = getDB();
    const row = db.prepare(
      "SELECT label, address, encrypted_pk, created_at FROM wallets WHERE label = ?"
    ).get(label) as { label:string; address:string; encrypted_pk:string|null; created_at:number } | undefined;
    if (!row) throw new CipherError("WALLET_CREATE_FAILED", `No wallet found for: ${label}`);
    return { address: row.address as HexAddress, encryptedPrivateKey: row.encrypted_pk ?? "", createdAt: row.created_at * 1000, label: row.label };
  }

  hasWallet(label: string): boolean {
    return !!getDB().prepare("SELECT 1 FROM wallets WHERE label = ?").get(label);
  }

  async getAddress(label: string): Promise<HexAddress> {
    return (await this.getWallet(label)).address;
  }

  async getWalletClient(label: string): Promise<WalletClient> {
    const account = await this.getAccount(label);
    return createWalletClient({ account, transport: http(NETWORK.rpc) });
  }

  /**
   * Export private key (local mode only — Privy wallets cannot be exported server-side).
   * Use Privy dashboard for user-facing key export.
   */
  async exportPrivateKey(label: string): Promise<string | null> {
    const db  = getDB();
    const row = db.prepare(
      "SELECT encrypted_pk, privy_wallet_id FROM wallets WHERE label = ?"
    ).get(label) as { encrypted_pk:string|null; privy_wallet_id:string|null } | undefined;

    if (!row) throw new CipherError("WALLET_CREATE_FAILED", `No wallet for: ${label}`);
    if (row.privy_wallet_id) {
      log.info("Privy wallet — key export not available server-side. User can export via Privy dashboard.");
      return null;
    }
    if (!row.encrypted_pk) return null;
    return decryptPK(row.encrypted_pk);
  }

  isPrivyWallet(label: string): boolean {
    const row = getDB().prepare("SELECT privy_wallet_id FROM wallets WHERE label = ?").get(label) as
      { privy_wallet_id: string | null } | undefined;
    return !!(row?.privy_wallet_id);
  }

  /**
   * Store a user's Privy embedded wallet (from Mini App delegation).
   * walletId = Privy embedded wallet ID (starts with "did:privy:")
   * address  = wallet address from Mini App
   * This replaces any existing wallet for the user.
   */
  storeDelegatedWallet(label: string, walletId: string, address: string): void {
    const db = getDB();
    const existing = db.prepare("SELECT 1 FROM wallets WHERE label = ?").get(label);
    if (existing) {
      db.prepare("UPDATE wallets SET address = ?, privy_wallet_id = ?, encrypted_pk = NULL WHERE label = ?")
        .run(address, walletId, label);
      log.info("Updated wallet with delegation", { label, address });
    } else {
      db.prepare("INSERT INTO wallets (label, address, privy_wallet_id) VALUES (?, ?, ?)")
        .run(label, address, walletId);
      log.info("Stored delegated wallet", { label, address });
    }
  }

  listLabels(): string[] {
    return (getDB().prepare("SELECT label FROM wallets").all() as { label:string }[]).map((r) => r.label);
  }

  deleteWallet(label: string): boolean {
    return getDB().prepare("DELETE FROM wallets WHERE label = ?").run(label).changes > 0;
  }

  count(): number {
    return (getDB().prepare("SELECT COUNT(*) as n FROM wallets").get() as { n:number }).n;
  }
}
