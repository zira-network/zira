// node/test/settler-idempotent-filler.test.ts
// Regression for the 2026-07-10 finality freeze. The pure-gap watchdog (unstickSettlerNonce) re-fills the
// settler's empty committed nonce, but the old filler used `timestamp: now`, so each re-issue (and every
// restart) minted a DIFFERENT tx id at the SAME nonce. On the live 4-master mainnet, different masters applied
// different fillers and forked the head root — finality froze at the epoch after the gap and no realign could
// cross it. The fix: choose the filler timestamp ONCE per stuck committed nonce and PERSIST it, so every
// re-issue (across restarts and across a settler-failover) rebuilds the byte-identical tx. One tx per nonce =>
// it can never fork. These tests pin (a) same-node re-issue idempotency, (b) restart idempotency via the
// persisted timestamp, and (c) the SETTLER_PAUSE recovery lever that issues nothing.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keypairFromPrivate, generateKeypair, signTx, standardGenesis } from "@zira/protocol";
import { ZiraNode } from "../src/core/ZiraNode.js";
import { EPOCH_MS, epochOf, GRACE_MS, SETTLE_ROUNDS } from "../src/core/State.js";
import type { ZiraNetwork } from "../src/p2p/Network.js";

const founder = keypairFromPrivate("0a".repeat(32)); // on a devnet with no masters, the founder IS the settler
const GTS = 1_700_000_000_000;

function fakeNet(): ZiraNetwork {
  return {
    start: async () => {}, stop: async () => {}, publish: async () => {}, onMessage: () => {},
    setSyncProvider: () => {}, onSyncFrame: () => {}, handle: () => {}, request: async () => [],
    onPeerConnect: () => {}, dial: async () => {}, multiaddrs: () => [], peerId: () => "test-peer",
    peerCount: () => 0, peers: () => [], seedPeers: () => [],
  } as unknown as ZiraNetwork;
}
const at = (epoch: number): number => (epoch + SETTLE_ROUNDS + 2) * EPOCH_MS + GRACE_MS + 1;
const STUCK_MS = Number(process.env.ZIRA_SETTLER_NONCE_STUCK_MS ?? 120_000);

// Build a pure gap (payouts at committed+1/+2, nothing at the committed nonce) on a fresh node in `dir`.
function wedge(dir: string): { node: ZiraNode; committed: number } {
  const genesis = standardGenesis("devnet", founder.address, GTS);
  const node = new ZiraNode(genesis, founder, fakeNet(), dir, {});
  const s = node.state;
  const miner = generateKeypair();
  const committed = s.nonceOf(founder.address);
  const gapTs = (epochOf(GTS) + 2) * EPOCH_MS + 5;
  const payout = (nonce: number) => signTx({
    network: genesis.network, from: founder.address, fromPubKey: founder.publicKey, to: founder.address,
    amountUZIR: 1_000_000, feeUZIR: 1000, nonce, kind: "batch_transfer", parents: [], timestamp: gapTs,
    memo: JSON.stringify({ o: [[miner.address, 1_000_000]] }),
  }, founder.privateKey);
  s.ingestTx(payout(committed + 1));
  s.ingestTx(payout(committed + 2));
  s.advance(at(epochOf(GTS) + 7));
  assert.equal(s.nonceOf(founder.address), committed, "committed nonce is a pure gap");
  return { node, committed };
}

const unstick = (node: ZiraNode, now: number) => (node as unknown as { unstickSettlerNonce(now: number): void }).unstickSettlerNonce(now);

test("the pure-gap filler is byte-identical across re-issues (same stuck timestamp, not `now`)", () => {
  const dir = join(tmpdir(), `zira-idem-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const { node } = wedge(dir);
  const now1 = at(epochOf(GTS) + 7);
  unstick(node, now1);                       // mark the stuck nonce
  unstick(node, now1 + STUCK_MS + 1);        // fires: chooses + persists the filler timestamp
  const first = node.settlerProgress().stuckFiller;
  assert.ok(first, "a filler timestamp was chosen for the stuck nonce");
  // A later re-issue (still wedged, past the throttle window) must NOT pick a new timestamp — the whole point.
  unstick(node, now1 + 3 * STUCK_MS);
  const second = node.settlerProgress().stuckFiller;
  assert.deepEqual(second, first, "re-issuing the filler reuses the SAME persisted timestamp (idempotent)");
});

test("a restarted settler rebuilds the identical filler from the persisted timestamp", () => {
  const dir = join(tmpdir(), `zira-idem-rs-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const a = wedge(dir);
  const now1 = at(epochOf(GTS) + 7);
  unstick(a.node, now1);
  unstick(a.node, now1 + STUCK_MS + 1);
  const chosen = a.node.settlerProgress().stuckFiller;
  assert.ok(chosen, "filler timestamp chosen");

  // Restart: a fresh node from the same data dir restores the persisted stuckFiller (start() calls
  // restoreSettlerProgress; we invoke it directly to avoid spinning up the full network stack in a unit test),
  // so the next unstick rebuilds the byte-identical tx instead of a fresh `now`-stamped one (the fork the live
  // incident hit).
  const genesis = standardGenesis("devnet", founder.address, GTS);
  const b = new ZiraNode(genesis, founder, fakeNet(), dir, {});
  (b as unknown as { restoreSettlerProgress(): void }).restoreSettlerProgress();
  assert.deepEqual(b.settlerProgress().stuckFiller, chosen, "restart restores the SAME filler timestamp from disk");
});

test("SETTLER_PAUSE issues no filler at all (pure-emission recovery lever)", () => {
  const dir = join(tmpdir(), `zira-idem-pz-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env.ZIRA_SETTLER_PAUSE = "1";
  try {
    const { node } = wedge(dir);
    const now1 = at(epochOf(GTS) + 7);
    unstick(node, now1);
    unstick(node, now1 + STUCK_MS + 1);
    assert.equal(node.settlerProgress().stuckFiller, null, "a paused settler chooses no filler and issues nothing");
  } finally {
    delete process.env.ZIRA_SETTLER_PAUSE;
  }
});
