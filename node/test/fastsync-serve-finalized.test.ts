// node/test/fastsync-serve-finalized.test.ts
// REGRESSION GUARD for the "fast-sync broken network-wide" bug (2026-07-12).
//
// serveSnapshot() must send a state that hashes to the finalized checkpoint root it is paired with. The
// bug: it sent the node's CURRENT/HEAD state (state.snapshot()) alongside the LAGGED finalized root/votes.
// Because finality lags the applied head (settle-lag + single-finalizer finalizing every epoch while the
// head keeps advancing), computeStateRoot(head) != finalizedRoot, so every joiner's verifyFastSyncSnapshot
// rejected the snapshot (ROOT MISMATCH) and fell back to genesis replay -> "Connected" pointer with WRONG
// local balances. The fix caches the snapshot keyed by the root computed at that epoch and serves the entry
// for lastFinalizedRoot.
//
// This test pins the invariant at the State level (no network): a snapshot captured at a finalized epoch
// hashes to THAT epoch's root, the head has since drifted to a DIFFERENT root, and only the captured
// snapshot — not the head — is valid to serve with the finalized root. That is exactly what the
// serveSnapshot cache-by-root must preserve.
import test from "node:test";
import assert from "node:assert/strict";
import {
  keypairFromPrivate, signTx, buildTxBody, hashHex, canonical, sign as edSign, standardGenesis,
  computeStateRoot, PROTOCOL, type SignedTx, type SignedObservation, type Domain,
} from "@zira/protocol";
import { State, EPOCH_MS, epochOf, GRACE_MS, SETTLE_ROUNDS } from "../src/core/State.js";

const founder = keypairFromPrivate("0a".repeat(32));
const GTS = 1_700_000_000_000;
const genesis = standardGenesis("devnet", founder.address, GTS);
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
function rootOfSnapshot(snap: any): string {
  return computeStateRoot(snap.accounts, snap.supply, snap.founders ?? [], snap.anchors ?? [], snap.validators ?? [], snap.lastPoolPayoutBucket ?? 0);
}

// Advance a coordinating state, capturing a snapshot at a "finalized" epoch mid-coordination, then advance
// the head further while coordination + transfers keep mutating balances so the head root genuinely drifts
// away from the finalized one (exactly like a live master minting/settling every epoch).
function build() {
  const s = new State(genesis);
  const e0 = epochOf(GTS) + 1;
  let fnonce = 0;
  observers.forEach((o) => s.ingestTx(tx(founder, o.address, 50_000_000, fnonce++, e0 * EPOCH_MS + 10, "reserve_grant")));
  s.advance(at(e0));
  const subject = "metric:load"; const domain: Domain = "general";
  for (let k = 1; k <= 2; k++) {
    const ts = (e0 + k) * EPOCH_MS + 10;
    observers.forEach((o, i) => s.ingestObservation(obs(o, subject + ":" + k, domain, 100 + (i % 2), ts)));
    s.advance(at(e0 + k));
  }
  // "finalized" point: capture the snapshot + its root here (deep copy, exactly like the serve cache).
  const finalizedRoot = s.stateRoot();
  const finalizedSnap = JSON.parse(JSON.stringify(s.snapshot()));
  const finalizedEpoch = s.lastProcessedEpoch;

  // The HEAD then advances with a guaranteed-mutating transfer (founder -> a fresh address), so the head
  // state root deterministically differs from the finalized one — exactly like a live master whose per-epoch
  // mint/settle keeps moving balances after each checkpoint finalizes.
  const fresh = keypairFromPrivate("ab".repeat(32)).address;
  const hts = (finalizedEpoch + 2) * EPOCH_MS + 10;
  s.ingestTx(tx(founder, fresh, 7_777_777, fnonce++, hts, "transfer"));
  s.advance(at(finalizedEpoch + 2 + SETTLE_ROUNDS + 2));
  const headRoot = s.stateRoot();
  const headSnap = s.snapshot();
  return { finalizedRoot, finalizedSnap, finalizedEpoch, headRoot, headSnap };
}

test("the head drifts away from the finalized root (this is why serving head+finalizedRoot fails)", () => {
  const b = build();
  assert.notEqual(b.headRoot, b.finalizedRoot, "head advanced to a different root than the finalized checkpoint");
  // The OLD serveSnapshot served headSnap paired with finalizedRoot -> mismatch -> rejected everywhere.
  assert.notEqual(rootOfSnapshot(b.headSnap), b.finalizedRoot, "serving the HEAD snapshot with the finalized root is a ROOT MISMATCH (the bug)");
});

test("the cached finalized snapshot hashes EXACTLY to the finalized root (what serveSnapshot must send)", () => {
  const b = build();
  // The fix caches snapshot() keyed by the root computed at that epoch; serving that entry with
  // finalizedRoot passes the joiner's verifier line-290 root check.
  assert.equal(rootOfSnapshot(b.finalizedSnap), b.finalizedRoot, "cached finalized snapshot hashes to the finalized root it is served with");
  // And the deep copy is immune to later head mutation: its root did not follow the head.
  assert.notEqual(rootOfSnapshot(b.finalizedSnap), b.headRoot, "cached snapshot is frozen at the finalized epoch, not the drifting head");
});

test("a joiner adopting the cached finalized snapshot lands on the finalized epoch height", () => {
  const b = build();
  const joiner = new State(genesis);
  joiner.adoptFastSyncSnapshot(b.finalizedSnap);
  assert.equal(joiner.lastProcessedEpoch, b.finalizedEpoch, "joiner adopts at the finalized epoch, ready to backfill the tail");
  assert.equal(joiner.stateRoot(), b.finalizedRoot, "joiner's adopted state hashes to the finalized root (correct balances, not genesis-replay garbage)");
});
