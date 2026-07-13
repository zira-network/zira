// Endpoint / answering miners earn MORE, weighted by trust (ZTI), self-confidence, and agreement with the
// converged answer. This proves the "run a model, answer the field, earn on top of the storage baseline"
// path: settleCoordination weights each answerer by domainZti x confidence x agreement, capped so no single
// voice dominates, and a miner that does NOT answer draws nothing. Pure + deterministic (por/rewards).
import test from "node:test";
import assert from "node:assert/strict";
import { settleCoordination, PROTOCOL, keypairFromPrivate } from "@zira/protocol";

const A = keypairFromPrivate("41".repeat(32)).address;
const B = keypairFromPrivate("42".repeat(32)).address;
const C = keypairFromPrivate("43".repeat(32)).address;
const BUDGET = 1_000_000_000; // 1000 ZIR
const amt = (split: ReturnType<typeof settleCoordination>, addr: string) =>
  split.payouts.filter((p) => p.address === addr).reduce((s, p) => s + p.amountUZIR, 0);

test("an answering miner earns a coordination slice (the storage baseline plus this)", () => {
  const split = settleCoordination(BUDGET, [{ address: A, domainZti: 0.6, confidence: 0.8, agreement: 1 }]);
  assert.ok(amt(split, A) > 0, "a provider that answered is paid from the contributor pool");
  assert.ok(split.networkUZIR > 0 && split.resonatorPoolUZIR > 0, "the network + pool slices are also funded");
});

test("higher ZTI earns strictly more for the same answer", () => {
  // Same confidence and agreement; only trust differs. Higher domain ZTI -> bigger slice.
  const split = settleCoordination(BUDGET, [
    { address: A, domainZti: 0.9, confidence: 0.8, agreement: 1 },
    { address: B, domainZti: 0.3, confidence: 0.8, agreement: 1 },
  ]);
  assert.ok(amt(split, A) > amt(split, B), "the higher-ZTI answerer earns more");
});

test("a better (higher-agreement) answer earns more than a divergent one", () => {
  const split = settleCoordination(BUDGET, [
    { address: A, domainZti: 0.7, confidence: 0.9, agreement: 1.0 },   // agrees with the panel
    { address: B, domainZti: 0.7, confidence: 0.9, agreement: 0.2 },   // diverges (likely wrong)
  ]);
  assert.ok(amt(split, A) > amt(split, B), "the consensus-agreeing answer earns more than the divergent one");
});

test("higher self-confidence earns more, all else equal", () => {
  const split = settleCoordination(BUDGET, [
    { address: A, domainZti: 0.7, confidence: 0.95, agreement: 1 },
    { address: B, domainZti: 0.7, confidence: 0.30, agreement: 1 },
  ]);
  assert.ok(amt(split, A) > amt(split, B), "the more-confident answerer earns more");
});

test("a miner that does not answer earns nothing from coordination", () => {
  const split = settleCoordination(BUDGET, [{ address: A, domainZti: 0.7, confidence: 0.8, agreement: 1 }]);
  assert.equal(amt(split, C), 0, "a non-answering miner draws no coordination slice");
});

test("no single answerer dominates the payout (per-contributor share cap)", () => {
  // One overwhelming weight vs two small ones: the big one is capped at COORD_MAX_SHARE of the contributor pool.
  const split = settleCoordination(BUDGET, [
    { address: A, domainZti: 1.0, confidence: 1.0, agreement: 1.0 },
    { address: B, domainZti: 0.05, confidence: 0.1, agreement: 0.1 },
    { address: C, domainZti: 0.05, confidence: 0.1, agreement: 0.1 },
  ]);
  const contributorPool = split.payouts.reduce((s, p) => s + p.amountUZIR, 0);
  const cap = Math.ceil(contributorPool * PROTOCOL.COORD_MAX_SHARE) + 2; // +2 for integer dust rounding
  assert.ok(amt(split, A) <= cap, `dominant answerer capped near COORD_MAX_SHARE (${amt(split, A)} <= ${cap})`);
  assert.ok(amt(split, B) > 0 && amt(split, C) > 0, "the smaller answerers still earn a share");
});

test("the whole budget is accounted for: contributor pool >= 77%, nothing minted or lost", () => {
  const split = settleCoordination(BUDGET, [
    { address: A, domainZti: 0.8, confidence: 0.8, agreement: 0.9 },
    { address: B, domainZti: 0.6, confidence: 0.7, agreement: 0.8 },
  ]);
  const contributorPool = split.payouts.reduce((s, p) => s + p.amountUZIR, 0);
  const sum = contributorPool + split.networkUZIR + split.resonatorPoolUZIR + split.burnUZIR;
  assert.equal(sum, BUDGET, "the four slices sum to the exact budget");
  assert.ok(contributorPool >= Math.floor(BUDGET * 0.77), "answerers get at least 77% of the budget");
});
