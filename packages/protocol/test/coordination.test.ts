// packages/protocol/test/coordination.test.ts
// Multi-intelligence coordination: model-type taxonomy + routing helpers, and the deterministic
// coordination settlement split (domain ZTI x confidence, steward-ops share, exact sums, no minting).
import { describe, it, expect } from "vitest";
import {
  MODEL_TYPES, MODEL_TYPE_META, defaultDomainsForModelType, modelServesDomain, preferredModelTypeForDomain,
  settleCoordination, PROTOCOL,
  NETWORK_RESONATOR_SPECS, NETWORK_RESONATOR_COUNT, MAINNET_NETWORK_RESONATOR_OWNER,
} from "../src/index";

describe("model-type taxonomy + routing", () => {
  it("exposes the six modalities with default domains", () => {
    expect(MODEL_TYPES).toEqual(["text", "code", "image", "video", "audio", "other"]);
    for (const t of MODEL_TYPES) expect(MODEL_TYPE_META[t].domains.length).toBeGreaterThan(0);
    expect(defaultDomainsForModelType("code")).toContain("code");
  });

  it("routes a query domain to the preferred model type", () => {
    expect(preferredModelTypeForDomain("code")).toBe("code");
    expect(preferredModelTypeForDomain("vision")).toBe("image");
    expect(preferredModelTypeForDomain("video")).toBe("video");
    expect(preferredModelTypeForDomain("audio")).toBe("audio");
    expect(preferredModelTypeForDomain("reasoning")).toBe("text");
  });

  it("matches a model to a domain by its declared domains, with text/other as general fallback", () => {
    expect(modelServesDomain("code", ["code"], "code")).toBe(true);
    expect(modelServesDomain("code", ["code"], "vision")).toBe(false);
    // empty domains fall back to the type's defaults
    expect(modelServesDomain("image", undefined, "vision")).toBe(true);
    // text/other act as generalists for "general"
    expect(modelServesDomain("text", ["language"], "general")).toBe(true);
    expect(modelServesDomain("image", ["vision"], "general")).toBe(false);
  });
});

describe("settleCoordination (§9 four-way split)", () => {
  const sum = (s: ReturnType<typeof settleCoordination>) =>
    s.payouts.reduce((a, p) => a + p.amountUZIR, 0) + s.networkUZIR + s.resonatorPoolUZIR + s.burnUZIR;

  it("splits a budget into contributors/network/pool/burn with exact sums and no minting", () => {
    const budget = 1_000_000;
    const split = settleCoordination(budget, [
      { address: "zir1aaa", domainZti: 0.9, confidence: 1.0 },
      { address: "zir1bbb", domainZti: 0.3, confidence: 1.0 },
    ]);
    expect(split.networkUZIR).toBe(Math.floor(budget * PROTOCOL.COORD_SPLIT.NETWORK));         // 80_000
    expect(split.resonatorPoolUZIR).toBe(Math.floor(budget * PROTOCOL.COORD_SPLIT.RESONATOR_POOL)); // 100_000
    expect(split.burnUZIR).toBe(Math.floor(budget * PROTOCOL.COORD_SPLIT.BURN));               // 50_000
    const paid = split.payouts.reduce((s, p) => s + p.amountUZIR, 0);
    expect(paid).toBe(budget - split.networkUZIR - split.resonatorPoolUZIR - split.burnUZIR); // 770_000
    // all four slices sum to exactly the budget (no minting, no dust lost)
    expect(sum(split)).toBe(budget);
    // the higher-trust contributor earns more
    const a = split.payouts.find((p) => p.address === "zir1aaa")!;
    const b = split.payouts.find((p) => p.address === "zir1bbb")!;
    expect(a.amountUZIR).toBeGreaterThan(b.amountUZIR);
  });

  it("weights pay by agreement: a divergent answer earns less than an agreeing one at equal trust/confidence", () => {
    const split = settleCoordination(1_000_000, [
      { address: "zir1agree", domainZti: 0.8, confidence: 1.0, agreement: 1.0 },
      { address: "zir1diverge", domainZti: 0.8, confidence: 1.0, agreement: 0.1 },
    ]);
    const agree = split.payouts.find((p) => p.address === "zir1agree")!;
    const diverge = split.payouts.find((p) => p.address === "zir1diverge")!;
    expect(agree.amountUZIR).toBeGreaterThan(diverge.amountUZIR);
    expect(sum(split)).toBe(1_000_000);
  });

  it("caps any single contributor's share when two or more coordinate, redistributing the excess", () => {
    // One contributor would otherwise take ~94% of the contributors pool; the cap holds it to COORD_MAX_SHARE.
    const budget = 1_000_000;
    const split = settleCoordination(budget, [
      { address: "zir1whale", domainZti: 0.95, confidence: 1.0 },
      { address: "zir1minnow", domainZti: 0.05, confidence: 1.0 },
    ]);
    const pool = split.payouts.reduce((a, p) => a + p.amountUZIR, 0);
    const whale = split.payouts.find((p) => p.address === "zir1whale")!;
    // Allow a few uZIR of dust over the exact cap; the whale must be near the cap, not ~94% of the pool.
    expect(whale.amountUZIR).toBeLessThanOrEqual(Math.ceil(pool * PROTOCOL.COORD_MAX_SHARE) + 4);
    expect(whale.amountUZIR).toBeGreaterThan(Math.floor(pool * (PROTOCOL.COORD_MAX_SHARE - 0.05)));
    expect(sum(split)).toBe(budget);
  });

  it("keeps sums exact for a single contributor and folds the contributor slice into the network wallet when none answered", () => {
    const one = settleCoordination(500_000, [{ address: "zir1x", domainZti: 0.5, confidence: 0.8 }]);
    expect(one.payouts.length).toBe(1);
    expect(sum(one)).toBe(500_000);
    // no contributors: their slice funds the network wallet, sum still exact, nothing paid out
    const none = settleCoordination(100_000, []);
    expect(none.payouts.length).toBe(0);
    expect(none.networkUZIR).toBeGreaterThan(Math.floor(100_000 * PROTOCOL.COORD_SPLIT.NETWORK));
    expect(sum(none)).toBe(100_000);
    // zero budget pays nothing
    expect(sum(settleCoordination(0, [{ address: "zir1x", domainZti: 1, confidence: 1 }]))).toBe(0);
  });
});

describe("network resonator seed specs", () => {
  it("defines a stable set of founder-owned coordinators, one per model type plus a field coordinator", () => {
    expect(NETWORK_RESONATOR_COUNT).toBe(NETWORK_RESONATOR_SPECS.length);
    expect(NETWORK_RESONATOR_COUNT).toBeGreaterThanOrEqual(MODEL_TYPES.length);
    expect(MAINNET_NETWORK_RESONATOR_OWNER).toBe("zir1km32wyjkya4h6utahkuckm56zgshnevy4v3a7t");
    // every model type is covered by at least one coordinator
    for (const t of MODEL_TYPES) expect(NETWORK_RESONATOR_SPECS.some((s) => s.modelType === t)).toBe(true);
    // ids are unique and ZTI is a sane standing
    expect(new Set(NETWORK_RESONATOR_SPECS.map((s) => s.id)).size).toBe(NETWORK_RESONATOR_COUNT);
    for (const s of NETWORK_RESONATOR_SPECS) { expect(s.zti).toBeGreaterThan(0); expect(s.zti).toBeLessThanOrEqual(0.95); }
  });
});
