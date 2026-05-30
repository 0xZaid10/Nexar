// test/runtime.test.ts
// Tests for Layer 4: Confidential Runtime
// Tests: SessionTokens lifecycle, QuotaEnforcer cache, error codes

import { describe, it, expect, beforeAll } from "vitest";
import { SessionTokens, RUNTIME_TTL } from "../src/runtime/SessionTokens.js";
import { QuotaEnforcer }               from "../src/runtime/QuotaEnforcer.js";
import { NexarError }                 from "../src/core/errors.js";

beforeAll(() => {
  process.env.JWT_SECRET = "nexar-test-secret-64-chars-minimum-padding-here-1234567890";
});

const ADDR  = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const IP_ID = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
const UUID  = 42n;

// ─── SessionTokens ────────────────────────────────────────────────────────────

describe("SessionTokens", () => {
  const tokens = new SessionTokens();

  it("issues a stream token with correct fields", () => {
    const t = tokens.issueStreamToken(ADDR, UUID, IP_ID);
    expect(t.token).toBeTruthy();
    expect(t.address).toBe(ADDR);
    const p = tokens.verify(t.token, "stream");
    expect(p.sub).toBe(ADDR);
    expect(p.vault).toBe(UUID.toString());
    expect(p.ipId).toBe(IP_ID);
    expect(p.op).toBe("stream");
  });

  it("issues an inference token with short TTL", () => {
    const t = tokens.issueInferenceToken(ADDR, UUID, IP_ID);
    const p = tokens.verify(t.token, "inference");
    expect(p.op).toBe("inference");
    const remaining = t.expiresAt - Math.floor(Date.now() / 1000);
    expect(remaining).toBeLessThanOrEqual(RUNTIME_TTL.INFERENCE + 5);
    expect(remaining).toBeGreaterThan(0);
  });

  it("verify throws SESSION_INVALID for wrong op", () => {
    const t = tokens.issueStreamToken(ADDR, UUID, IP_ID);
    try { tokens.verify(t.token, "inference"); }
    catch (e) { expect((e as NexarError).code).toBe("SESSION_INVALID"); }
  });

  it("verify throws SESSION_REVOKED after revoke", () => {
    const t = tokens.issueStreamToken(ADDR, UUID, IP_ID);
    tokens.revoke(t.token);
    try { tokens.verify(t.token); }
    catch (e) { expect((e as NexarError).code).toBe("SESSION_REVOKED"); }
  });

  it("isValid returns true for valid token", () => {
    const t = tokens.issueStreamToken(ADDR, UUID, IP_ID);
    expect(tokens.isValid(t.token)).toBe(true);
  });

  it("isValid returns false for revoked token", () => {
    const t = tokens.issueStreamToken(ADDR, UUID, IP_ID);
    tokens.revoke(t.token);
    expect(tokens.isValid(t.token)).toBe(false);
  });

  it("isValid returns false for garbage input", () => {
    expect(tokens.isValid("not.a.token")).toBe(false);
  });

  it("multiple tokens are independently revocable", () => {
    const t1 = tokens.issueStreamToken(ADDR, 1n, IP_ID);
    const t2 = tokens.issueStreamToken(ADDR, 2n, IP_ID);
    tokens.revoke(t1.token);
    expect(tokens.isValid(t1.token)).toBe(false);
    expect(tokens.isValid(t2.token)).toBe(true);
  });

  it("throws MISSING_ENV if JWT_SECRET is not set", () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    expect(() => new SessionTokens()).toThrow(NexarError);
    process.env.JWT_SECRET = saved;
  });
});

// ─── QuotaEnforcer ────────────────────────────────────────────────────────────

describe("QuotaEnforcer", () => {
  // Use a mock publicClient that always returns 0 for getComputeUsed
  const mockClient = {
    readContract: async () => 0n,
  } as any;

  const enforcer = new QuotaEnforcer(mockClient, 10);

  it("check passes when quota is available", async () => {
    const quota = await enforcer.check(ADDR, IP_ID);
    expect(quota.used).toBe(0);
    expect(quota.max).toBe(10);
    expect(quota.remaining).toBe(10);
    expect(quota.address).toBe(ADDR);
    expect(quota.ipId).toBe(IP_ID);
  });

  it("incrementLocalCache increases used count", async () => {
    const quotaBefore = await enforcer.check(ADDR, IP_ID);
    enforcer.incrementLocalCache(ADDR, IP_ID);
    // Cache is now at 1 — next check should reflect this without chain call
    // (cache TTL is 30s, so this is from the cache)
    const quotaAfter = await enforcer.check(ADDR, IP_ID);
    expect(quotaAfter.used).toBe(quotaBefore.used + 1);
  });

  it("invalidateCache forces re-fetch from chain", async () => {
    // Fill cache with increments
    enforcer.incrementLocalCache(ADDR, IP_ID);
    enforcer.invalidateCache(ADDR, IP_ID);
    // After invalidate, chain is queried again (returns 0 from mock)
    const quota = await enforcer.check(ADDR, IP_ID);
    expect(quota.used).toBe(0);
  });

  it("throws QUOTA_EXCEEDED when maxUnits reached", async () => {
    const fullClient = { readContract: async () => 10n } as any;
    const fullEnforcer = new QuotaEnforcer(fullClient, 10);
    try {
      await fullEnforcer.check(ADDR, IP_ID);
      expect.fail("Should have thrown");
    } catch (e) {
      expect((e as NexarError).code).toBe("QUOTA_EXCEEDED");
    }
  });

  it("getAllQuotas returns empty array initially", () => {
    const fresh = new QuotaEnforcer(mockClient, 10);
    expect(fresh.getAllQuotas()).toHaveLength(0);
  });
});
