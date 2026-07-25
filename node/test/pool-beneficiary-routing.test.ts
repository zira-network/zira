// node/test/pool-beneficiary-routing.test.ts
// Pooled payouts (set_beneficiary), ARMED. Proves the fork-safety property that matters when the feature is
// activated: a miner that named a pool beneficiary has its pure-epoch field-payout share routed to the pool
// (root-committed map), and TWO replicas fed the identical history compute the BYTE-IDENTICAL routed payout
// and state root. The dormant/root-neutral case is covered by the protocol pool-beneficiary-root test and the
// field-payout dormancy test; this covers the LIVE routing determinism.
import test from "node:test";
import assert from "node:assert/strict";
import {
  keypairFromPrivate, generateKeypair, buildObservationBody, buildTxBody, canonical, hashHex, sign as edSign,
  standardGenesis, type GenesisDoc, type SignedObservation, type SignedTx,
} from "@zira/protocol";
import { State, EPOCH_MS, epochOf, GRACE_MS, SETTLE_ROUNDS } from "../src/core/State.js";

const founder = keypairFromPrivate("0a".repeat(32));
const GTS = 60 * 5_666_668 * EPOCH_MS; // epochOf(GTS) = a bucket boundary (bucket = epoch/60)
const masters = [keypairFromPrivate("11".repeat(32)), keypairFromPrivate("12".repeat(32)), keypairFromPrivate("13".repeat(32))];
const miners = [generateKeypair(), generateKeypair(), generateKeypair()];
const minerAddrs = miners.map((k) => k.address).sort();
const pool = generateKeypair(); // the pool beneficiary (not a miner, just receives routed rewards)
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
function setBeneficiary(kp: ReturnType<typeof generateKeypair>, to: string, nonce: number, tsEpoch: number): SignedTx {
  const body = buildTxBody({
    network: genesis.network, from: kp.address, fromPubKey: kp.publicKey, to,
    amountUZIR: 0, feeUZIR: 0, nonce, kind: "set_beneficiary", parents: [], timestamp: tsEpoch * EPOCH_MS + 5,
  });
  const c = canonical(body);
  return { ...body, id: hashHex(c), sig: edSign(c, kp.privateKey) };
}
const at = (epoch: number): number => (epoch + SETTLE_ROUNDS + 2) * EPOCH_MS + GRACE_MS + 1;

test("armed pooled payout: a miner's field share routes to its pool beneficiary, byte-identically across replicas", () => {
  const savedFp = process.env.ZIRA_FIELD_PAYOUT_ACTIVATION_EPOCH;
  const savedPb = process.env.ZIRA_POOL_BENEFICIARY_ACTIVATION_EPOCH;
  process.env.ZIRA_FIELD_PAYOUT_ACTIVATION_EPOCH = String(genEpoch);
  process.env.ZIRA_POOL_BENEFICIARY_ACTIVATION_EPOCH = String(genEpoch);
  try {
    const reps = [new State(genesis), new State(genesis)];
    // Advance a few epochs so lastProcessedEpoch >= activation, then submit the beneficiary declaration: the
    // lowest-sorted miner routes its rewards to the pool. Fed identically to both replicas.
    for (const s of reps) s.advance(at(genEpoch + 5));
    const routedMiner = miners.find((m) => m.address === minerAddrs[0])!;
    const tx = setBeneficiary(routedMiner, pool.address, 0, genEpoch + 6);
    for (const s of reps) s.ingestTx(tx);
    // Heartbeats from all masters vouching every miner, across the payout window, identical to both replicas.
    for (let e = genEpoch + 20; e <= genEpoch + 64; e++) {
      for (const m of masters) { const hb = heartbeat(m, e, minerAddrs); for (const s of reps) s.ingestObservation(hb); }
    }
    for (const s of reps) s.advance(at(genEpoch + 70));

    const r0 = reps[0]!;
    // The routed miner earned nothing directly; the pool received its share; the other miners earned directly.
    assert.equal(r0.balanceOf(minerAddrs[0]!), 0, "the pooled miner's own balance stays 0 (routed away)");
    assert.ok(r0.balanceOf(pool.address) > 0, "the pool beneficiary received the routed field-payout share");
    for (const a of minerAddrs.slice(1)) assert.ok(r0.balanceOf(a) > 0, "non-pooled miners still earn directly");
    // Determinism: both replicas compute the identical routed payout and root (no fork on the routing).
    const root0 = r0.stateRoot();
    for (const s of reps) {
      assert.equal(s.stateRoot(), root0, "identical state root across replicas (routing is fork-safe)");
      assert.equal(s.balanceOf(pool.address), r0.balanceOf(pool.address), "identical pool balance");
      assert.equal(s.balanceOf(minerAddrs[0]!), 0, "identical routed-miner balance");
    }
  } finally {
    if (savedFp === undefined) delete process.env.ZIRA_FIELD_PAYOUT_ACTIVATION_EPOCH; else process.env.ZIRA_FIELD_PAYOUT_ACTIVATION_EPOCH = savedFp;
    if (savedPb === undefined) delete process.env.ZIRA_POOL_BENEFICIARY_ACTIVATION_EPOCH; else process.env.ZIRA_POOL_BENEFICIARY_ACTIVATION_EPOCH = savedPb;
  }
});
