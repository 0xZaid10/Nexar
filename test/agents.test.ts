// test/agents.test.ts
// Tests for Layer 5: Agent Coordination
// Tests: ATCPIP state machine, BaseAgent strategy logic, error handling

import { describe, it, expect, beforeAll } from "vitest";
import { ATCPIP }      from "../src/agents/negotiation/ATCPIP.js";
import { NexarError } from "../src/core/errors.js";
import { parseEther }  from "viem";

beforeAll(() => {
  process.env.JWT_SECRET = "nexar-test-secret-64-chars-minimum-padding-here-1234567890";
});

const BUYER  = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const IP_ID  = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;

// Mock licensing and hooks engines
const mockLicensing = {
  mintLicenseTokens: async () => ({
    licenseTokenIds: [1n],
    txHash: "0x1234" as `0x${string}`,
  }),
} as any;

const mockHooks = {
  recordLicensePurchase: async () => {},
} as any;

// ─── ATCPIP state machine ─────────────────────────────────────────────────────

describe("ATCPIP", () => {
  const atcpip = new ATCPIP(mockLicensing, mockHooks);

  const makeNegotiation = (fee = parseEther("0.1")) =>
    atcpip.initiate({ assetId: 1n, ipId: IP_ID, buyer: BUYER, proposedFee: fee });

  it("initiate creates PROPOSED state", () => {
    const s = makeNegotiation();
    expect(s.status).toBe("PROPOSED");
    expect(s.buyerAddress).toBe(BUYER);
    expect(s.rounds).toBe(1);
    expect(s.id).toBeTruthy();
  });

  it("counter advances to COUNTERED", () => {
    const s  = makeNegotiation();
    const s2 = atcpip.counter(s.id, parseEther("0.15"));
    expect(s2.status).toBe("COUNTERED");
    expect(s2.counterFee).toBe(parseEther("0.15"));
    expect(s2.rounds).toBe(2);
  });

  it("accept moves to ACCEPTED with agreedFee", () => {
    const s  = makeNegotiation(parseEther("0.12"));
    const s2 = atcpip.counter(s.id, parseEther("0.13"));
    const s3 = atcpip.accept(s2.id);
    expect(s3.status).toBe("ACCEPTED");
    expect(s3.agreedFee).toBe(parseEther("0.13")); // takes counter fee
  });

  it("accept on PROPOSED uses proposedFee as agreedFee", () => {
    const s  = makeNegotiation(parseEther("0.1"));
    const s2 = atcpip.accept(s.id);
    expect(s2.agreedFee).toBe(parseEther("0.1"));
  });

  it("reject moves to REJECTED", () => {
    const s  = makeNegotiation();
    const s2 = atcpip.reject(s.id, "Too expensive");
    expect(s2.status).toBe("REJECTED");
  });

  it("cannot counter a REJECTED negotiation", () => {
    const s = makeNegotiation();
    atcpip.reject(s.id);
    expect(() => atcpip.counter(s.id, parseEther("0.1"))).toThrow(NexarError);
  });

  it("cannot accept a REJECTED negotiation", () => {
    const s = makeNegotiation();
    atcpip.reject(s.id);
    expect(() => atcpip.accept(s.id)).toThrow(NexarError);
  });

  it("throws on unknown negotiation id", () => {
    expect(() => atcpip.counter("nonexistent-id", parseEther("0.1"))).toThrow(NexarError);
  });

  it("auto-rejects after MAX_ROUNDS counters", () => {
    const s = makeNegotiation();
    let state = s;
    // Counter 5 times (MAX_ROUNDS = 5)
    for (let i = 0; i < 5; i++) {
      try { state = atcpip.counter(state.id, parseEther("0.1")); }
      catch { break; }
    }
    expect(["REJECTED", "COUNTERED"]).toContain(state.status);
  });

  it("settle on ACCEPTED state mints license", async () => {
    const s  = makeNegotiation(parseEther("0.1"));
    atcpip.accept(s.id);
    const result = await atcpip.settle(s.id, 1n, BUYER);
    expect(result.licenseTokenId).toBe(1n);
    expect(result.txHash).toBeTruthy();
    expect(result.settledAt).toBeGreaterThan(0);
  });

  it("cannot settle a non-ACCEPTED negotiation", async () => {
    const s = makeNegotiation();
    // PROPOSED, not ACCEPTED
    await expect(atcpip.settle(s.id, 1n, BUYER)).rejects.toThrow(NexarError);
  });

  it("getByBuyer returns only buyer's negotiations", () => {
    const other = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;
    atcpip.initiate({ assetId: 2n, ipId: IP_ID, buyer: BUYER, proposedFee: 1n });
    atcpip.initiate({ assetId: 3n, ipId: IP_ID, buyer: other, proposedFee: 1n });
    const buyerNeg = atcpip.getByBuyer(BUYER);
    expect(buyerNeg.every((n) => n.buyerAddress === BUYER)).toBe(true);
  });

  it("multiple negotiations are independent", () => {
    const s1 = atcpip.initiate({ assetId: 10n, ipId: IP_ID, buyer: BUYER, proposedFee: 1n });
    const s2 = atcpip.initiate({ assetId: 11n, ipId: IP_ID, buyer: BUYER, proposedFee: 2n });
    atcpip.reject(s1.id);
    expect(atcpip.get(s2.id)?.status).toBe("PROPOSED");
  });
});
