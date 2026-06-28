// node/test/late-join-determinism.test.ts
// LATE-JOIN DETERMINISM: a node that joins after query-fee burns and replays from genesis must converge
// on the SAME committed state root and the SAME supply.burned as the running mesh. The earlier bug: a
// late joiner only received a CAPPED tail of the event log, so it silently dropped early query-fee burns
// and reconstructed a different burned total (e.g. it forked on the burn of early query fees) -> a
// different state root -> a fork. The fix serves the full durable event log to a genesis-replaying peer,
// so the replay is exact. These tests prove convergence and pin the capped-window divergence as the cause.
import test from "node:test";
import assert from "node:assert/strict";
import {
  keypairFromPrivate, signTx, buildTxBody, standardGenesis, PROTOCOL, type SignedTx,
} from "@zira/protocol";
import { State, EPOCH_MS, epochOf, GRACE_MS, SETTLE_ROUNDS } from "../src/core/State.js";

const founder = keypairFromPrivate("0a".repeat(32));
const alice = keypairFromPrivate("0b".repeat(32));
const GTS = 1_700_000_000_000;
const genesis = standardGenesis("devnet", founder.address, GTS);
function at(epoch: number): number { return (epoch + SETTLE_ROUNDS + 1) * EPOCH_MS + GRACE_MS + 1; }
function tx(from: any, to: string, amount: number, nonce: number, ts: number, kind: SignedTx["kind"] = "transfer"): SignedTx {
  return signTx(buildTxBody({ network: "devnet", from: from.address, fromPubKey: from.publicKey, to, amountUZIR: amount, feeUZIR: PROTOCOL.BASE_FEE_UZIR, nonce, kind, parents: [], timestamp: ts }), from.privateKey);
}

// Build a mesh that applies a seed grant + several query-fee-bearing transfers across epochs, returning
// the full ordered event log and the mesh's committed (burned, root).
function runMesh(): { events: SignedTx[]; burned: number; root: string; lastEpoch: number } {
  const mesh = new State(genesis);
  const events: SignedTx[] = [];
  const e1 = epochOf(GTS) + 1;
  const seed = tx(founder, alice.address, 1_000_000_000, 0, e1 * EPOCH_MS + 10, "reserve_grant");
  events.push(seed); mesh.ingestTx(seed); mesh.advance(at(e1));
  // five query-fee-like burns over the next epochs
  for (let i = 0; i < 5; i++) {
    const e = e1 + 1 + i;
    const t = tx(alice, founder.address, 1000, i, e * EPOCH_MS + 10);
    events.push(t); mesh.ingestTx(t); mesh.advance(at(e));
  }
  return { events, burned: mesh.supply.burned, root: mesh.stateRoot(), lastEpoch: epochOf(GTS) + 6 };
}

test("a late joiner that replays the FULL event log converges on the mesh state root and burned", () => {
  const mesh = runMesh();
  assert.ok(mesh.burned > 0, "the mesh accumulated query-fee burns");

  const joiner = new State(genesis);
  for (const ev of mesh.events) joiner.ingestTx(ev);  // full log, as the fixed syncFrames now serves
  joiner.advance(at(mesh.lastEpoch + 5));

  assert.equal(joiner.supply.burned, mesh.burned, "burned converges (no dropped early query-fee burns)");
  assert.equal(joiner.stateRoot(), mesh.root, "state root converges with the mesh");
});

test("REGRESSION: a CAPPED event window forks burned and the state root (the original bug)", () => {
  const mesh = runMesh();
  // simulate the OLD capped tail that dropped the earliest events (e.g. the seed + first burns)
  const capped = new State(genesis);
  for (const ev of mesh.events.slice(3)) capped.ingestTx(ev);
  capped.advance(at(mesh.lastEpoch + 5));
  // with early events missing, burned and the root diverge — this is exactly what the fix prevents
  assert.notEqual(capped.supply.burned, mesh.burned, "a capped window under-counts burns");
  assert.notEqual(capped.stateRoot(), mesh.root, "a capped window forks the state root");
});

test("ingest order does not change the late joiner's converged burned/root", () => {
  const mesh = runMesh();
  const joiner = new State(genesis);
  // ingest the same full log in reverse order: pooling + deterministic epoch processing must converge
  for (const ev of [...mesh.events].reverse()) joiner.ingestTx(ev);
  joiner.advance(at(mesh.lastEpoch + 5));
  assert.equal(joiner.supply.burned, mesh.burned, "burned is order-independent");
  assert.equal(joiner.stateRoot(), mesh.root, "root is order-independent");
});
