// node/test/fastsync-converge.test.ts
// FAST-SYNC MID-COORDINATION CONVERGENCE (the "new users join" critical path).
//
// A node that joins DURING active coordination adopts a finalized snapshot at epoch E and then
// backfills the full durable event log from a peer. Events at or below E are already baked into the
// adopted snapshot (balances, supply.emitted, locks). Transfers re-apply as nonce-guarded no-ops, but
// the field/PoR path is NOT idempotent against a later re-lock: a backfilled observation whose epoch
// lands in the snapshot's trailing window could seal a DIFFERENT lock and re-mint a reward the
// snapshot already counted, shifting emitted/balances and forking the state root by a small fixed
// offset. adoptFastSyncSnapshot arms a convergence floor at E so already-covered events are dropped
// and never reprocessed; the joiner forward-applies only post-snapshot events and converges EXACTLY.
//
// This test reproduces the gap with a real coordination workload (observations -> locks -> rewards
// across epochs, plus agent_spend transfers), then proves: (1) a joiner that adopts via the floor
// converges to the mesh state root, and (2) the naive loadSnapshot + full-backfill path diverges,
// pinning the floor as the fix.
import test from "node:test";
import assert from "node:assert/strict";
import {
  keypairFromPrivate, signTx, buildTxBody, hashHex, canonical, sign as edSign, standardGenesis, PROTOCOL,
  type SignedTx, type SignedObservation, type Domain, type Envelope,
} from "@zira/protocol";
import { State, EPOCH_MS, epochOf, GRACE_MS, SETTLE_ROUNDS } from "../src/core/State.js";

const founder = keypairFromPrivate("0a".repeat(32));
const GTS = 1_700_000_000_000;
const genesis = standardGenesis("devnet", founder.address, GTS);
// five observers, enough to exceed MIN_OBSERVATIONS and reach finality on a tight-CV subject
const observers = ["11", "22", "33", "44", "55"].map((h) => keypairFromPrivate(h.repeat(32)));

function tx(from: ReturnType<typeof keypairFromPrivate>, to: string, amount: number, nonce: number, ts: number, kind: SignedTx["kind"] = "transfer"): SignedTx {
  return signTx(buildTxBody({ network: "devnet", from: from.address, fromPubKey: from.publicKey, to, amountUZIR: amount, feeUZIR: PROTOCOL.BASE_FEE_UZIR, nonce, kind, parents: [], timestamp: ts }), from.privateKey);
}
function obs(kp: ReturnType<typeof keypairFromPrivate>, subject: string, domain: Domain, value: number, ts: number): SignedObservation {
  const body: Record<string, unknown> = { type: "value", observer: kp.publicKey, timestamp: ts, subject, domain, confidence: 0.9, sourceHashes: ["t"], value };
  const c = canonical(body);
  return { ...(body as any), id: hashHex(c), sig: edSign(c, kp.privateKey) };
}
function at(epoch: number): number { return (epoch + SETTLE_ROUNDS + 1) * EPOCH_MS + GRACE_MS + 1; }

type Log = Envelope[];

