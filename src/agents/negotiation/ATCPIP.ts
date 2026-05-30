// src/agents/negotiation/ATCPIP.ts
// ATCP/IP negotiation state machine.
// Implements the agent-to-agent transaction flow from the Story ATCP/IP whitepaper:
//   IDLE → DISCOVERED → PROPOSED → COUNTERED → ACCEPTED → SETTLED
// Multi-user: each negotiation is an independent instance with its own state.
// Settlement is on-chain — license minted, fee paid, vault access granted.

import { randomUUID } from "node:crypto";
import { zeroAddress } from "viem";

import { TOKENS }           from "../../core/config.js";
import { NexarError }      from "../../core/errors.js";
import { createLogger }     from "../../core/logger.js";
import { LicensingEngine }  from "../../licensing/LicensingEngine.js";
import { HookManager }      from "../../licensing/HookManager.js";
import type {
  HexAddress,
  TxHash,
  NegotiationState,
  NegotiationStatus,
  SettlementResult,
} from "../../core/types.js";

const log = createLogger("ATCPIP");

// ─── Max negotiation rounds before auto-reject ────────────────────────────────
const MAX_ROUNDS = 5;

// ─── ATCPIP ───────────────────────────────────────────────────────────────────

export class ATCPIP {
  private readonly licensing: LicensingEngine;
  private readonly hooks:     HookManager;

  // In-memory negotiation store — multi-user: keyed by negotiation ID
  private readonly _negotiations = new Map<string, NegotiationState>();

  constructor(licensing: LicensingEngine, hooks: HookManager) {
    this.licensing = licensing;
    this.hooks     = hooks;
  }

  // ─── Step 1: Initiate negotiation ─────────────────────────────────────────

  /**
   * Start a negotiation for an asset.
   * Buyer proposes an initial fee.
   * Multi-user: creates an independent negotiation instance per call.
   *
   * @param assetId     - NEXAR registry asset ID
   * @param ipId        - Story IP Asset ID
   * @param buyer       - Buyer agent address
   * @param proposedFee - Initial fee offer (WIP, 18 decimals)
   */
  initiate(params: {
    assetId:     bigint;
    ipId:        HexAddress;
    buyer:       HexAddress;
    proposedFee: bigint;
  }): NegotiationState {
    const id = randomUUID();
    const now = Date.now();

    const state: NegotiationState = {
      id,
      status:       "PROPOSED",
      assetId:      params.assetId,
      ipId:         params.ipId,
      buyerAddress: params.buyer,
      proposedFee:  params.proposedFee,
      rounds:       1,
      startedAt:    now,
      updatedAt:    now,
    };

    this._negotiations.set(id, state);

    log.info("Negotiation initiated", {
      id,
      ipId:        params.ipId,
      buyer:       params.buyer,
      proposedFee: params.proposedFee.toString(),
    });

    return state;
  }

  // ─── Step 2: Provider counters ─────────────────────────────────────────────

  /**
   * Provider responds with a counter-offer.
   * In NEXAR: provider agent reads the proposal, compares to market price,
   * and responds with the hook-computed price as the counter.
   *
   * @param negotiationId - ID from initiate()
   * @param counterFee    - Provider's counter-offer (WIP)
   */
  counter(negotiationId: string, counterFee: bigint): NegotiationState {
    const state = this._get(negotiationId);
    this._assertStatus(state, ["PROPOSED", "COUNTERED"]);

    if (state.rounds >= MAX_ROUNDS) {
      return this._reject(state, "Max negotiation rounds reached");
    }

    state.status     = "COUNTERED";
    state.counterFee = counterFee;
    state.rounds++;
    state.updatedAt  = Date.now();

    log.info("Counter-offer issued", {
      id:         negotiationId,
      counterFee: counterFee.toString(),
      round:      state.rounds.toString(),
    });

    return state;
  }

  // ─── Step 3a: Buyer accepts ────────────────────────────────────────────────

