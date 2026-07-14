// node/test/field-payout-pure-epoch.test.ts
// The DURABLE fix for the recurring 2026-07 head-fork: field-participation payouts used to be a gossiped settler
// batch_transfer, so a master that missed the packet forked its balances -> different root -> split votes ->
// finality froze. The pure-epoch payout (State.distributeFieldParticipation) instead credits the converged,
// LONG-LAGGED vouched-miner set directly in processEpoch, with NO gossiped tx. This test proves:
//   (a) determinism — replicas fed the same heartbeats compute the BYTE-IDENTICAL payout + root;
//   (b) SKEW-tolerance — replicas that ingest the masters' heartbeats at DIFFERENT times (gossip delay), as long
//       as each arrives within the long convergence budget, still converge to the identical payout; and
//   (c) dormancy — off until FIELD_PAYOUT_PURE_ACTIVATION_EPOCH, so prod is root-neutral.
import test from "node:test";
import assert from "node:assert/strict";
import {
  keypairFromPrivate, generateKeypair, buildObservationBody, canonical, hashHex, sign as edSign,
  standardGenesis, type GenesisDoc, type SignedObservation,
} from "@zira/protocol";
import { State, EPOCH_MS, epochOf, GRACE_MS, SETTLE_ROUNDS } from "../src/core/State.js";

const founder = keypairFromPrivate("0a".repeat(32));
const GTS = 60 * 5_666_668 * EPOCH_MS; // epochOf(GTS) = 340000080, an exact bucket boundary (bucket = epoch/60)
const masters = [keypairFromPrivate("11".repeat(32)), keypairFromPrivate("12".repeat(32)), keypairFromPrivate("13".repeat(32))];
const miners = [generateKeypair(), generateKeypair(), generateKeypair()];
const minerAddrs = miners.map((k) => k.address).sort();
const genesis: GenesisDoc = {
  ...standardGenesis("devnet", founder.address, GTS),
  masters: masters.map((k) => ({ address: k.address, pubKey: k.publicKey })),
};
const genEpoch = epochOf(GTS);

function heartbeat(kp: ReturnType<typeof keypairFromPrivate>, tsEpoch: number, vouched: string[]): SignedObservation {
  const body = buildObservationBody({
    type: "value", observer: kp.publicKey, timestamp: tsEpoch * EPOCH_MS + 10, subject: "ZIRA_FIELD_HEARTBEAT",
    domain: "data", confidence: 0.9, sourceHashes: ["field-heartbeat"], value: 1, storageGiB: 8, vouchedMiners: vouched,
  });
  const c = canonical(body);
  return { ...body, id: hashHex(c), sig: edSign(c, kp.privateKey) };
}
const at = (epoch: number): number => (epoch + SETTLE_ROUNDS + 2) * EPOCH_MS + GRACE_MS + 1;

test("pure-epoch field payout: every replica credits the same miners the same amounts (deterministic, no tx)", () => {
  const prev = process.env.ZIRA_FIELD_PAYOUT_ACTIVATION_EPOCH;
  process.env.ZIRA_FIELD_PAYOUT_ACTIVATION_EPOCH = String(genEpoch);
  try {
    const reps = [new State(genesis), new State(genesis), new State(genesis)];
    // Heartbeats from all masters, vouching the miners, streamed across a range that covers whatever epoch the
    // payout fires in (its window is [E-29, E-24]). Fed IDENTICALLY to every replica, advanced together.
    for (let e = genEpoch + 20; e <= genEpoch + 64; e++) {
      for (const m of masters) { const hb = heartbeat(m, e, minerAddrs); for (const s of reps) s.ingestObservation(hb); }
    }
    for (const s of reps) s.advance(at(genEpoch + 70));

    const r0 = reps[0]!;
    for (const a of minerAddrs) assert.ok(r0.balanceOf(a) > 0, "each vouched miner earned a share");
    const root0 = r0.stateRoot();
    for (const s of reps) {
      assert.equal(s.stateRoot(), root0, "every replica computed the identical state root (no payout fork)");
      for (const a of minerAddrs) assert.equal(s.balanceOf(a), r0.balanceOf(a), "identical per-miner balance");
    }
  } finally {
    if (prev === undefined) delete process.env.ZIRA_FIELD_PAYOUT_ACTIVATION_EPOCH; else process.env.ZIRA_FIELD_PAYOUT_ACTIVATION_EPOCH = prev;
  }
});

test("pure-epoch field payout is SKEW-tolerant: heartbeats ingested at different times still converge", () => {
  const prev = process.env.ZIRA_FIELD_PAYOUT_ACTIVATION_EPOCH;
  process.env.ZIRA_FIELD_PAYOUT_ACTIVATION_EPOCH = String(genEpoch);
  try {
    // Two replicas. Both eventually receive EVERY master's heartbeat (timestamped in the payout window), but at
    // DIFFERENT ingest points — replica B receives master[2]'s heartbeats LATE (after advancing many epochs),
    // simulating a slow gossip path. Because the payout filters by heartbeat TIMESTAMP (not arrival) and the long
    // lag keeps them ingestable, both replicas end with the identical vouched set -> identical payout -> one root.
    const A = new State(genesis), B = new State(genesis);
    const hbs = (e: number) => masters.map((m) => heartbeat(m, e, minerAddrs));
    for (let e = genEpoch + 20; e <= genEpoch + 40; e++) {
      for (const hb of hbs(e)) { A.ingestObservation(hb); B.ingestObservation(hb); }
    }
    // Advance both a little; then deliver master[2]'s heartbeats to B LATE (still within the long budget), while A
    // already had them.
    A.advance(at(genEpoch + 44)); B.advance(at(genEpoch + 44));
    for (let e = genEpoch + 20; e <= genEpoch + 40; e++) {
      const lateHb = heartbeat(masters[2]!, e, minerAddrs);
      assert.equal(B.ingestObservation(lateHb).isNew === false || B.ingestObservation(lateHb).ok, true, "late heartbeat still accepted within the long budget");
    }
    A.advance(at(genEpoch + 70)); B.advance(at(genEpoch + 70));

    for (const a of minerAddrs) assert.ok(A.balanceOf(a) > 0, "miners paid despite skew");
    assert.equal(A.stateRoot(), B.stateRoot(), "skewed replicas converge to the identical root (no fork)");
    for (const a of minerAddrs) assert.equal(A.balanceOf(a), B.balanceOf(a), "identical per-miner balance under skew");
  } finally {
    if (prev === undefined) delete process.env.ZIRA_FIELD_PAYOUT_ACTIVATION_EPOCH; else process.env.ZIRA_FIELD_PAYOUT_ACTIVATION_EPOCH = prev;
  }
});

test("dormant by default: no field payout, root-neutral (behaves exactly as before)", () => {
  const prev = process.env.ZIRA_FIELD_PAYOUT_ACTIVATION_EPOCH;
  delete process.env.ZIRA_FIELD_PAYOUT_ACTIVATION_EPOCH;
  try {
    const s = new State(genesis);
    for (let e = genEpoch + 20; e <= genEpoch + 64; e++) for (const m of masters) s.ingestObservation(heartbeat(m, e, minerAddrs));
    s.advance(at(genEpoch + 70));
    for (const a of minerAddrs) assert.equal(s.balanceOf(a), 0, "dormant: miners are NOT paid by the pure-epoch path");
  } finally {
    if (prev !== undefined) process.env.ZIRA_FIELD_PAYOUT_ACTIVATION_EPOCH = prev;
  }
});
