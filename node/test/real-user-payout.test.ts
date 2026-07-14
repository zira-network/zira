// Paid real-user answering: when a real user funds a query, the settler pays the miners who answered, with the
// convergence policy — >= REAL_USER_QUERY_CONVERGENCE converged answers earn the FULL charged budget, a lone
// answerer (thin serving pool) earns only REAL_USER_LONE_ANSWER_FACTOR of it. The math is pure + deterministic
// (constants.convergenceAdjustedBudget + por.settleCoordination), so the settler's single signed batch_transfer
// is byte-identical on every node. Dormant (realUserQueryPayoutActive=false) until armed => byte-identical today.
import test from "node:test";
import assert from "node:assert/strict";
import {
  convergenceAdjustedBudget, realUserQueryPayoutActive, queryTierMultiplier,
  settleCoordination, PROTOCOL, keypairFromPrivate, hashHex,
} from "@zira/protocol";

const A = keypairFromPrivate("41".repeat(32)).address;
const B = keypairFromPrivate("42".repeat(32)).address;
const BUDGET = 1_000_000_000; // 1000 ZIR charged by the asker
const amt = (split: ReturnType<typeof settleCoordination>, addr: string) =>
  split.payouts.filter((p) => p.address === addr).reduce((s, p) => s + p.amountUZIR, 0);

test("dormant by default: paid answering is off and the tier multiplier is 1x", () => {
  // The whole feature is inert until armed, so shipping is byte-identical to today.
  assert.equal(PROTOCOL.REAL_USER_QUERY_PAYOUT_ACTIVATION_EPOCH, 0, "ships dormant");
  assert.equal(realUserQueryPayoutActive(0), false, "epoch 0 => not active");
  assert.equal(realUserQueryPayoutActive(1_000_000), false, "any epoch, dormant activation => not active");
  assert.equal(queryTierMultiplier(5000, 1_000_000), 1, "query-tier pricing also ships dormant (always 1x)");
});

test("convergence policy: >=2 answers earn the full budget, a lone answer earns the reduced fraction", () => {
  assert.equal(convergenceAdjustedBudget(BUDGET, 2), BUDGET, "two converged answers => full budget");
  assert.equal(convergenceAdjustedBudget(BUDGET, 3), BUDGET, "more than the threshold => still full budget");
  assert.equal(
    convergenceAdjustedBudget(BUDGET, 1),
    Math.floor(BUDGET * PROTOCOL.REAL_USER_LONE_ANSWER_FACTOR),
    "a single answerer earns only the lone-answer fraction",
  );
  assert.equal(convergenceAdjustedBudget(BUDGET, 0), 0, "no answerer => nothing to pay");
  assert.ok(PROTOCOL.REAL_USER_LONE_ANSWER_FACTOR > 0 && PROTOCOL.REAL_USER_LONE_ANSWER_FACTOR < 1, "reduced, not zero, not full");
});

test("a lone answerer is paid, but strictly less than the same answerer would earn in a converged panel", () => {
  // Same answerer weight; only the convergence-adjusted budget differs. Coverage stays alive with one server,
  // without paying a lone (possibly self-dealing) answerer the full price.
  const loneBudget = convergenceAdjustedBudget(BUDGET, 1);
  const lone = settleCoordination(loneBudget, [{ address: A, domainZti: 0.7, confidence: 0.8, agreement: 1 }]);
  const converged = settleCoordination(convergenceAdjustedBudget(BUDGET, 2), [
    { address: A, domainZti: 0.7, confidence: 0.8, agreement: 1 },
    { address: B, domainZti: 0.7, confidence: 0.8, agreement: 1 },
  ]);
  assert.ok(amt(lone, A) > 0, "a lone answerer still earns (coverage stays alive)");
  assert.ok(amt(converged, A) > amt(lone, A), "the same answerer earns more inside a converged panel than alone");
});

test("the charged budget IS the answerer budget: contributors take the §9 contributor slice of it", () => {
  const budget = convergenceAdjustedBudget(BUDGET, 2);
  const split = settleCoordination(budget, [
    { address: A, domainZti: 0.7, confidence: 0.9, agreement: 1 },
    { address: B, domainZti: 0.7, confidence: 0.9, agreement: 1 },
  ]);
  const contributors = split.payouts.reduce((s, p) => s + p.amountUZIR, 0);
  const total = contributors + split.networkUZIR + split.resonatorPoolUZIR + split.burnUZIR;
  assert.equal(total, budget, "the four §9 slices sum EXACTLY to the charged budget (mints nothing)");
  assert.ok(Math.abs(contributors / budget - PROTOCOL.COORD_SPLIT.CONTRIBUTORS) < 0.02, "~77% goes to the answerers");
});

test("namespace guard: a paid real-user query id can NEVER collide with an autonomous (hashed) id", () => {
  // Autonomous-coordination query ids are hashHex(...) => lowercase hex (0-9a-f). The reserved real-user
  // prefix "ru-" starts with 'r', which is NOT a hex character, so a hashed id can never begin with it. This
  // is what makes a charge crafted for an autonomous id impossible to settle as (or pre-empt) a real-user
  // query — the settler ignores any charge whose id is outside the "ru-" namespace.
  const PREFIX = "ru-";
  assert.ok(!/^[0-9a-f]/.test(PREFIX), "the prefix's first char is non-hex, so no hash can produce it");
  for (const seed of ["a", "resonator-1:42", "zira-autonomous-query:devnet:7:anchor-A-001", "another:99:x"]) {
    const id = hashHex("zira-autonomous-query:" + seed);
    assert.ok(/^[0-9a-f]+$/.test(id), "an autonomous id is lowercase hex");
    assert.ok(!id.startsWith(PREFIX), "a hashed id never starts with the real-user namespace prefix");
  }
});

test("fork-safe determinism: identical inputs produce byte-identical payouts", () => {
  const mk = () => settleCoordination(convergenceAdjustedBudget(BUDGET, 2), [
    { address: A, domainZti: 0.63, confidence: 0.77, agreement: 0.9 },
    { address: B, domainZti: 0.41, confidence: 0.88, agreement: 0.8 },
  ]);
  assert.deepEqual(mk(), mk(), "the settler's split is a pure function => every node applies the same batch_transfer");
});
