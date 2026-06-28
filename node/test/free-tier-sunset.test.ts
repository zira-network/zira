// Free-tier sunset: the free allowance is a launch subsidy that tapers across the network's first
// year and closes at the end of it. effectiveFreeLimit is the pure policy function behind the
// /query and /query/quota gates. This is local RPC policy keyed on wall-clock, not consensus.
import { test } from "node:test";
import assert from "node:assert/strict";
import { effectiveFreeLimit } from "../src/rpc/server.ts";

const YEAR = 365 * 24 * 60 * 60 * 1000;
const START = 1_700_000_000_000; // fixed reference genesis time

test("no start/duration wired keeps the allowance flat (unit-test default)", () => {
  assert.equal(effectiveFreeLimit(10, undefined, undefined, START + YEAR * 5), 10);
  assert.equal(effectiveFreeLimit(10, START, 0, START + 999), 10);
});

test("at genesis the full initial allowance is available", () => {
  assert.equal(effectiveFreeLimit(10, START, YEAR, START), 10);
});

test("the allowance tapers down through the first year", () => {
  const quarter = effectiveFreeLimit(10, START, YEAR, START + YEAR * 0.25); // ~7
  const half = effectiveFreeLimit(10, START, YEAR, START + YEAR * 0.5);     // 5
  const threeQ = effectiveFreeLimit(10, START, YEAR, START + YEAR * 0.75);  // ~2
  assert.equal(half, 5);
  assert.ok(quarter > half && half > threeQ, `expected ${quarter} > ${half} > ${threeQ}`);
  assert.ok(threeQ >= 1, "stays at least 1 until the cutoff");
});

test("the free tier is closed at and after one year", () => {
  assert.equal(effectiveFreeLimit(10, START, YEAR, START + YEAR), 0);
  assert.equal(effectiveFreeLimit(10, START, YEAR, START + YEAR + 1), 0);
  assert.equal(effectiveFreeLimit(10, START, YEAR, START + YEAR * 2), 0);
});

test("a clock before genesis falls back to the full allowance", () => {
  assert.equal(effectiveFreeLimit(10, START, YEAR, START - 1000), 10);
});