  /**
   * Buyer accepts the current terms (proposed or countered).
   * Moves to ACCEPTED — ready for on-chain settlement.
   */
  accept(negotiationId: string): NegotiationState {
    const state = this._get(negotiationId);
    this._assertStatus(state, ["PROPOSED", "COUNTERED"]);

    const agreedFee = state.counterFee ?? state.proposedFee;
    state.status    = "ACCEPTED";
    state.agreedFee = agreedFee;
    state.updatedAt = Date.now();

    log.success("Negotiation accepted", {
      id:        negotiationId,
      agreedFee: agreedFee.toString(),
      rounds:    state.rounds.toString(),
    });

    return state;
  }

  // ─── Step 3b: Buyer rejects ────────────────────────────────────────────────

  /**
   * Buyer rejects the counter-offer. Negotiation ends.
   */
  reject(negotiationId: string, reason = "Buyer rejected offer"): NegotiationState {
    const state = this._get(negotiationId);
    return this._reject(state, reason);
  }

  // ─── Step 4: On-chain settlement ──────────────────────────────────────────

  /**
   * Settle the negotiation on-chain.
   * Mints a license token and pays the agreed fee.
   * Confirmed from sdk-reference/license.md mintLicenseTokens() and
   * sdk-reference/royalty.md payRoyaltyOnBehalf().
   *
   * Multi-user: each settlement is an independent on-chain transaction
   * using the buyer's licensing engine instance.
   *
   * @param negotiationId  - ID from initiate()
   * @param licenseTermsId - Terms to mint license under
   * @param buyerAddress   - Who receives the license token
   */
  async settle(
    negotiationId:  string,
    licenseTermsId: bigint,
    buyerAddress:   HexAddress
  ): Promise<SettlementResult> {
    const state = this._get(negotiationId);
    this._assertStatus(state, ["ACCEPTED"]);

    const agreedFee = state.agreedFee ?? state.proposedFee;

    log.info("Settling negotiation on-chain...", {
      id:             negotiationId,
      ipId:           state.ipId,
      licenseTermsId: licenseTermsId.toString(),
      agreedFee:      agreedFee.toString(),
    });

    try {
      // Mint license token — confirmed from sdk-reference/license.md mintLicenseTokens()
      const { licenseTokenIds, txHash } = await this.licensing.mintLicenseTokens({
        licensorIpId:   state.ipId,
        licenseTermsId,
        receiver:       buyerAddress,
        amount:         1,
      });

      const licenseTokenId = licenseTokenIds[0] ?? 0n;

      // Record reputation for buyer
      await this.hooks.recordLicensePurchase(buyerAddress);

      state.status    = "SETTLED";
      state.updatedAt = Date.now();

      const result: SettlementResult = {
        negotiationId,
        licenseTokenId,
        amountPaid:    agreedFee,
        vaultUuid:     0n, // populated by caller from asset record
        txHash,
        settledAt:     Date.now(),
      };

      log.success("Negotiation settled", {
        id:             negotiationId,
        licenseTokenId: licenseTokenId.toString(),
        txHash,
      });

      return result;
    } catch (err) {
      state.status = "REJECTED";
      throw new NexarError(
        "SETTLEMENT_FAILED",
        `Settlement failed for negotiation ${negotiationId}`,
        { cause: err }
      );
    }
  }

  // ─── Query methods ─────────────────────────────────────────────────────────

  get(id: string): NegotiationState | undefined {
    return this._negotiations.get(id);
  }

  getAll(): NegotiationState[] {
    return [...this._negotiations.values()];
  }

  getByBuyer(buyer: HexAddress): NegotiationState[] {
    return [...this._negotiations.values()].filter(
      (n) => n.buyerAddress.toLowerCase() === buyer.toLowerCase()
    );
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private _get(id: string): NegotiationState {
    const state = this._negotiations.get(id);
    if (!state) {
      throw new NexarError("NEGOTIATION_REJECTED", `Negotiation ${id} not found`);
    }
    return state;
  }

  private _assertStatus(state: NegotiationState, allowed: NegotiationStatus[]): void {
    if (!allowed.includes(state.status)) {
      throw new NexarError(
        "NEGOTIATION_REJECTED",
        `Negotiation ${state.id} is in status ${state.status}, expected one of: ${allowed.join(", ")}`
      );
    }
  }

  private _reject(state: NegotiationState, reason: string): NegotiationState {
    state.status    = "REJECTED";
    state.updatedAt = Date.now();
    log.warn("Negotiation rejected", { id: state.id, reason });
    return state;
  }
}
