// test/licensing.test.ts
// Tests for Layer 3: Programmable Licensing Engine
// Tests: PILBuilder, pctToStoryUnits, RoyaltyEngine simulations, DerivativeEngine

import { describe, it, expect } from "vitest";
import { PILBuilder, pctToStoryUnits, storyUnitsToPct } from "../src/licensing/PILBuilder.js";
import { RoyaltyEngine } from "../src/licensing/RoyaltyEngine.js";
import { NexarError }   from "../src/core/errors.js";
import { STORY_CONTRACTS, TOKENS } from "../src/core/config.js";
import { parseEther, zeroAddress } from "viem";

const ADDR_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`;
const ADDR_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as `0x${string}`;
const ADDR_C = "0xcccccccccccccccccccccccccccccccccccccccc" as `0x${string}`;

// ─── PILBuilder ───────────────────────────────────────────────────────────────

describe("PILBuilder", () => {
  const b = new PILBuilder();

  it("pctToStoryUnits converts correctly", () => {
    expect(pctToStoryUnits(10)).toBe(10_000_000);
    expect(pctToStoryUnits(15)).toBe(15_000_000);
    expect(pctToStoryUnits(100)).toBe(100_000_000);
    expect(pctToStoryUnits(0)).toBe(0);
  });

  it("storyUnitsToPct inverts correctly", () => {
    expect(storyUnitsToPct(10_000_000)).toBe(10);
    expect(storyUnitsToPct(0)).toBe(0);
  });

  it("pctToStoryUnits throws on out-of-range values", () => {
    expect(() => pctToStoryUnits(-1)).toThrow(NexarError);
    expect(() => pctToStoryUnits(101)).toThrow(NexarError);
  });

  it("nonCommercial preset has zero minting fee", () => {
    const t = b.nonCommercial();
    expect(t.commercialUse).toBe(false);
    expect(t.defaultMintingFee).toBe(0n);
    expect(t.derivativesAllowed).toBe(true);
    expect(t.royaltyPolicy).toBe(zeroAddress);
  });

  it("commercialUse preset has correct structure", () => {
    const t = b.commercialUse("0.1", 5);
    expect(t.commercialUse).toBe(true);
    expect(t.commercialRevShare).toBe(5_000_000);
    expect(t.derivativesAllowed).toBe(false);
    expect(t.royaltyPolicy).toBe(STORY_CONTRACTS.RoyaltyPolicyLAP);
    expect(t.currency).toBe(TOKENS.WIP);
  });

  it("commercialRemix allows derivatives with rev share", () => {
    const t = b.commercialRemix("0.5", 15);
    expect(t.derivativesAllowed).toBe(true);
    expect(t.derivativesReciprocal).toBe(true);
    expect(t.commercialRevShare).toBe(15_000_000);
    expect(t.defaultMintingFee).toBe(parseEther("0.5"));
  });

  it("inferenceOnly is non-transferable, no derivatives", () => {
    const t = b.inferenceOnly("0.05", 5);
    expect(t.transferable).toBe(false);
    expect(t.derivativesAllowed).toBe(false);
    expect(t.commercialUse).toBe(true);
  });

  it("build() throws on non-commercial with revShare > 0", () => {
    expect(() =>
      b.build({ commercial: false, revShare: 10, derivatives: true, transferable: true, mintingFee: "0" })
    ).toThrow(NexarError);
  });

  it("build() throws on invalid mintingFee", () => {
    expect(() =>
      b.build({ commercial: true, revShare: 0, derivatives: true, transferable: true, mintingFee: "abc" })
    ).toThrow(NexarError);
  });

  it("buildLicensingConfig includes hook and revShare", () => {
    const cfg = b.buildLicensingConfig({
      hookAddress:  ADDR_A,
      mintingFee:   "0.1",
      revSharePct:  15,
    });
    expect(cfg.isSet).toBe(true);
    expect(cfg.licensingHook).toBe(ADDR_A);
    expect(cfg.commercialRevShare).toBe(15_000_000);
    expect(cfg.disabled).toBe(false);
  });
});

// ─── RoyaltyEngine ────────────────────────────────────────────────────────────

describe("RoyaltyEngine.simulateDistribution", () => {
  // Use a mock royalty engine — no on-chain calls needed for simulation
  const mockStory = {} as any;
  const engine    = new RoyaltyEngine(mockStory);

  it("distributes 15% to single ancestor correctly", () => {
    const dist = engine.simulateDistribution(
      [{ ipId: ADDR_A, revSharePct: 15 }, { ipId: ADDR_B, revSharePct: 0 }],
      parseEther("100")
    );
    const aliceShare = dist.get(ADDR_A)!;
    expect(aliceShare).toBe(parseEther("15"));
  });

  it("remainder goes to final node", () => {
    const dist = engine.simulateDistribution(
      [{ ipId: ADDR_A, revSharePct: 15 }, { ipId: ADDR_B, revSharePct: 0 }],
      parseEther("100")
    );
    // ADDR_B gets revShare 0 from chain + remainder = 85 ETH + 0 ETH upstream
    // ADDR_B is last node so gets remainder: 100 - 15 = 85 ETH
    expect(dist.get(ADDR_B)).toBe(parseEther("85"));
  });

  it("handles zero revenue correctly", () => {
    const dist = engine.simulateDistribution(
      [{ ipId: ADDR_A, revSharePct: 15 }, { ipId: ADDR_B, revSharePct: 0 }],
      0n
    );
    expect(dist.get(ADDR_A)).toBe(0n);
    expect(dist.get(ADDR_B)).toBe(0n);
  });

  it("buildGraphFromChain creates correct root", () => {
    const chain = [
      { ipId: ADDR_A, name: "Dataset",  revSharePct: 15 },
      { ipId: ADDR_B, name: "Model",    revSharePct: 20 },
      { ipId: ADDR_C, name: "Strategy", revSharePct:  0 },
    ];
    const graph = engine.buildGraphFromChain(chain);
    expect(graph.ipId).toBe(ADDR_A);
    expect(graph.children).toHaveLength(1);
    expect(graph.children[0]!.ipId).toBe(ADDR_B);
    expect(graph.children[0]!.children[0]!.ipId).toBe(ADDR_C);
  });

  it("buildGraphFromChain throws on empty chain", () => {
    expect(() => engine.buildGraphFromChain([])).toThrow(NexarError);
  });
});