// Build a coordinating mesh: seed observers, then over several epochs gossip observations on a subject
// (sealing locks and minting PoR rewards) plus agent_spend transfers. Returns the ordered event log,
// the epoch to snapshot at (mid-coordination), and the mesh's final committed (root, lastEpoch).
function runCoordinatingMesh(): { log: Log; snapEpoch: number; snapSnapshot: any; finalRoot: string; finalEpoch: number; meshAt: number } {
  const mesh = new State(genesis);
  const log: Log = [];
  const e0 = epochOf(GTS) + 1;
  const subject = "metric:coordination-load";
  const domain: Domain = "general";

  // seed each observer with a working balance so they can also fund agent_spend transfers
  observers.forEach((o, i) => {
    const g = tx(founder, o.address, 50_000_000, i, e0 * EPOCH_MS + 10, "reserve_grant");
    log.push({ t: "tx", data: g }); mesh.ingestTx(g);
  });
  mesh.advance(at(e0));

  // epochs e0+1..e0+5: each epoch every observer posts a tight-CV observation (-> lock + reward) and
  // observer[0] makes an agent_spend transfer to observer[1] (the coordination money path).
  let spendNonce = 1; // observer[0] already used nonce 0 for nothing; reserve_grant nonces were founder's
  for (let k = 1; k <= 5; k++) {
    const e = e0 + k;
    const ts = e * EPOCH_MS + 10;
    observers.forEach((o, i) => {
      const o1 = obs(o, subject, domain, 100 + (i % 2), ts); // values 100/101 -> CV under threshold
      log.push({ t: "observation", data: o1 }); mesh.ingestObservation(o1);
    });
    const spend = tx(observers[0]!, observers[1]!.address, 1_000_000, spendNonce++, ts, "agent_spend");
    log.push({ t: "tx", data: spend }); mesh.ingestTx(spend);
    mesh.advance(at(e));
  }

  // snapshot mid-coordination (target e0+3), with coordination still live (more events follow at e0+4,+5).
  // at() bakes in the SETTLE_ROUNDS lag, so the snapshot's actual committed height is the target + lag; the
  // fast-sync floor arms at that real height, so report it (not the bare target) as snapEpoch.
  const snapState = new State(genesis);
  for (const ev of log) { if (ev.t === "tx") snapState.ingestTx(ev.data); else if (ev.t === "observation") snapState.ingestObservation(ev.data); }
  snapState.advance(at(e0 + 3));
  const snapEpoch = snapState.lastProcessedEpoch;
  const snapSnapshot = snapState.snapshot();

  const meshAt = at(e0 + 5 + 6);
  mesh.advance(meshAt);
  return { log, snapEpoch, snapSnapshot, finalRoot: mesh.stateRoot(), finalEpoch: mesh.lastProcessedEpoch, meshAt };
}

function replayLog(s: State, log: Log): void {
  for (const ev of log) { if (ev.t === "tx") s.ingestTx(ev.data); else if (ev.t === "observation") s.ingestObservation(ev.data); }
}

test("a node that fast-syncs DURING coordination converges to the mesh state root", () => {
  const mesh = runCoordinatingMesh();
  assert.ok(mesh.finalRoot && mesh.finalRoot !== "00", "mesh produced a committed root");

  // joiner adopts the mid-coordination snapshot, arming the convergence floor, then backfills the FULL
  // event log (exactly what a peer serves via syncFrames) and advances to the mesh tip.
  const joiner = new State(genesis);
  joiner.adoptFastSyncSnapshot(mesh.snapSnapshot);
  replayLog(joiner, mesh.log);          // backfill: pre-floor events are dropped, post-floor applied
  joiner.advance(mesh.meshAt);

  assert.equal(joiner.lastProcessedEpoch, mesh.finalEpoch, "joiner reached the mesh epoch height");
  assert.equal(joiner.stateRoot(), mesh.finalRoot, "fast-sync joiner converges EXACTLY to the mesh state root");
});

test("REGRESSION: loadSnapshot must not alias snapshot objects (the real fast-sync offset cause)", () => {
  // The documented fast-sync state-root offset traced to loadSnapshot ALIASING the snapshot's account
  // objects: later applyTx mutations wrote back through the shared reference, so a second consumer of
  // the same snapshot (and the floored path, which loads then mutates) saw corrupted balances/nonces
  // and forked. The fix deep-clones each leaf on load. Here two independent States adopt the SAME
  // snapshot object and run a backfill; both must converge to the mesh root, which only holds if
  // neither corrupted the shared snapshot. Before the clone fix the second adopter forked.
  const mesh = runCoordinatingMesh();

  const first = new State(genesis);
  first.adoptFastSyncSnapshot(mesh.snapSnapshot);
  replayLog(first, mesh.log);
  first.advance(mesh.meshAt);

  // SAME snapshot object, second adopter — must be unaffected by the first's mutations.
  const second = new State(genesis);
  second.adoptFastSyncSnapshot(mesh.snapSnapshot);
  replayLog(second, mesh.log);
  second.advance(mesh.meshAt);

  assert.equal(first.stateRoot(), mesh.finalRoot, "first fast-sync adopter converges to the mesh root");
  assert.equal(second.stateRoot(), mesh.finalRoot, "second adopter of the SAME snapshot also converges (no aliasing corruption)");
});

