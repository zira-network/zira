// Query work-tier pricing: a heavier question needs a bigger model, so it costs more and pays the answerers
// more. The tier is a PURE function of the signed query text (question + prior turns), so every node agrees on
// the price and the budget. Dormant (always 1x) until QUERY_TIER_PRICING_ACTIVATION_EPOCH is armed, so
// shipping is byte-identical to today. Multipliers: quick 1x / standard 2x / deep 4x.
import test from "node:test";
import assert from "node:assert/strict";
import { queryComplexityChars, queryTier, queryTierMultiplier, queryPriceUZIR, adaptiveQueryPriceUZIR, PROTOCOL } from "@zira/protocol";

const CTX = { openQueries: 2, providersOnline: 4 };
const q = (n: number) => "x".repeat(n);

function armed(fn: () => void): void {
  const key = "QUERY_TIER_PRICING_ACTIVATION_EPOCH";
  const prev = (PROTOCOL as Record<string, number>)[key];
  (PROTOCOL as Record<string, number>)[key] = 1; // arm from epoch 1
  try { fn(); } finally { (PROTOCOL as Record<string, number>)[key] = prev; }
}

test("complexity counts the question plus every prior turn", () => {
  assert.equal(queryComplexityChars("hello", [{ content: "aaa" }, { content: "bb" }]), 5 + 3 + 2);
  assert.equal(queryComplexityChars("hi"), 2);
});

test("tier boundaries: quick < 400 <= standard < 1200 <= deep", () => {
  assert.equal(queryTier(0), "quick");
  assert.equal(queryTier(399), "quick");
  assert.equal(queryTier(400), "standard");
  assert.equal(queryTier(1199), "standard");
  assert.equal(queryTier(1200), "deep");
  assert.equal(queryTier(5000), "deep");
});

test("dormant by default: multiplier is always 1x (byte-identical to today)", () => {
  assert.equal(queryTierMultiplier(50), 1);
  assert.equal(queryTierMultiplier(600), 1);
  assert.equal(queryTierMultiplier(5000), 1);
  // The full price equals the plain adaptive price while dormant.
  assert.equal(queryPriceUZIR({ ...CTX, chars: 5000 }), adaptiveQueryPriceUZIR(CTX));
});

test("armed: multiplier is 1x / 2x / 4x by tier", () => {
  armed(() => {
    assert.equal(queryTierMultiplier(50), 1, "quick = 1x");
    assert.equal(queryTierMultiplier(600), 2, "standard = 2x");
    assert.equal(queryTierMultiplier(5000), 4, "deep = 4x");
  });
});

test("armed: a bigger-model query costs strictly more, and the ratio is exactly the tier", () => {
  armed(() => {
    const base = adaptiveQueryPriceUZIR(CTX);
    const quick = queryPriceUZIR({ ...CTX, chars: 50 });
    const standard = queryPriceUZIR({ ...CTX, chars: 600 });
    const deep = queryPriceUZIR({ ...CTX, chars: 5000 });
    assert.equal(quick, base, "quick == base");
    assert.equal(standard, base * 2, "standard == 2x base");
    assert.equal(deep, base * 4, "deep == 4x base");
    assert.ok(deep > standard && standard > quick, "heavier query, higher cost");
  });
});

test("epoch gate: still 1x before the activation epoch even when armed", () => {
  armed(() => {
    // activation epoch is 1; an epoch of 0 is before it, so the tier stays dormant.
    assert.equal(queryTierMultiplier(5000, 0), 1, "before activation epoch: 1x");
    assert.equal(queryTierMultiplier(5000, 1), 4, "at/after activation epoch: tiered");
  });
});

test("deterministic: identical query text always yields the identical tier and price", () => {
  armed(() => {
    const question = q(700);
    const a = queryPriceUZIR({ ...CTX, chars: queryComplexityChars(question) });
    const b = queryPriceUZIR({ ...CTX, chars: queryComplexityChars(question) });
    assert.equal(a, b, "same input, same price on every node");
    assert.equal(queryTier(queryComplexityChars(question)), "standard");
  });
});
