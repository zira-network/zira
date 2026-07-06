// node/test/settler-nonce-pure-gap.test.ts
// The "pure gap" variant of the 2026-07-05 settler payout freeze: the settler's committed nonce has NO tx (a
// tx there was dropped and never re-filled), so every payout it issues lands at a FUTURE nonce (a gap) and can
// never apply — the committed nonce is empty, so nothing advances it. The settle-drain skip cannot help (there
// is nothing AT the committed nonce to skip). Recovery must come from the settler itself: unstickSettlerNonce
// detects the stuck committed nonce (with payouts queued above it) and re-issues a minimal payout at EXACTLY
// the committed nonce. This test proves (a) the pure gap wedges payouts and (b) the watchdog fills the hole so
// the queued payouts drain and the miner is finally paid.
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

test("a pure nonce gap wedges the settler's payouts, and the watchdog re-fills the committed nonce to drain them", () => {
  const genesis = standardGenesis("devnet", founder.address, GTS);
  const dir = join(tmpdir(), `zira-puregap-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const node = new ZiraNode(genesis, founder, fakeNet(), dir, {});
  const s = node.state;
  assert.equal(s.settler, founder.address, "founder is the settler on this devnet");
  assert.ok(s.balanceOf(founder.address) > 1_000_000, "settler holds the devnet reserve");

  const miner = generateKeypair();
  const committed = s.nonceOf(founder.address);
  const gapEpoch = epochOf(GTS) + 2;
  const gapTs = gapEpoch * EPOCH_MS + 5;

  // Build a PURE GAP: two payouts at committed+1 and committed+2, with NOTHING at the committed nonce.
  const payout = (nonce: number, amt: number) => signTx({
    network: genesis.network, from: founder.address, fromPubKey: founder.publicKey, to: founder.address,
    amountUZIR: amt, feeUZIR: 1000, nonce, kind: "batch_transfer", parents: [], timestamp: gapTs,
    memo: JSON.stringify({ o: [[miner.address, amt]] }),
  }, founder.privateKey);
  assert.equal(s.ingestTx(payout(committed + 1, 1_000_000)).ok, true, "gap payout 1 ingests");
  assert.equal(s.ingestTx(payout(committed + 2, 1_000_000)).ok, true, "gap payout 2 ingests");

  // Settle a few epochs: the gap payouts CANNOT apply (no tx at the committed nonce), so the miner stays unpaid.
  s.advance(at(gapEpoch + 5));
  assert.equal(s.nonceOf(founder.address), committed, "committed nonce is wedged (nothing filled it)");
  assert.equal(s.balanceOf(miner.address), 0, "the queued payouts cannot apply through the pure gap");

  // Run the watchdog. First call marks the stuck nonce; a second call past the stuck window fires the unstick.
  const now1 = at(gapEpoch + 5);
  const stuckMs = Number(process.env.ZIRA_SETTLER_NONCE_STUCK_MS ?? 120_000);
  const call = (n: number) => (node as unknown as { unstickSettlerNonce(now: number): void }).unstickSettlerNonce(n);
  call(now1);                       // mark
  call(now1 + stuckMs + 1);         // fires: submits a payout at the committed nonce

  // Settle: the committed-nonce payout applies, advancing the nonce, and the queued gap payouts drain in order.
  s.advance(at(epochOf(now1 + stuckMs + 1) + 1));
  assert.ok(s.nonceOf(founder.address) > committed, "the watchdog advanced the settler's committed nonce");
  assert.equal(s.balanceOf(miner.address), 2_000_000, "both previously-wedged payouts now credit the miner");
});
