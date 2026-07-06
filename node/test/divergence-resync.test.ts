// node/test/divergence-resync.test.ts
// Regression for the live incident (2026-07-06): a follower (a home mining node, or the public read gateway) kept
// finalizing the master-signed checkpoint roots normally, yet its own APPLIED state had silently drifted from them
// (it missed a gossiped payout tx). Its balanceOf then under-reported forever, so a node that every master had
// credited looked to its owner like it earned nothing. The finality watchdog never caught it because finalized
// epoch was advancing, not frozen. The fix: every node records its own state root per settle epoch and compares it
// to the finalized consensus root; a follower that disagrees for a few consecutive finalized epochs re-adopts a
// verified master snapshot. These tests pin the trigger: match => never resync, persistent mismatch => resync.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keypairFromPrivate, generateKeypair, standardGenesis, type GenesisDoc } from "@zira/protocol";
import { ZiraNode } from "../src/core/ZiraNode.js";
import type { ZiraNetwork } from "../src/p2p/Network.js";

const founder = keypairFromPrivate("0a".repeat(32));
const masters = [keypairFromPrivate("51".repeat(32)), keypairFromPrivate("52".repeat(32)), keypairFromPrivate("53".repeat(32))];
const genesis: GenesisDoc = {
  ...standardGenesis("devnet", founder.address, 1_700_000_000_000),
  masters: masters.map((k) => ({ address: k.address, pubKey: k.publicKey })),
};

// A net that records the protocols a node requests, so we can see whether a snapshot resync was attempted.
function net(reqLog: string[]): ZiraNetwork {
  return {
    start: async () => {}, stop: async () => {}, publish: async () => {}, onMessage: () => {}, setSyncProvider: () => {},
    onSyncFrame: () => {}, handle: () => {}, onPeerConnect: () => {}, dial: async () => {}, multiaddrs: () => [],
    peerId: () => "self", peerCount: () => 1, peers: () => ["p1"], seedPeers: () => [],
    request: async (_p: string, protocol: string) => { reqLog.push(protocol); return []; },
  } as unknown as ZiraNetwork;
}
function follower(reqLog: string[]): ZiraNode {
  const dir = join(tmpdir(), `zira-div-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  // a random (non-master) identity; fastSync enabled so the divergence watchdog is armed
  return new ZiraNode(genesis, generateKeypair(), net(reqLog), dir, { fastSync: true });
}
type Priv = {
  localRootByEpoch: Map<number, string>;
  checkpoints: { lastFinalizedEpoch: number; lastFinalizedRoot: string };
  maybeResyncOnDivergence(now: number): void;
};
const tick = () => new Promise((r) => setTimeout(r, 60));

test("a follower whose root matches the finalized root never resyncs", async () => {
  const reqLog: string[] = [];
  const n = follower(reqLog) as unknown as Priv;
  for (let e = 100; e < 112; e++) {
    n.localRootByEpoch.set(e, "agree");
    n.checkpoints.lastFinalizedEpoch = e;
    n.checkpoints.lastFinalizedRoot = "agree";
    n.maybeResyncOnDivergence(Date.now());
  }
  await tick();
  assert.equal(reqLog.length, 0, "no snapshot fetch while local root matches consensus");
});

test("a follower whose root disagrees across the trigger streak re-adopts a master snapshot", async () => {
  const reqLog: string[] = [];
  const n = follower(reqLog) as unknown as Priv;
  for (let e = 200; e < 205; e++) {
    n.localRootByEpoch.set(e, "mine-" + e);              // our (diverged) applied-state root
    n.checkpoints.lastFinalizedEpoch = e;
    n.checkpoints.lastFinalizedRoot = "consensus-" + e;  // the master-signed root we finalized but do not match
    n.maybeResyncOnDivergence(Date.now());
  }
  await tick();
  assert.ok(reqLog.length > 0, "a persistently diverged follower attempted a snapshot resync");
});

test("a single divergent epoch below the streak does not resync (no false positive on settle jitter)", async () => {
  const reqLog: string[] = [];
  const n = follower(reqLog) as unknown as Priv;
  // exactly one mismatching finalized epoch, then agreement resumes
  n.localRootByEpoch.set(300, "mine");
  n.checkpoints.lastFinalizedEpoch = 300;
  n.checkpoints.lastFinalizedRoot = "consensus";
  n.maybeResyncOnDivergence(Date.now());
  for (let e = 301; e < 306; e++) {
    n.localRootByEpoch.set(e, "agree");
    n.checkpoints.lastFinalizedEpoch = e;
    n.checkpoints.lastFinalizedRoot = "agree";
    n.maybeResyncOnDivergence(Date.now());
  }
  await tick();
  assert.equal(reqLog.length, 0, "one-off mismatch that then agrees never triggers a resync");
});
