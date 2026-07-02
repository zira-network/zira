// node/test/heartbeat-emission.test.ts
// Base per-epoch emission. When >= MIN_OBSERVATIONS nodes submit a converging field-heartbeat observation
// the PoR field seals a Lock, and the epoch's base emission is credited to the FIXED genesis-master set,
// split equally. It is NOT distributed to the live-observed contributor set: that made supply.emitted and
// balances depend on gossip propagation, so the state root diverged across masters and quorum finality
// stalled. Miners/resonators do not earn base emission; they earn from coordination settlement and tasks.
// These tests prove (a) converging masters each earn equal base emission, (b) a non-master contributor
// earns nothing from base emission, (c) a network with no genesis masters mints nothing, (d) a lone
// observer seals no Lock and mints nothing.
import test from "node:test";
import assert from "node:assert/strict";
import {
  keypairFromPrivate, buildObservationBody, canonical, hashHex, sign as edSign, standardGenesis,
  type GenesisDoc, type SignedObservation,
} from "@zira/protocol";
import { State, EPOCH_MS, epochOf, GRACE_MS, SETTLE_ROUNDS } from "../src/core/State.js";

const founder = keypairFromPrivate("0a".repeat(32));
const GTS = 1_700_000_000_000;

// Three genesis-master nodes and one non-master serving miner.
const m1 = keypairFromPrivate("11".repeat(32));
const m2 = keypairFromPrivate("12".repeat(32));
const m3 = keypairFromPrivate("13".repeat(32));
const miner = keypairFromPrivate("31".repeat(32)); // non-master, serves 50 GiB
// A devnet genesis whose master quorum is these three nodes, so the base-emission path is exercised.
const masterGenesis: GenesisDoc = {
  ...standardGenesis("devnet", founder.address, GTS),
  masters: [m1, m2, m3].map((k) => ({ address: k.address, pubKey: k.publicKey })),
};
// A plain devnet genesis with no designated masters.
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

test("field heartbeat: converging genesis masters each earn EQUAL base emission", () => {
  const s = new State(masterGenesis);
  const e = epochOf(GTS) + 1;
  const ts = e * EPOCH_MS + 10;

  // masters heartbeat with DIFFERENT served-storage sizes; base emission ignores storage (equal split).
  assert.equal(s.ingestObservation(heartbeat(m1, 0, ts)).ok, true);
  assert.equal(s.ingestObservation(heartbeat(m2, 25, ts)).ok, true);
  assert.equal(s.ingestObservation(heartbeat(m3, 50, ts)).ok, true);

  const emittedBefore = s.supply.emitted;
  s.advance(at(e));

  const b1 = s.balanceOf(m1.address), b2 = s.balanceOf(m2.address), b3 = s.balanceOf(m3.address);
  assert.ok(s.supply.emitted > emittedBefore, "the heartbeat Lock minted base emission");
  assert.ok(b1 > 0 && b2 > 0 && b3 > 0, "every genesis master earned base emission");
  assert.equal(b1, b2, "masters earn an equal split (storage does not weight base emission)");
  assert.equal(b2, b3, "masters earn an equal split (storage does not weight base emission)");
});

test("a non-master contributor earns NOTHING from base emission (miners earn by work)", () => {
  const s = new State(masterGenesis);
  const e = epochOf(GTS) + 1;
  const ts = e * EPOCH_MS + 10;
  // masters converge (they earn), and a non-master miner heartbeats with full storage alongside them.
  assert.equal(s.ingestObservation(heartbeat(m1, 0, ts)).ok, true);
  assert.equal(s.ingestObservation(heartbeat(m2, 0, ts)).ok, true);
  assert.equal(s.ingestObservation(heartbeat(m3, 0, ts)).ok, true);
  assert.equal(s.ingestObservation(heartbeat(miner, 50, ts)).ok, true);

  s.advance(at(e));
  assert.ok(s.balanceOf(m1.address) > 0, "masters still earn base emission");
  assert.equal(s.balanceOf(miner.address), 0, "the non-master miner earns nothing from base emission");
});

test("no genesis masters: converging heartbeats mint NOTHING", () => {
  const s = new State(plainGenesis);
  const e = epochOf(GTS) + 1;
  const ts = e * EPOCH_MS + 10;
  assert.equal(s.ingestObservation(heartbeat(m1, 0, ts)).ok, true);
  assert.equal(s.ingestObservation(heartbeat(m2, 25, ts)).ok, true);
  assert.equal(s.ingestObservation(heartbeat(m3, 50, ts)).ok, true);

  const before = s.supply.emitted;
  s.advance(at(e));
  assert.equal(s.supply.emitted, before, "no genesis-master set, so base emission mints nothing");
  assert.equal(s.balanceOf(m1.address), 0);
});

test("base emission accrues to the masters every epoch, independent of convergence", () => {
  // A single observer seals no Lock (needs >= MIN_OBSERVATIONS), but base emission is a per-epoch schedule to
  // the fixed masters that does NOT depend on the observation window — so the masters still earn, deterministically.
  const s = new State(masterGenesis);
  const e = epochOf(GTS) + 1;
  assert.equal(s.ingestObservation(heartbeat(m1, 50, e * EPOCH_MS + 10)).ok, true);
  s.advance(at(e));
  assert.equal(s.valueOf("ZIRA_FIELD_HEARTBEAT"), null, "one observer seals no Lock");
  assert.ok(s.supply.emitted > 0, "base emission still accrues to the masters (not Lock-gated)");
  assert.equal(s.balanceOf(m1.address), s.balanceOf(m2.address), "masters earn an equal base split");
});

test("with no observations at all, base emission still accrues to the masters", () => {
  // The purest determinism check: emission is a function of the epoch reached, not of any observation.
  const s = new State(masterGenesis);
  const e = epochOf(GTS) + 1;
  s.advance(at(e));
  assert.ok(s.supply.emitted > 0, "masters earn base emission with zero observations");
  assert.equal(s.balanceOf(m1.address), s.balanceOf(m3.address), "equal split across masters");
});
