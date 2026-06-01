// src/auth/GasRelayer.ts
// Production gas relayer — uses dedicated RELAYER_PRIVATE_KEY EOA.
// Separate from the operator PRIVATE_KEY so spend is isolated and trackable.
// Spend records persisted in SQLite — survive restarts.

import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount }    from "viem/accounts";
import { CDRClient, initWasm }    from "@piplabs/cdr-sdk";

import { NETWORK, CDR_API_URL, CDR_TIMEOUT_MS } from "../core/config.js";
import { NexarError as CipherError }            from "../core/errors.js";
import { createLogger }                         from "../core/logger.js";
import { getDB }                                from "../db/index.js";
import { SessionManager }                       from "./SessionManager.js";
import { encodeLicenseTokenIds }                from "../sdk/vault/ConditionBuilder.js";
import type { HexAddress, TxHash, VaultAccessResult } from "../core/types.js";

const log = createLogger("GasRelayer");

const MAX_READS_PER_USER = Number(process.env.RELAYER_MAX_READS_PER_USER ?? 100);
const MAX_TOTAL_READS    = Number(process.env.RELAYER_MAX_TOTAL_READS    ?? 50_000);

// ─── Relayer CDR client singleton ────────────────────────────────────────────

let _relayerCDR: CDRClient | null = null;

async function getRelayerCDR(): Promise<CDRClient> {
  if (_relayerCDR) return _relayerCDR;

  const relayerKey = process.env.RELAYER_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
  if (!relayerKey) throw new CipherError("MISSING_ENV", "RELAYER_PRIVATE_KEY not set");

  if (!process.env.RELAYER_PRIVATE_KEY) {
    log.warn("RELAYER_PRIVATE_KEY not set — falling back to PRIVATE_KEY. Set a dedicated relayer key in production.");
  }

  await initWasm();

  const pk           = relayerKey.replace(/^0x/, "") as `0x${string}`;
  const account      = privateKeyToAccount(`0x${pk}`);
  const publicClient = createPublicClient({ transport: http(NETWORK.rpc) });
  const walletClient = createWalletClient({ account, transport: http(NETWORK.rpc) });

  _relayerCDR = new CDRClient({
    network: "testnet",
    publicClient,
    walletClient,
    apiUrl:  CDR_API_URL,
  });

  log.success("Relayer CDR client initialized", { address: account.address });
  return _relayerCDR;
}

// ─── GasRelayer ───────────────────────────────────────────────────────────────

export class GasRelayer {
  private readonly sessionManager: SessionManager;

  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
  }

  /**
   * Sponsor a CDR vault read using the dedicated relayer wallet.
   * User pays zero gas — relayer EOA covers it.
   */
  async sponsorRead(
    sessionToken:    string,
    licenseTokenIds: bigint[] = []
  ): Promise<VaultAccessResult> {
    const session = this.sessionManager.verifySession(sessionToken);
    if (!session.vaultUuid) throw new CipherError("GAS_RELAY_FAILED", "Session has no vaultUuid");

    const userAddress = session.address;
    const uuid        = session.vaultUuid;

    log.info("Sponsoring CDR read...", { user: userAddress, uuid: uuid.toString() });

    this.checkLimits(userAddress);

    const cdr           = await getRelayerCDR();
    const accessAuxData = licenseTokenIds.length > 0
      ? encodeLicenseTokenIds(licenseTokenIds)
      : "0x";

    try {
      const result = await cdr.consumer.accessCDR({
        uuid:          Number(uuid),
        accessAuxData,
        timeoutMs:     CDR_TIMEOUT_MS,
      });

      this.recordRead(userAddress);

      log.success("Sponsored read complete", { user: userAddress, uuid: uuid.toString(), txHash: result.txHash });

      return { dataKey: result.dataKey, txHash: result.txHash as TxHash };
    } catch (err) {
      const name = (err as Error)?.name ?? "";
      if (name === "EmptyVaultError")               throw new CipherError("VAULT_EMPTY",   `Vault ${uuid} is empty`);
      if (name === "PartialCollectionTimeoutError") throw new CipherError("VAULT_TIMEOUT", `Vault ${uuid} timed out`);
      throw new CipherError("GAS_RELAY_FAILED", `Sponsored read failed for vault ${uuid}`, { cause: err });
    }
  }

  getRelayerAddress(): string {
    const key = process.env.RELAYER_PRIVATE_KEY ?? process.env.PRIVATE_KEY ?? "";
    try {
      return privateKeyToAccount(`0x${key.replace(/^0x/, "")}` as `0x${string}`).address;
    } catch { return "unknown"; }
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
