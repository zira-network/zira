// node/test/weighted-payout.test.ts
// The field-participation pool is split by weight (storage + coordination answers + ZTI) so a stronger
// machine earns more, but the outputs must still sum EXACTLY to the pool and be fully deterministic, or the
// settler's signed batch_transfer would be rejected / diverge. weightedOutputs is the pure apportionment.
import test from "node:test";
import assert from "node:assert/strict";
import { weightedOutputs } from "../src/core/payout-split.js";

const sum = (o: [string, number][]) => o.reduce((s, [, v]) => s + v, 0);

test("weighted outputs always sum EXACTLY to the pool", () => {
  const payees = ["zir1a", "zir1b", "zir1c", "zir1d", "zir1e"];
  for (const pool of [5_000_000_000, 1, 7, 999_983, 123_456_789]) {
    for (const weights of [[1, 1, 1, 1, 1], [1, 2, 3, 4, 5], [6, 1, 1, 1, 1], [0, 0, 0, 0, 1]]) {
      const out = weightedOutputs(payees, weights, pool);
      assert.equal(sum(out), pool, `pool=${pool} weights=${weights}`);
      assert.ok(out.every(([, v]) => v >= 0));
    }
  }
});

test("equal weights split as evenly as an integer pool allows", () => {
  const payees = ["zir1a", "zir1b", "zir1c"];
  const out = weightedOutputs(payees, [1, 1, 1], 10);
  assert.equal(sum(out), 10);
  const vals = out.map(([, v]) => v).sort();
  assert.deepEqual(vals, [3, 3, 4]); // largest-remainder gives the extra uZIR to one payee
});

test("a heavier weight earns a strictly larger share", () => {
  const payees = ["zir1a", "zir1b"];
  const out = weightedOutputs(payees, [1, 5], 6_000_000);
  const m = new Map(out);
  assert.ok(m.get("zir1b")! > m.get("zir1a")!);
  assert.equal(m.get("zir1a")! + m.get("zir1b")!, 6_000_000);
  // 1:5 weight -> ~1M : ~5M
  assert.ok(Math.abs(m.get("zir1b")! - 5_000_000) <= 1);
});

test("deterministic: same inputs give byte-identical outputs (no gossip variance)", () => {
  const payees = ["zir1x", "zir1y", "zir1z", "zir1w"];
  const weights = [1.5, 3.25, 1, 2.75];
  const a = weightedOutputs(payees, weights, 5_000_000_000);
  const b = weightedOutputs([...payees], [...weights], 5_000_000_000);
  assert.deepEqual(a, b);
});

test("zero / non-finite weights fall back to an even split (never mints or loses ZIR)", () => {
  const payees = ["zir1a", "zir1b", "zir1c", "zir1d"];
  const out = weightedOutputs(payees, [0, 0, 0, 0], 1000);
  assert.equal(sum(out), 1000);
  const out2 = weightedOutputs(payees, [NaN, Infinity, -1, 2], 1000);
  assert.equal(sum(out2), 1000);
});

test("no output is ever <= 0 (the ledger rejects the whole batch on a non-positive output)", () => {
  // A tiny pool against a skewed weight set used to leave a low-weight payee at 0 -> batch rejected.
  const payees = ["zir1a", "zir1b", "zir1c", "zir1d", "zir1e"];
  for (const pool of [1, 2, 3, 4, 5, 6, 7, 10, 64, 5_000_000_000]) {
    for (const weights of [[1, 6], [1, 100], [1, 1, 1, 1, 1], [1, 2, 3, 4, 5], [0, 0, 0, 0, 1]]) {
      const p = payees.slice(0, weights.length);
      const out = weightedOutputs(p, weights, pool);
      assert.equal(sum(out), pool, `pool=${pool} weights=${weights}`);
      assert.ok(out.every(([, v]) => v > 0), `pool=${pool} weights=${weights} has a non-positive output`);
      assert.ok(out.length <= p.length && out.length <= pool, `pool=${pool} weights=${weights} too many outputs`);
    }
  }
});
