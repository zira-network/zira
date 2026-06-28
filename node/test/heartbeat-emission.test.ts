// node/test/heartbeat-emission.test.ts
// The inference-free "mining/storage earns" path: when >= MIN_OBSERVATIONS contributing nodes submit a
// converging field-heartbeat observation (carrying their served storage), the PoR field seals a Lock and
// the round emission is split among the ELIGIBLE contributors, weighted by storage. Eligibility is the
// sybil-resistant gate: a contributor earns only if it is a genesis master (bootstrap infrastructure) or
// has done verifiable on-ledger work (a settled coordination payout) recently. Empty heartbeats from
// unknown nodes still converge for liveness but mint nothing — that is what stops emission farming.
import test from "node:test";
import assert from "node:assert/strict";
import {
  keypairFromPrivate, buildObservationBody, canonical, hashHex, sign as edSign, standardGenesis, PROTOCOL,
  type GenesisDoc, type SignedObservation,
} from "@zira/protocol";
import { State, EPOCH_MS, epochOf, GRACE_MS, SETTLE_ROUNDS } from "../src/core/State.js";

const founder = keypairFromPrivate("0a".repeat(32));
const GTS = 1_700_000_000_000;

// Three contributing nodes with different served-storage sizes.
const n1 = keypairFromPrivate("11".repeat(32)); // 0 GiB stored
const n2 = keypairFromPrivate("12".repeat(32)); // 25 GiB
const n3 = keypairFromPrivate("13".repeat(32)); // 50 GiB (full storage bonus)
// A devnet genesis whose master quorum is these three nodes, so the bootstrap earning path is exercised.
const masterGenesis: GenesisDoc = {
  ...standardGenesis("devnet", founder.address, GTS),
  masters: [n1, n2, n3].map((k) => ({ address: k.address, pubKey: k.publicKey })),
};
// A plain devnet genesis with no designated masters, for the sybil-gate test.
const plainGenesis = standardGenesis("devnet", founder.address, GTS);

function heartbeat(kp: ReturnType<typeof keypairFromPrivate>, storageGiB: number, ts: number): SignedObservation {
  const body = buildObservationBody({
    type: "value", observer: kp.publicKey, timestamp: ts, subject: "ZIRA_FIELD_HEARTBEAT",
    domain: "data", confidence: 0.9, sourceHashes: ["field-heartbeat"], value: 1, storageGiB,
  });
  const c = canonical(body);
  return { ...body, id: hashHex(c), sig: edSign(c, kp.privateKey) };
}
// A wall-clock time late enough that an observation stamped at `epoch` has been PROCESSED through the
// settled field window: emission lags the observation by GRACE_MS (epoch close grace) plus SETTLE_ROUNDS
// (the trailing-evidence lag), so we advance a couple of epochs past both before checking balances.
const at = (epoch: number): number => (epoch + SETTLE_ROUNDS + 2) * EPOCH_MS + GRACE_MS + 1;

test("field heartbeat: >=3 eligible contributors mint storage-weighted emission", () => {
  const s = new State(masterGenesis);
  const e = epochOf(GTS) + 1;
  const ts = e * EPOCH_MS + 10;

  assert.equal(s.ingestObservation(heartbeat(n1, 0, ts)).ok, true);
  assert.equal(s.ingestObservation(heartbeat(n2, 25, ts)).ok, true);
  assert.equal(s.ingestObservation(heartbeat(n3, 50, ts)).ok, true);

  const emittedBefore = s.supply.emitted;
  s.advance(at(e));

  const b1 = s.balanceOf(n1.address), b2 = s.balanceOf(n2.address), b3 = s.balanceOf(n3.address);
  assert.ok(s.supply.emitted > emittedBefore, "the heartbeat Lock minted round emission");
  assert.ok(b1 > 0 && b2 > 0 && b3 > 0, "every eligible contributing node earned");
  assert.ok(b3 > b1, "a node serving more storage earns more (storage-weighted split)");
  assert.ok(b3 >= b2 && b2 >= b1, "earnings scale monotonically with storage");
});

test("sybil gate: >=3 converging heartbeats from non-eligible nodes mint NOTHING", () => {
  // No genesis masters here, and these nodes have done no settled work, so although three converge and
  // seal a Lock (liveness), none is eligible to draw round emission. This is the farming defense.
  const s = new State(plainGenesis);
  const e = epochOf(GTS) + 1;
  const ts = e * EPOCH_MS + 10;
  assert.equal(s.ingestObservation(heartbeat(n1, 0, ts)).ok, true);
  assert.equal(s.ingestObservation(heartbeat(n2, 25, ts)).ok, true);
  assert.equal(s.ingestObservation(heartbeat(n3, 50, ts)).ok, true);

  const before = s.supply.emitted;
  s.advance(at(e));
  assert.equal(s.supply.emitted, before, "no eligible contributor, so the heartbeat mints nothing");
  assert.equal(s.balanceOf(n1.address), 0);
  assert.equal(s.balanceOf(n2.address), 0);
  assert.equal(s.balanceOf(n3.address), 0);
});

test("a single contributor does NOT mint (needs >= MIN_OBSERVATIONS to converge)", () => {
  const s = new State(masterGenesis);
  const e = epochOf(GTS) + 1;
  assert.equal(s.ingestObservation(heartbeat(n1, 50, e * EPOCH_MS + 10)).ok, true);
  const before = s.supply.emitted;
  s.advance(at(e));
  assert.equal(s.supply.emitted, before, "one observer is below MIN_OBSERVATIONS, so no Lock and no mint");
  assert.equal(s.balanceOf(n1.address), 0);
});
