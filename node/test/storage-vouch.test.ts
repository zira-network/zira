// node/test/storage-vouch.test.ts
// Emission determinism: the property whose absence stalled quorum finality. Base emission is credited to the
// FIXED genesis-master set, split equally, by a budget that is a pure function of supply.emitted — never to
// the live-observed contributor set. So two nodes that observed DIFFERENT contributor subsets (the reality of
// gossip propagation) still emit the same amount to the same masters and compute a byte-identical state root.
// A master vouch (vouchedMiners) still sets the miner's lastWorkEpoch (soft state, master-tenure accrual), but
// that no longer moves any balance, so it cannot diverge the root. These tests prove exactly that.
import test from "node:test";
import assert from "node:assert/strict";
import {
  keypairFromPrivate, buildObservationBody, canonical, hashHex, sign as edSign, standardGenesis,
  type GenesisDoc, type SignedObservation,
} from "@zira/protocol";
import { State, EPOCH_MS, epochOf, GRACE_MS, SETTLE_ROUNDS } from "../src/core/State.js";

const founder = keypairFromPrivate("0a".repeat(32));
const GTS = 1_700_000_000_000;
const m1 = keypairFromPrivate("21".repeat(32));
const m2 = keypairFromPrivate("22".repeat(32));
const m3 = keypairFromPrivate("23".repeat(32));
const miner = keypairFromPrivate("31".repeat(32));   // a non-master serving miner
const masterGenesis: GenesisDoc = {
  ...standardGenesis("devnet", founder.address, GTS),
  masters: [m1, m2, m3].map((k) => ({ address: k.address, pubKey: k.publicKey })),
};

function heartbeat(kp: ReturnType<typeof keypairFromPrivate>, ts: number, storageGiB: number, vouchedMiners?: string[]): SignedObservation {
  const body = buildObservationBody({
    type: "value", observer: kp.publicKey, timestamp: ts, subject: "ZIRA_FIELD_HEARTBEAT",
    domain: "data", confidence: 0.9, sourceHashes: ["field-heartbeat"], value: 1, storageGiB, vouchedMiners,
  });
  const c = canonical(body);
  return { ...body, id: hashHex(c), sig: edSign(c, kp.privateKey) };
}
const at = (epoch: number): number => (epoch + SETTLE_ROUNDS + 2) * EPOCH_MS + GRACE_MS + 1;

test("a master vouch sets the miner's lastWorkEpoch but moves no balance", () => {
  const s = new State(masterGenesis);
  const e = epochOf(GTS) + 1;
  const ts = e * EPOCH_MS + 10;
  assert.equal(s.ingestObservation(heartbeat(m1, ts, 0, [miner.address])).ok, true);
  assert.equal(s.ingestObservation(heartbeat(m2, ts, 0, [miner.address])).ok, true);
  assert.equal(s.ingestObservation(heartbeat(m3, ts, 0, [miner.address])).ok, true);
  assert.equal(s.ingestObservation(heartbeat(miner, ts, 50)).ok, true);
  s.advance(at(e));
  assert.ok((s.accounts.get(miner.address)?.lastWorkEpoch ?? -1) >= e, "the vouch credited the miner's work epoch");
  assert.equal(s.balanceOf(miner.address), 0, "but base emission does not pay the miner; masters earn it");
  assert.ok(s.balanceOf(m1.address) > 0, "the genesis masters earned the base emission");
});

test("two replicas ingesting the same observations in different orders reach the IDENTICAL state root", () => {
  const e = epochOf(GTS) + 1;
  const ts = e * EPOCH_MS + 10;
  const obs = [
    heartbeat(m1, ts, 0, [miner.address]),
    heartbeat(m2, ts, 0, [miner.address]),
    heartbeat(m3, ts, 0, [miner.address]),
    heartbeat(miner, ts, 50),
  ];
  const a = new State(masterGenesis); const b = new State(masterGenesis);
  for (const o of obs) a.ingestObservation(o);
  for (const o of [...obs].reverse()) b.ingestObservation(o);
  a.advance(at(e)); b.advance(at(e));
  assert.ok(a.balanceOf(m1.address) > 0, "masters earned on replica A");
  assert.equal(a.stateRoot(), b.stateRoot(), "both replicas computed the same state root");
});

test("DIVERGENT observed contributor sets still produce an IDENTICAL state root", () => {
  // The exact condition that stalled finality: two nodes see different contributor subsets. Replica A also
  // saw a non-master miner heartbeat; replica B never did. Because base emission goes only to the fixed
  // masters and the miner earns nothing (balance 0, filtered out of the root leaf), both must still land on
  // the same emission, the same master balances, and the same state root.
  const e = epochOf(GTS) + 1;
  const ts = e * EPOCH_MS + 10;
  const masterObs = [heartbeat(m1, ts, 0), heartbeat(m2, ts, 0), heartbeat(m3, ts, 0)];

  const a = new State(masterGenesis); const b = new State(masterGenesis);
  for (const o of masterObs) a.ingestObservation(o);
  a.ingestObservation(heartbeat(miner, ts, 50));   // replica A additionally observes the miner
  for (const o of masterObs) b.ingestObservation(o); // replica B does NOT

  a.advance(at(e)); b.advance(at(e));
  assert.ok(a.supply.emitted > 0 && a.supply.emitted === b.supply.emitted, "identical emission despite different observed sets");
  assert.equal(a.balanceOf(m1.address), b.balanceOf(m1.address), "identical master balances");
  assert.equal(a.stateRoot(), b.stateRoot(), "identical state root — emission is independent of the observed contributor set");
});
