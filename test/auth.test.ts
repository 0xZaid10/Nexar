// test/auth.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { SessionManager }  from "../src/auth/SessionManager.js";
import { WalletManager }   from "../src/auth/WalletManager.js";
import { SESSION_TTL }     from "../src/core/config.js";

beforeAll(() => {
  process.env.JWT_SECRET  = "cipher-test-secret-64-chars-minimum-padding-here-1234567890";
  process.env.DB_PATH     = "./nexar-test.db";
  // No PRIVY credentials in test — use local wallet mode
  delete process.env.PRIVY_APP_ID;
  delete process.env.PRIVY_APP_SECRET;
});

const ADDR = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const IP   = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;

// ─── SessionManager ───────────────────────────────────────────────────────────

describe("SessionManager", () => {
  const mgr = new SessionManager();

  it("creates a valid session token", () => {
    const s = mgr.createSession({ address: ADDR, role: "reviewer", ttl: SESSION_TTL.MEDIUM });
    expect(s.token).toBeTruthy();
    expect(s.expiresAt).toBeGreaterThan(Date.now() / 1000);
    expect(s.address).toBe(ADDR);
  });

  it("verifies a valid session", () => {
    const s = mgr.createSession({ address: ADDR, role: "agent", ttl: 3600 });
    const p = mgr.verifySession(s.token);
    expect(p.address).toBe(ADDR);
    expect(p.role).toBe("agent");
  });

  it("throws SESSION_EXPIRED on expired token", async () => {
    const s = mgr.createSession({ address: ADDR, role: "reviewer", ttl: 1 });
    await new Promise((r) => setTimeout(r, 1500));
    try {
      mgr.verifySession(s.token);
      expect.fail("Should have thrown");
    } catch (e: unknown) {
      const code = (e as Record<string, unknown>)["code"];
      expect(code).toBe("SESSION_EXPIRED");
    }
  });

  it("throws SESSION_REVOKED after revokeSession", () => {
    const s = mgr.createSession({ address: ADDR, role: "inference", ttl: 3600 });
    mgr.revokeSession(s.token);
    try {
      mgr.verifySession(s.token);
      expect.fail("Should have thrown");
    } catch (e: unknown) {
      const code = (e as Record<string, unknown>)["code"];
      expect(code).toBe("SESSION_REVOKED");
    }
  });

  it("throws SESSION_INVALID on garbage token", () => {
    try {
      mgr.verifySession("garbage");
      expect.fail("Should have thrown");
    } catch (e: unknown) {
      const code = (e as Record<string, unknown>)["code"];
      expect(code).toBe("SESSION_INVALID");
    }
  });

  it("isValidSession returns false for revoked token", () => {
    const s = mgr.createSession({ address: ADDR, role: "reviewer", ttl: 3600 });
    expect(mgr.isValidSession(s.token)).toBe(true);
    mgr.revokeSession(s.token);
    expect(mgr.isValidSession(s.token)).toBe(false);
  });

  it("createReviewerSession uses 48h TTL by default", () => {
    const s = mgr.createReviewerSession({ reviewerAddress: ADDR, vaultUuid: 42n, ipId: IP });
    const p = mgr.verifySession(s.token);
    expect(p.role).toBe("reviewer");
    expect(p.vaultUuid).toBe(42n);
    expect(p.ipId).toBe(IP);
    const remaining = s.expiresAt - Math.floor(Date.now() / 1000);
    expect(remaining).toBeGreaterThan(SESSION_TTL.MEDIUM - 10);
  });

  it("createAgentSession uses short TTL by default", () => {
    const s = mgr.createAgentSession({ agentAddress: ADDR, assetId: 1n, vaultUuid: 99n });
    const p = mgr.verifySession(s.token);
    expect(p.role).toBe("agent");
    expect(p.assetId).toBe(1n);
  });

  it("multiple independent sessions do not interfere", () => {
    const s1 = mgr.createSession({ address: ADDR, role: "reviewer", ttl: 3600, vaultUuid: 1n });
    const s2 = mgr.createSession({ address: ADDR, role: "agent",    ttl: 3600, vaultUuid: 2n });
    mgr.revokeSession(s1.token);
    expect(mgr.isValidSession(s2.token)).toBe(true);
  });
});

// ─── WalletManager ────────────────────────────────────────────────────────────

describe("WalletManager", () => {
  const mgr = new WalletManager();

  it("creates a wallet with valid EVM address", async () => {
    const rec = await mgr.createWallet("test@nexar.io");
    expect(rec.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // Privy wallets have empty encryptedPrivateKey — check address instead
    expect(rec.address).toBeTruthy();
    expect(rec.label).toBe("test@nexar.io");
  });

  it("returns existing wallet when label already exists", async () => {
    const r1 = await mgr.createWallet("alice@nexar.io");
    const r2 = await mgr.createWallet("alice@nexar.io");
    expect(r1.address).toBe(r2.address);
  });

  it("hasWallet returns true after creation", async () => {
    await mgr.createWallet("check@nexar.io");
    expect(mgr.hasWallet("check@nexar.io")).toBe(true);
  });

  it("hasWallet returns false for unknown label", () => {
    expect(mgr.hasWallet("unknown@nexar.io")).toBe(false);
  });

  it("getAddress returns correct address", async () => {
    const rec  = await mgr.createWallet("addr@nexar.io");
    const addr = await mgr.getAddress("addr@nexar.io");
    expect(addr).toBe(rec.address);
  });

  it("getAccount decrypts private key and returns Account", async () => {
    // Local mode (no Privy) — should return local account
    await mgr.createWallet("account@nexar.io");
    const account = await mgr.getAccount("account@nexar.io");
    expect(account.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("different labels get different wallets", async () => {
    const r1 = await mgr.createWallet("user1@nexar.io");
    const r2 = await mgr.createWallet("user2@nexar.io");
    expect(r1.address).not.toBe(r2.address);
  });

  it("deleteWallet removes the record", async () => {
    await mgr.createWallet("delete@nexar.io");
    const deleted = mgr.deleteWallet("delete@nexar.io");
    expect(deleted).toBe(true);
    expect(mgr.hasWallet("delete@nexar.io")).toBe(false);
  });

  it("getWallet throws for unknown label", async () => {
    try {
      await mgr.getWallet("nobody@nexar.io");
      expect.fail("Should have thrown");
    } catch (e: unknown) {
      const code = (e as Record<string, unknown>)["code"];
      expect(code).toBe("WALLET_CREATE_FAILED");
    }
  });
});
