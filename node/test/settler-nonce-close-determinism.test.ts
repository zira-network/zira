// node/test/settler-nonce-close-determinism.test.ts
// The determinism proof for the pure-epoch settler nonce-gap CLOSE that replaces the forking filler.
//
// The 2026-07-10 mainnet freeze was a DETERMINISM failure: the old cure re-issued a gossiped "filler" tx at the
// settler's empty committed nonce, but its timestamp was wall-clock `now`, so different masters (and every
// restart) minted a DIFFERENT tx id at the SAME nonce. Masters that applied different fillers computed
// different head roots, split the vote for that epoch, and finality froze forever — no realign could reconcile
// it. The single-node tests never caught it because the fork only shows across independently-fed replicas.
//
// The fix makes the unwedge a pure function of (nonce, tx timestamp, epoch) in State.processEpoch with NO
// gossiped tx. This test reproduces the production condition — several replicas that receive the same payouts
// in DIFFERENT arrival orders and even carry stray/duplicate txs (as real gossip does) — and asserts every
// replica converges to a BYTE-IDENTICAL state root, nonce, and balance once the gap closes. It also pins that a
// predecessor arriving AFTER the close is harmlessly superseded (no late divergence).
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keypairFromPrivate, generateKeypair, signTx, standardGenesis } from "@zira/protocol";
import { ZiraNode } from "../src/core/ZiraNode.js";
import { EPOCH_MS, epochOf, GRACE_MS, SETTLE_ROUNDS } from "../src/core/State.js";
import type { ZiraNetwork } from "../src/p2p/Network.js";

const founder = keypairFromPrivate("0a".repeat(32)); // devnet with no masters => the founder IS the settler
const GTS = 1_700_000_000_000;
// Short test-only TTL so the close fires without advancing 120 epochs. `at(E)` processes through E+9, the gap
// is considered once processed >= gapEpoch+SETTLE_ROUNDS and closes once processed > gapEpoch+TTL, so with
// TTL 20, at(gapEpoch+5) is young and at(gapEpoch+15) is aged (closed).
const TTL = 20;

function fakeNet(): ZiraNetwork {
  return {
    start: async () => {}, stop: async () => {}, publish: async () => {}, onMessage: () => {},
    setSyncProvider: () => {}, onSyncFrame: () => {}, handle: () => {}, request: async () => [],
    onPeerConnect: () => {}, dial: async () => {}, multiaddrs: () => [], peerId: () => "test-peer",
    peerCount: () => 0, peers: () => [], seedPeers: () => [],
  } as unknown as ZiraNetwork;
}
const at = (epoch: number): number => (epoch + SETTLE_ROUNDS + 2) * EPOCH_MS + GRACE_MS + 1;
const miner = generateKeypair();
const gapEpoch = epochOf(GTS) + 2;
const gapTs = gapEpoch * EPOCH_MS + 5;

// A payout naming the miner as the recipient, at an explicit settler nonce. Byte-identical inputs => identical
// tx id on every replica (that is the whole point: real payouts are deterministic; only the OLD filler was not).
function payout(nonce: number, amt: number) {
  return signTx({
    network: "devnet", from: founder.address, fromPubKey: founder.publicKey, to: founder.address,
    amountUZIR: amt, feeUZIR: 1000, nonce, kind: "batch_transfer", parents: [], timestamp: gapTs,
    memo: JSON.stringify({ o: [[miner.address, amt]] }),
  }, founder.privateKey);
}

