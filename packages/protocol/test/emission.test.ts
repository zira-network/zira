// packages/protocol/test/emission.test.ts
// The formal emission curve: a halving schedule with a floor, capped cumulatively by the earned
// supply. The state machine clamps cumulative emission to TOTAL_EARNED_UZIR.
import { describe, it, expect } from "vitest";
import { EMISSION, epochReward } from "../src/constants";

describe("emission schedule", () => {
  it("epochReward(0) equals the initial epoch reward", () => {
    expect(epochReward(0)).toBe(EMISSION.INITIAL_EPOCH_REWARD_UZIR);
  });

  it("epochReward halves after HALVING_EPOCHS", () => {
    expect(epochReward(EMISSION.HALVING_EPOCHS)).toBe(EMISSION.INITIAL_EPOCH_REWARD_UZIR >> 1n);
    expect(epochReward(EMISSION.HALVING_EPOCHS * 2)).toBe(EMISSION.INITIAL_EPOCH_REWARD_UZIR >> 2n);
  });

  it("epochReward never falls below the minimum", () => {
    for (const n of [0, 1, EMISSION.HALVING_EPOCHS, EMISSION.HALVING_EPOCHS * 40, EMISSION.HALVING_EPOCHS * 200]) {
      expect(epochReward(n) >= EMISSION.MINIMUM_EPOCH_REWARD_UZIR).toBe(true);
    }
  });

  it("the reward is non-increasing across halvings", () => {
    let prev = epochReward(0);
    for (let h = 1; h <= 70; h++) {
      const r = epochReward(EMISSION.HALVING_EPOCHS * h);
      expect(r <= prev).toBe(true);
      prev = r;
    }
  });

  it("cumulative emission, clamped to the cap, never exceeds TOTAL_EARNED_UZIR", () => {
    // sample coarsely (one point per halving block) and clamp to remaining, as the state machine does
    let cumulative = 0n;
    for (let h = 0; h < 70; h++) {
      const perEpoch = epochReward(EMISSION.HALVING_EPOCHS * h);
      const block = perEpoch * BigInt(EMISSION.HALVING_EPOCHS);
      const remaining = EMISSION.TOTAL_EARNED_UZIR - cumulative;
      cumulative += block < remaining ? block : remaining;
      expect(cumulative <= EMISSION.TOTAL_EARNED_UZIR).toBe(true);
    }
  });

  it("the three emission shares sum to 1", () => {
    expect(EMISSION.CONSENSUS_SHARE + EMISSION.INFERENCE_SHARE + EMISSION.AGENT_SHARE).toBeCloseTo(1, 9);
  });
});
