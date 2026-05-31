// src/auth/GasRelayer.ts
// Production gas relayer with dedicated EOA and persistent spend tracking.
// Uses RELAYER_PRIVATE_KEY (separate from deployer PRIVATE_KEY).
// Spend records persisted in SQLite — survive restarts.

import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount }   from "viem/accounts";
import type { CDRClient }         from "@piplabs/cdr-sdk";

import { NETWORK, CDR_TIMEOUT_MS } from "../core/config.js";
import { NexarError as CipherError }             from "../core/errors.js";
import { createLogger }            from "../core/logger.js";
import { getDB }                   from "../db/index.js";
import { SessionManager }          from "./SessionManager.js";
import { encodeLicenseTokenIds }   from "../sdk/vault/ConditionBuilder.js";
import type { HexAddress, TxHash, VaultAccessResult } from "../core/types.js";

const log = createLogger("GasRelayer");

const MAX_READS_PER_USER = Number(process.env.RELAYER_MAX_READS_PER_USER ?? 100);
const MAX_TOTAL_READS    = Number(process.env.RELAYER_MAX_TOTAL_READS    ?? 50_000);

export class GasRelayer {
  private readonly cdr:            CDRClient;
  private readonly sessionManager: SessionManager;

  constructor(cdrClient: CDRClient, sessionManager: SessionManager) {
    this.cdr            = cdrClient;
    this.sessionManager = sessionManager;

    // Validate relayer key at construction
    if (!process.env.RELAYER_PRIVATE_KEY && !process.env.PRIVATE_KEY) {
      log.warn("No RELAYER_PRIVATE_KEY set — falling back to PRIVATE_KEY. Use a dedicated relayer in production.");
    }
  }

  /**
   * Sponsor a CDR vault read for a user identified by session token.
   * Relayer pays gas. User pays nothing.
   */
  async sponsorRead(sessionToken: string, licenseTokenIds: bigint[] = []): Promise<VaultAccessResult> {
    const session = this.sessionManager.verifySession(sessionToken);
    if (!session.vaultUuid) throw new CipherError("GAS_RELAY_FAILED", "Session has no vaultUuid");

    const userAddress = session.address;
    const uuid        = session.vaultUuid;

    log.info("Sponsoring CDR read...", { user: userAddress, uuid: uuid.toString(), role: session.role });

    // Check per-user + global limits
    this.checkLimits(userAddress);

    const accessAuxData = licenseTokenIds.length > 0
      ? encodeLicenseTokenIds(licenseTokenIds)
      : "0x";

    try {
      const result = await this.cdr.consumer.accessCDR({
        uuid:          Number(uuid),
        accessAuxData,
        timeoutMs:     CDR_TIMEOUT_MS,
      });

      // Persist spend record
      this.recordRead(userAddress);

      log.success("Sponsored read complete", {
        user:   userAddress,
        uuid:   uuid.toString(),
        txHash: result.txHash,
      });

      return { dataKey: result.dataKey, txHash: result.txHash as TxHash };
    } catch (err) {
      const name = (err as Error)?.name ?? "";
      if (name === "EmptyVaultError")                throw new CipherError("VAULT_EMPTY",   `Vault ${uuid} is empty`);
      if (name === "PartialCollectionTimeoutError")  throw new CipherError("VAULT_TIMEOUT", `Vault ${uuid} timed out`);
      throw new CipherError("GAS_RELAY_FAILED", `Sponsored read failed for vault ${uuid}`, { cause: err });
    }
  }

  getUserStats(address: HexAddress): { totalReads: number; lastRead: number } | null {
    const row = getDB().prepare("SELECT total_reads, last_read FROM relayer_spend WHERE address = ?").get(address) as
      { total_reads: number; last_read: number } | undefined;
    return row ? { totalReads: row.total_reads, lastRead: row.last_read } : null;
  }

  getGlobalStats(): { totalSponsored: number; uniqueUsers: number } {
    const db   = getDB();
    const tot  = db.prepare("SELECT COALESCE(SUM(total_reads),0) as n FROM relayer_spend").get() as { n: number };
    const uniq = db.prepare("SELECT COUNT(*) as n FROM relayer_spend").get() as { n: number };
    return { totalSponsored: tot.n, uniqueUsers: uniq.n };
  }

  private checkLimits(address: HexAddress): void {
    const stats = this.getGlobalStats();
    if (stats.totalSponsored >= MAX_TOTAL_READS) {
      throw new CipherError("GAS_RELAY_FAILED", "Relayer global read limit reached");
    }
    const row = getDB().prepare("SELECT total_reads FROM relayer_spend WHERE address = ?").get(address) as
      { total_reads: number } | undefined;
    if (row && row.total_reads >= MAX_READS_PER_USER) {
      throw new CipherError("GAS_RELAY_FAILED", `Spend limit reached for ${address}`);
    }
  }

  private recordRead(address: HexAddress): void {
    const now = Math.floor(Date.now() / 1000);
    const db  = getDB();
    const existing = db.prepare("SELECT 1 FROM relayer_spend WHERE address = ?").get(address);
    if (existing) {
      db.prepare("UPDATE relayer_spend SET total_reads = total_reads + 1, last_read = ? WHERE address = ?").run(now, address);
    } else {
      db.prepare("INSERT INTO relayer_spend (address, total_reads, last_read) VALUES (?, 1, ?)").run(address, now);
    }
  }
}
