// node/test/storage-vouch.test.ts
// Deterministic storage credit via observation vouching. A genesis master that verified a miner holds +
// serves the model VOUCHES for it inside its signed heartbeat observation (vouchedMiners). runField credits
// any miner vouched by >= MIN_STORAGE_VOUCHERS masters in the converged Lock (sets lastWorkEpoch), which
// unlocks its heartbeat emission. The credit derives from CONVERGED observations every node shares, so it is
// byte-identical across nodes — this is the consensus-safe replacement for the per-master storage_attest tx
// that diverged and froze finality. These tests prove (a) a vouched miner earns, (b) an un-vouched one does
// not, and (c) two independent State replicas reach the IDENTICAL state root (determinism).
import test from "node:test";
import assert from "node:assert/strict";
import {
  keypairFromPrivate, buildObservationBody, canonical, hashHex, sign as edSign, standardGenesis, PROTOCOL,
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

test("a miner vouched by masters in the converged Lock earns heartbeat emission", () => {
  const s = new State(masterGenesis);
  const e = epochOf(GTS) + 1;
  const ts = e * EPOCH_MS + 10;
  // 3 masters converge AND vouch for the miner; the miner also heartbeats with storage.
  assert.equal(s.ingestObservation(heartbeat(m1, ts, 0, [miner.address])).ok, true);
  assert.equal(s.ingestObservation(heartbeat(m2, ts, 0, [miner.address])).ok, true);
  assert.equal(s.ingestObservation(heartbeat(m3, ts, 0, [miner.address])).ok, true);
  assert.equal(s.ingestObservation(heartbeat(miner, ts, 50)).ok, true);
  s.advance(at(e));
  assert.ok(s.balanceOf(miner.address) > 0, "the vouched miner earned round emission");
});

test("an UN-vouched non-master miner earns nothing (vouch is the gate)", () => {
  const s = new State(masterGenesis);
  const e = epochOf(GTS) + 1;
  const ts = e * EPOCH_MS + 10;
  // masters converge but vouch for NOBODY; the miner heartbeats but is not credited.
  assert.equal(s.ingestObservation(heartbeat(m1, ts, 0)).ok, true);
  assert.equal(s.ingestObservation(heartbeat(m2, ts, 0)).ok, true);
  assert.equal(s.ingestObservation(heartbeat(m3, ts, 0)).ok, true);
  assert.equal(s.ingestObservation(heartbeat(miner, ts, 50)).ok, true);
  s.advance(at(e));
  assert.equal(s.balanceOf(miner.address), 0, "no vouch => the miner mints nothing");
});

test("two replicas ingesting the same vouching observations reach the IDENTICAL state root", () => {
  const e = epochOf(GTS) + 1;
  const ts = e * EPOCH_MS + 10;
  const obs = [
    heartbeat(m1, ts, 0, [miner.address]),
    heartbeat(m2, ts, 0, [miner.address]),
    heartbeat(m3, ts, 0, [miner.address]),
    heartbeat(miner, ts, 50),
  ];
  const a = new State(masterGenesis); const b = new State(masterGenesis);
  // Ingest in DIFFERENT orders on the two replicas — the sealed state must still match byte-for-byte.
  for (const o of obs) a.ingestObservation(o);
  for (const o of [...obs].reverse()) b.ingestObservation(o);
  a.advance(at(e)); b.advance(at(e));
  assert.ok(a.balanceOf(miner.address) > 0, "vouched miner earned on replica A");
  assert.equal(a.stateRoot(), b.stateRoot(), "both replicas computed the same state root (deterministic credit)");
});
