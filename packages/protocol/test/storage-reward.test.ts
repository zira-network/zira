// packages/protocol/test/storage-reward.test.ts
// Storage-weighted emission: a contributor that serves more of the field's authorized model weights earns
// a bounded bonus on its emission split. The bonus is a pure, deterministic multiplier on the reward WEIGHT
// (never on trust/ZTI), and the storageGiB it reads rides on the signed observation body so every node
// derives the same value. These tests pin the multiplier curve, the split effect, and — critically — that
// adding the optional storageGiB field never changes the canonical hash when it is absent (backward compat).
import { describe, it, expect } from "vitest";
import { PROTOCOL } from "../src/constants";
import { storageRewardMultiplier, splitReward } from "../src/por/rewards";
import { buildObservationBody, canonical } from "../src/serialize";

const { BONUS_MAX, REF_GIB } = PROTOCOL.STORAGE_REWARD;

describe("storageRewardMultiplier", () => {
  it("is 1.0 with no storage and saturates at 1 + BONUS_MAX at REF_GIB", () => {
    expect(storageRewardMultiplier(0)).toBe(1);
    expect(storageRewardMultiplier(REF_GIB)).toBeCloseTo(1 + BONUS_MAX, 9);
  });

  it("scales linearly between 0 and REF_GIB", () => {
    expect(storageRewardMultiplier(REF_GIB / 2)).toBeCloseTo(1 + BONUS_MAX / 2, 9);
  });

  it("is capped past REF_GIB so storage cannot run away", () => {
    expect(storageRewardMultiplier(REF_GIB * 10)).toBeCloseTo(1 + BONUS_MAX, 9);
    expect(storageRewardMultiplier(Number.MAX_SAFE_INTEGER)).toBeCloseTo(1 + BONUS_MAX, 9);
  });

  it("treats negative / NaN / Infinity as no storage (no bonus) — garbage never earns the cap", () => {
    expect(storageRewardMultiplier(-100)).toBe(1);
    expect(storageRewardMultiplier(NaN)).toBe(1);
    expect(storageRewardMultiplier(Infinity)).toBe(1); // non-finite is rejected, not treated as huge storage
  });
});

describe("storage bonus in the emission split", () => {
  it("pays an equally-accurate, higher-storage contributor a larger slice (no extra minting)", () => {
    const accuracy = 0.9;
    const contribs = [
      { pubKey: "low", accuracy: accuracy * storageRewardMultiplier(0) },       // 1.0x
      { pubKey: "high", accuracy: accuracy * storageRewardMultiplier(REF_GIB) }, // 1.5x
    ];
    const total = 1_000_000;
    const parts = splitReward(total, contribs);
    const low = parts.find((p) => p.pubKey === "low")!.amountUZIR;
    const high = parts.find((p) => p.pubKey === "high")!.amountUZIR;
    expect(high).toBeGreaterThan(low);
    expect(high / low).toBeCloseTo(1 + BONUS_MAX, 2); // 1.5x weight -> 1.5x payout
    expect(low + high).toBe(total);                   // pure division, mints nothing
  });

  it("storage alone earns nothing without accuracy (you must observe correctly to be in the split)", () => {
    const parts = splitReward(1_000_000, [
      { pubKey: "stores-but-wrong", accuracy: 0 * storageRewardMultiplier(REF_GIB) },
      { pubKey: "accurate", accuracy: 0.8 * storageRewardMultiplier(0) },
    ]);
    expect(parts.find((p) => p.pubKey === "stores-but-wrong")!.amountUZIR).toBe(0);
    expect(parts.find((p) => p.pubKey === "accurate")!.amountUZIR).toBe(1_000_000);
  });
});

describe("observation canonical form stays backward compatible", () => {
  const base = {
    type: "value" as const, observer: "ffaa", timestamp: 1700000000000,
    subject: "MODEL_ANSWER_QUALITY", domain: "science" as const,
    confidence: 0.85, sourceHashes: ["t"], value: 0.82,
  };

  it("an observation WITHOUT storageGiB hashes exactly like the pre-storage shape", () => {
    const withBuilder = canonical(buildObservationBody(base));
    const legacy = canonical({
      type: base.type, observer: base.observer, timestamp: base.timestamp,
      subject: base.subject, domain: base.domain, confidence: base.confidence,
      sourceHashes: base.sourceHashes, value: base.value,
    });
    expect(withBuilder).toBe(legacy);
  });

  it("storageGiB changes the canonical form only when present", () => {
    const without = canonical(buildObservationBody(base));
    const withStorage = canonical(buildObservationBody({ ...base, storageGiB: 50 }));
    expect(withStorage).not.toBe(without);
    // and it is stable / deterministic
    expect(withStorage).toBe(canonical(buildObservationBody({ ...base, storageGiB: 50 })));
  });
});