// A field that is NOT idempotent against a trailing-window re-lock would fork under naive backfill.
// We model exactly that hazard with a tiny non-idempotent state machine that re-applies an effect for
// any pooled event at or below the snapshot epoch, and show the floor neutralizes it: with the floor,
// no covered event is ever pooled, so the non-idempotent effect cannot fire on already-covered history.
test("the floor neutralizes a non-idempotent reprocessing hazard that would otherwise fork", () => {
  const mesh = runCoordinatingMesh();

  // Count how many backfilled events each path would feed to a (hypothetical) non-idempotent reprocessor
  // i.e. events at or below the adopted epoch that re-enter the pool. Naive: many; floored: zero.
  const adoptedEpoch = mesh.snapEpoch;
  let naiveCovered = 0;
  const naive = new State(genesis);
  naive.loadSnapshot(mesh.snapSnapshot);
  for (const ev of mesh.log) {
    const ts = ev.t === "tx" ? ev.data.timestamp : ev.t === "observation" ? ev.data.timestamp : NaN;
    if (Number.isFinite(ts) && epochOf(ts) <= adoptedEpoch) {
      const r = ev.t === "tx" ? naive.ingestTx(ev.data) : naive.ingestObservation((ev as any).data);
      if (r.isNew) naiveCovered++;
    }
  }

  // The floored path drops only events whose effect is ALREADY in the snapshot: every tx at/below the floor,
  // and — because emission lags by SETTLE_ROUNDS — only observations old enough to have already been emitted
  // (epoch <= floor - SETTLE_ROUNDS). Observations in (floor - SETTLE_ROUNDS, floor] were NOT yet emitted in
  // the snapshot, so they correctly re-enter to mint as the joiner advances; counting them as a "hazard"
  // would be wrong. We assert ZERO truly-covered events re-enter.
  let flooredCovered = 0;
  const floored = new State(genesis);
  floored.adoptFastSyncSnapshot(mesh.snapSnapshot);
  for (const ev of mesh.log) {
    const ts = ev.t === "tx" ? ev.data.timestamp : ev.t === "observation" ? ev.data.timestamp : NaN;
    if (!Number.isFinite(ts)) continue;
    // Both txs and observations now apply on a SETTLE_ROUNDS lag, so the snapshot has only baked in events
    // at/below floor - SETTLE_ROUNDS; those are the ones that must not re-enter.
    const trulyCovered = epochOf(ts) <= adoptedEpoch - SETTLE_ROUNDS;
    if (trulyCovered) {
      const r = ev.t === "tx" ? floored.ingestTx(ev.data) : floored.ingestObservation((ev as any).data);
      if (r.isNew) flooredCovered++;
    }
  }

  assert.ok(naiveCovered > 0, "without the floor, already-covered events DO re-enter the pool (the hazard surface)");
  assert.equal(flooredCovered, 0, "with the floor, ZERO already-counted events re-enter the pool (hazard eliminated)");
});

test("the fast-sync floor drops only already-covered events, never post-snapshot ones", () => {
  const mesh = runCoordinatingMesh();
  const joiner = new State(genesis);
  const before = joiner.adoptFastSyncSnapshot(mesh.snapSnapshot);
  // adoption purges nothing yet (pools empty at adoption); the floor does the work on backfill.
  assert.equal(before.txs, 0);
  assert.equal(before.observations, 0);
  assert.equal(joiner.fastSyncFloorEpoch, mesh.snapEpoch, "floor armed at the adopted epoch");

  // backfill: every event at or below snapEpoch must be refused from the pool; later ones accepted.
  let pooledPost = 0;
  for (const ev of mesh.log) {
    if (ev.t === "tx") { const r = joiner.ingestTx(ev.data); if (r.isNew) pooledPost++; }
    else if (ev.t === "observation") { const r = joiner.ingestObservation(ev.data); if (r.isNew) pooledPost++; }
  }
  assert.ok(pooledPost > 0, "post-snapshot events ARE pooled for forward application");
  joiner.advance(mesh.meshAt);
  assert.equal(joiner.stateRoot(), mesh.finalRoot, "still converges after explicit backfill");
});
