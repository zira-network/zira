// packages/protocol/test/pricing.test.ts
// Adaptive, decentralized pricing: prices float with observed demand/supply, deterministically, so
// every node computes the same fair number from the same gossiped state.
import { describe, it, expect } from "vitest";
import { PRICING, adaptiveQueryPriceUZIR, adaptiveTaskPriceUZIR } from "../src/constants";

describe("adaptive query pricing", () => {
  it("settles toward the floor when supply is ample", () => {
    const p = adaptiveQueryPriceUZIR({ openQueries: 0, providersOnline: 10 });
    expect(p).toBe(Math.round(PRICING.QUERY_BASE_UZIR * PRICING.QUERY_MIN_MULT));
  });

  it("rises with demand pressure and is capped at the max multiple", () => {
    const low = adaptiveQueryPriceUZIR({ openQueries: 2, providersOnline: 4 });
    const high = adaptiveQueryPriceUZIR({ openQueries: 50, providersOnline: 1 });
    expect(high).toBeGreaterThan(low);
    expect(high).toBe(Math.round(PRICING.QUERY_BASE_UZIR * PRICING.QUERY_MAX_MULT));
  });

  it("is deterministic for a given observed state", () => {
    const a = adaptiveQueryPriceUZIR({ openQueries: 7, providersOnline: 3 });
    const b = adaptiveQueryPriceUZIR({ openQueries: 7, providersOnline: 3 });
    expect(a).toBe(b);
  });

  it("treats zero providers as one (no divide-by-zero)", () => {
    expect(() => adaptiveQueryPriceUZIR({ openQueries: 5, providersOnline: 0 })).not.toThrow();
    expect(adaptiveQueryPriceUZIR({ openQueries: 5, providersOnline: 0 })).toBeGreaterThan(0);
  });
});

describe("adaptive task pricing", () => {
  it("scales above the base with required trust", () => {
    const cheap = adaptiveTaskPriceUZIR({ minZti: 0 });
    const dear = adaptiveTaskPriceUZIR({ minZti: 1 });
    expect(cheap).toBe(PRICING.TASK_BASE_UZIR);
    expect(dear).toBeGreaterThan(cheap);
  });

  it("never drops below the base coordination fee", () => {
    expect(adaptiveTaskPriceUZIR({})).toBeGreaterThanOrEqual(PRICING.TASK_BASE_UZIR);
  });
});
