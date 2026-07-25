// node/test/work-weighted-payout.test.ts
// Work-weighted field payout, ARMED. Proves the property that closes the "everyone paid the same" gap: when a
// bucket pays out, the fixed pool is split by each miner's converged work weight (median of the masters' sealed
// minerWork) instead of flat-per-peer, so an answered-inference miner earns far more than a storage host, which
// earns more than a mere-liveness peer. Also proves determinism: two replicas fed the identical history compute
// the byte-identical weighted split and state root (no fork on the weighting). Dormancy (byte-identical to the
// flat split when unarmed) is covered by the existing pool-beneficiary + field-payout tests, which do not set
// the work-weight activation env and therefore keep passing unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import {
  keypairFromPrivate, generateKeypair, buildObservationBody, canonical, hashHex, sign as edSign,
  standardGenesis, type GenesisDoc, type SignedObservation,
} from "@zira/protocol";
import { State, EPOCH_MS, epochOf, GRACE_MS, SETTLE_ROUNDS } from "../src/core/State.js";

const founder = keypairFromPrivate("0a".repeat(32));
const GTS = 60 * 5_666_668 * EPOCH_MS; // epochOf(GTS) = a bucket boundary (bucket = epoch/60)
const masters = [keypairFromPrivate("11".repeat(32)), keypairFromPrivate("12".repeat(32)), keypairFromPrivate("13".repeat(32))];
const miners = [generateKeypair(), generateKeypair(), generateKeypair()];
const minerAddrs = miners.map((k) => k.address).sort();
// Assign work tiers by address: answered-inference (top) > storage > liveness-only. Raw sealed weights (bp).
const ANSWER = minerAddrs[0]!, STORAGE = minerAddrs[1]!, LIVENESS = minerAddrs[2]!;
const WEIGHTS: Record<string, number> = { [ANSWER]: 300, [STORAGE]: 50, [LIVENESS]: 10 };
const genesis: GenesisDoc = {
  ...standardGenesis("devnet", founder.address, GTS),
  masters: masters.map((k) => ({ address: k.address, pubKey: k.publicKey })),
};
const genEpoch = epochOf(GTS);

function heartbeat(kp: ReturnType<typeof keypairFromPrivate>, tsEpoch: number): SignedObservation {
  const body = buildObservationBody({
    type: "value", observer: kp.publicKey, timestamp: tsEpoch * EPOCH_MS + 10, subject: "ZIRA_FIELD_HEARTBEAT",
    domain: "data", confidence: 0.9, sourceHashes: ["field-heartbeat"], value: 1, storageGiB: 8,
    vouchedMiners: minerAddrs, minerWork: WEIGHTS,
  });
  const c = canonical(body);
  return { ...body, id: hashHex(c), sig: edSign(c, kp.privateKey) };
}
const at = (epoch: number): number => (epoch + SETTLE_ROUNDS + 2) * EPOCH_MS + GRACE_MS + 1;

test("armed work-weighted payout: inference >> storage >> liveness, byte-identical across replicas", () => {
  const savedFp = process.env.ZIRA_FIELD_PAYOUT_ACTIVATION_EPOCH;
  const savedWw = process.env.ZIRA_WORK_WEIGHTED_FIELD_PAYOUT_ACTIVATION_EPOCH;
  process.env.ZIRA_FIELD_PAYOUT_ACTIVATION_EPOCH = String(genEpoch);
  process.env.ZIRA_WORK_WEIGHTED_FIELD_PAYOUT_ACTIVATION_EPOCH = String(genEpoch);
  try {
    const reps = [new State(genesis), new State(genesis)];
    for (const s of reps) s.advance(at(genEpoch + 5));
    // Every master seals the same per-miner work weights across the payout window (median == that weight).
    for (let e = genEpoch + 20; e <= genEpoch + 64; e++) {
      for (const m of masters) { const hb = heartbeat(m, e); for (const s of reps) s.ingestObservation(hb); }
    }
    for (const s of reps) s.advance(at(genEpoch + 70));

    const r0 = reps[0]!;
    const bAns = r0.balanceOf(ANSWER), bSto = r0.balanceOf(STORAGE), bLive = r0.balanceOf(LIVENESS);
    // Ordering: real compute earns the bulk, storage a minor share, liveness a small keep-alive.
    assert.ok(bAns > bSto && bSto > bLive, `weighted ordering answer(${bAns}) > storage(${bSto}) > liveness(${bLive})`);
    // Strength: the inference tier earns far more than the liveness tier (300 vs 10 => ~30x), proving it is not flat.
    assert.ok(bAns > 20 * bLive, `inference earns >20x liveness (got ${bAns} vs ${bLive})`);
    // Each paid bucket distributes the full fixed pool exactly (no ZIR minted or lost): the total is a whole
    // number of pools across however many buckets the window covered.
    const total = bAns + bSto + bLive;
    assert.ok(total > 0 && total % 5_000_000_000 === 0, `total is a whole number of pools (got ${total})`);
    // Determinism: both replicas compute the identical weighted split and state root (no fork on the weighting).
    const root0 = r0.stateRoot();
    for (const s of reps) {
      assert.equal(s.stateRoot(), root0, "identical state root across replicas (weighting is fork-safe)");
      assert.equal(s.balanceOf(ANSWER), bAns, "identical answer-tier balance");
      assert.equal(s.balanceOf(STORAGE), bSto, "identical storage-tier balance");
      assert.equal(s.balanceOf(LIVENESS), bLive, "identical liveness-tier balance");
    }
  } finally {
    if (savedFp === undefined) delete process.env.ZIRA_FIELD_PAYOUT_ACTIVATION_EPOCH; else process.env.ZIRA_FIELD_PAYOUT_ACTIVATION_EPOCH = savedFp;
    if (savedWw === undefined) delete process.env.ZIRA_WORK_WEIGHTED_FIELD_PAYOUT_ACTIVATION_EPOCH; else process.env.ZIRA_WORK_WEIGHTED_FIELD_PAYOUT_ACTIVATION_EPOCH = savedWw;
  }
});
