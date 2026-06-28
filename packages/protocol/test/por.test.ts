import { describe, it, expect } from "vitest";
import { accuracyScore, emaAccuracy, consistencyScore, applyAbsenceDecay, composeZti } from "../src/por/zti";
import { trustWeightedMedian, cv, convergeStep, tryLock, type Claim } from "../src/por/field";
import { perRoundReward, splitReward, EARNED_CAP } from "../src/por/rewards";

describe("zti math", () => {
  it("accuracyScore ~0.96 at 10% error and 0 at 50%", () => {
    expect(accuracyScore(1.1, 1.0)).toBeCloseTo(0.96, 2);
    expect(accuracyScore(1.5, 1.0)).toBe(0);
    expect(accuracyScore(1.0, 1.0)).toBe(1);
  });
  it("emaAccuracy moves slowly", () => {
    expect(emaAccuracy(0.5, 1.0)).toBeCloseTo(0.5 * 0.92 + 0.08, 6);
  });
  it("consistencyScore is 1 for steady values and lower for erratic", () => {
    expect(consistencyScore([10, 10, 10])).toBe(1);
    expect(consistencyScore([5, 15, 5, 15])).toBeLessThan(1);
  });
  it("applyAbsenceDecay shrinks trust over missed rounds", () => {
    const after = applyAbsenceDecay(1, 100000);
    expect(after).toBeLessThan(1);
    expect(after).toBeGreaterThan(0);
  });
  it("composeZti blends 0.55/0.25/0.20 and clamps", () => {
    expect(composeZti(1, 1, 1)).toBe(1);
    expect(composeZti(0, 0, 0)).toBe(0);
    expect(composeZti(0.8, 0.6, 0.4)).toBeCloseTo(0.55 * 0.8 + 0.25 * 0.6 + 0.2 * 0.4, 6);
  });
});

describe("field math", () => {
  it("median does not move at 49.9% weight but flips past 50%", () => {
    // Two camps: low value 100, high value 200. An attacker tries to push to 200.
    const below: Claim[] = [
      { value: 100, zti: 1, confidence: 0.501 }, // honest weight 0.501
      { value: 200, zti: 1, confidence: 0.499 }, // attacker weight 0.499
    ];
    expect(trustWeightedMedian(below)).toBe(100);
    const above: Claim[] = [
      { value: 100, zti: 1, confidence: 0.499 },
      { value: 200, zti: 1, confidence: 0.501 },
    ];
    expect(trustWeightedMedian(above)).toBe(200);
  });
  it("trustWeightedMedian is null with zero total weight", () => {
    expect(trustWeightedMedian([{ value: 5, zti: 0, confidence: 0 }])).toBeNull();
  });
  it("cv is Infinity for <2 values or zero mean", () => {
    expect(cv([5])).toBe(Infinity);
    expect(cv([1, -1])).toBe(Infinity);
    expect(cv([100, 102, 101])).toBeLessThan(0.02);
  });
  it("convergeStep moves low trust faster than high trust", () => {
    const lowTrust = convergeStep(0, 100, 0.1);
    const highTrust = convergeStep(0, 100, 0.9);
    expect(lowTrust).toBeGreaterThan(highTrust);
  });
  it("tryLock gates correctly", () => {
    const tight: Claim[] = [
      { value: 100, zti: 0.9, confidence: 1, observer: "aa" },
      { value: 100.5, zti: 0.9, confidence: 1, observer: "bb" },
      { value: 99.8, zti: 0.9, confidence: 1, observer: "cc" },
    ];
    const lock = tryLock("USD", "currency", 1, tight, 0.9);
    expect(lock).not.toBeNull();
    expect(lock!.observationCount).toBe(3);
    expect(lock!.supporters.length).toBe(3);

    // too few observations
    expect(tryLock("USD", "currency", 1, tight.slice(0, 2), 0.9)).toBeNull();
    // too low supporting trust
    expect(tryLock("USD", "currency", 1, tight, 0.5)).toBeNull();
    // cv too wide
    const wide: Claim[] = [
      { value: 50, zti: 1, confidence: 1, observer: "aa" },
      { value: 100, zti: 1, confidence: 1, observer: "bb" },
      { value: 150, zti: 1, confidence: 1, observer: "cc" },
    ];
    expect(tryLock("USD", "currency", 1, wide, 0.9)).toBeNull();
  });
});

describe("rewards", () => {
  it("perRoundReward never exceeds the earned cap and tapers", () => {
    const early = perRoundReward(0);
    const late = perRoundReward(EARNED_CAP - 5000);
    expect(early).toBeGreaterThan(0);
    expect(perRoundReward(0)).toBeGreaterThanOrEqual(perRoundReward(EARNED_CAP / 2));
    expect(late).toBeLessThanOrEqual(5000);
    expect(perRoundReward(EARNED_CAP)).toBe(0);
  });
  it("splitReward sums exactly to total and weights by accuracy", () => {
    const parts = splitReward(1000, [
      { pubKey: "aa", accuracy: 0.9 },
      { pubKey: "bb", accuracy: 0.1 },
    ]);
    expect(parts.reduce((a, p) => a + p.amountUZIR, 0)).toBe(1000);
    const a = parts.find((p) => p.pubKey === "aa")!;
    const b = parts.find((p) => p.pubKey === "bb")!;
    expect(a.amountUZIR).toBeGreaterThan(b.amountUZIR);
  });
  it("splitReward splits evenly when no positive accuracy", () => {
    const parts = splitReward(10, [
      { pubKey: "aa", accuracy: 0 },
      { pubKey: "bb", accuracy: 0 },
    ]);
    expect(parts.reduce((a, p) => a + p.amountUZIR, 0)).toBe(10);
  });
});