function freshReplica(tag: string): ZiraNode {
  const dir = join(tmpdir(), `zira-close-det-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return new ZiraNode(standardGenesis("devnet", founder.address, GTS), founder, fakeNet(), dir, {});
}

test("the pure-epoch gap-close converges every replica to one root regardless of tx arrival order", () => {
  const prev = process.env.ZIRA_TX_GAP_TTL_EPOCHS;
  process.env.ZIRA_TX_GAP_TTL_EPOCHS = String(TTL);
  try {
    const p1 = payout(1, 1_000_000); // committed nonce is 0; leave 0 EMPTY => pure gap at 0
    const p2 = payout(2, 1_000_000);

    // Four replicas standing in for four masters, each fed the SAME two gap payouts but in different orders and
    // with duplicate deliveries (exactly what an unsynchronised gossip mesh produces). None ever gets a tx at
    // the empty committed nonce 0.
    const rA = freshReplica("A"); rA.state.ingestTx(p1); rA.state.ingestTx(p2);
    const rB = freshReplica("B"); rB.state.ingestTx(p2); rB.state.ingestTx(p1);                 // reverse order
    const rC = freshReplica("C"); rC.state.ingestTx(p2); rC.state.ingestTx(p1); rC.state.ingestTx(p2); // dup
    const rD = freshReplica("D"); rD.state.ingestTx(p1); rD.state.ingestTx(p2); rD.state.ingestTx(p1); // dup
    const reps = [rA, rB, rC, rD];

    // While young: every replica is wedged (nonce 0, miner unpaid) — identical stalled state.
    for (const r of reps) r.state.advance(at(gapEpoch + 5));
    for (const r of reps) {
      assert.equal(r.state.nonceOf(founder.address), 0, "committed nonce wedged while young");
      assert.equal(r.state.balanceOf(miner.address), 0, "miner unpaid while young");
    }

    // Past the TTL: each replica independently closes the hole in pure state (no gossip between them here).
    for (const r of reps) r.state.advance(at(gapEpoch + 15));

    const root0 = rA.state.stateRoot();
    const nonce0 = rA.state.nonceOf(founder.address);
    const bal0 = rA.state.balanceOf(miner.address);
    assert.ok(nonce0 > 0, "the deterministic close advanced the settler nonce past the empty slot");
    assert.equal(bal0, 2_000_000, "both wedged payouts credited the miner after the close");
    for (const r of reps) {
      assert.equal(r.state.stateRoot(), root0, "every replica computed the SAME state root (no fork)");
      assert.equal(r.state.nonceOf(founder.address), nonce0, "identical settler nonce across replicas");
      assert.equal(r.state.balanceOf(miner.address), bal0, "identical miner balance across replicas");
      assert.equal(r.settlerProgress().stuckFiller, null, "no filler tx was ever issued");
    }
  } finally {
    if (prev === undefined) delete process.env.ZIRA_TX_GAP_TTL_EPOCHS; else process.env.ZIRA_TX_GAP_TTL_EPOCHS = prev;
  }
});

test("a predecessor that arrives AFTER the gap has closed is superseded, not a late fork", () => {
  const prev = process.env.ZIRA_TX_GAP_TTL_EPOCHS;
  process.env.ZIRA_TX_GAP_TTL_EPOCHS = String(TTL);
  try {
    // Replica X closes the gap with only the two future-nonce payouts (nonce 0 never delivered).
    const rX = freshReplica("X"); rX.state.ingestTx(payout(1, 1_000_000)); rX.state.ingestTx(payout(2, 1_000_000));
    rX.state.advance(at(gapEpoch + 15));
    const rootClosed = rX.state.stateRoot();
    const nonceClosed = rX.state.nonceOf(founder.address);

    // Now a very-late predecessor for the empty slot 0 finally shows up over gossip. It is below the committed
    // nonce, so it must be dropped as superseded and change NOTHING (no re-credit, no root change).
    const late = payout(0, 1_000_000);
    rX.state.ingestTx(late);
    rX.state.advance(at(gapEpoch + 22));
    assert.equal(rX.state.nonceOf(founder.address), nonceClosed, "late predecessor does not move the nonce");
    assert.equal(rX.state.balanceOf(miner.address), 2_000_000, "late predecessor does not re-pay the miner");
    assert.equal(rX.state.stateRoot(), rootClosed, "the state root is unchanged by the superseded late tx");
  } finally {
    if (prev === undefined) delete process.env.ZIRA_TX_GAP_TTL_EPOCHS; else process.env.ZIRA_TX_GAP_TTL_EPOCHS = prev;
  }
});
