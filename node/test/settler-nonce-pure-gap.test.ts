// node/test/settler-nonce-pure-gap.test.ts
// The "pure gap" variant of the settler payout freeze: the settler's committed nonce has NO tx (a tx there was
// dropped and never re-filled), so every payout it issues lands at a FUTURE nonce (a gap) and can never apply —
// the committed nonce is empty, so nothing advances it. The old cure re-issued a gossiped "filler" tx at the
// committed nonce (unstickSettlerNonce), but its timestamp varied per node/restart, so masters applied
// different fillers and FORKED the head root (the 2026-07-10 freeze). The cure now is a PURE-EPOCH gap-close in
// State.processEpoch: once the gap has aged past the TTL, the sender's nonce is advanced to its lowest pooled
// nonce so the queue applies, with NO gossiped tx to diverge on. This test proves (a) the pure gap wedges
// payouts while young and (b) the deterministic close drains them once aged — no filler, no watchdog call.
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
// Short test-only TTL (ZIRA_TX_GAP_TTL_EPOCHS) so the close fires without advancing 120 epochs. Note `at(E)`
// processes through epoch E + SETTLE_ROUNDS + 1, and the gap is considered once processed >= gapEpoch +
// SETTLE_ROUNDS and closes once processed > gapEpoch + TTL — so with TTL 20, at(gapEpoch+5) is young (considered
// but not closed) and at(gapEpoch+15) is aged (closed).
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

test("a pure nonce gap wedges payouts while young, then the deterministic close drains them once aged (no filler)", () => {
  const prev = process.env.ZIRA_TX_GAP_TTL_EPOCHS;
  process.env.ZIRA_TX_GAP_TTL_EPOCHS = String(TTL);
  try {
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

    // While the gap is YOUNG (considered by the settle-drain but not yet past the TTL), the payouts cannot
    // apply and the miner stays unpaid.
    s.advance(at(gapEpoch + 5));
    assert.equal(s.nonceOf(founder.address), committed, "committed nonce is still wedged while the gap is young");
    assert.equal(s.balanceOf(miner.address), 0, "the queued payouts cannot apply through a young pure gap");

    // Advance past the TTL: processEpoch deterministically closes the hole (no filler tx, no watchdog call),
    // advancing the nonce to the lowest pooled nonce so both queued payouts apply and the miner is paid.
    s.advance(at(gapEpoch + 15));
    assert.ok(s.nonceOf(founder.address) > committed, "the deterministic close advanced the settler's committed nonce");
    assert.equal(s.balanceOf(miner.address), 2_000_000, "both previously-wedged payouts now credit the miner");
    assert.equal(node.settlerProgress().stuckFiller, null, "no filler tx was ever issued (the close is pure-state)");
  } finally {
    if (prev === undefined) delete process.env.ZIRA_TX_GAP_TTL_EPOCHS; else process.env.ZIRA_TX_GAP_TTL_EPOCHS = prev;
  }
});
