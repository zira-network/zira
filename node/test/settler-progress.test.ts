// node/test/settler-progress.test.ts
// Regression for the 2026-07-04 finality freeze: a settler that RESTARTS must not re-issue a payout for a
// bucket it already settled. The fixed field-participation pool is split among the settler's LIVE vouched-miner
// set, which is smaller right after a restart (fewer peers reconnected), so a restarted settler that re-paid the
// same bucket produced a DIFFERENT batch_transfer — conflicting txs that diverged the masters and froze quorum.
// The cure is a persisted payout watermark (settler-progress.json), restored on start, that makes re-pay a no-op.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keypairFromPrivate, standardGenesis } from "@zira/protocol";
import { Store } from "../src/core/Store.js";
import { ZiraNode } from "../src/core/ZiraNode.js";

const founder = keypairFromPrivate("01".repeat(32));
const genesis = standardGenesis("devnet", founder.address, 1_700_000_000_000);

function netStub() {
  return { peerId: () => "p", peers: () => [], handle() {}, request: async () => [], publish: async () => {},
    onMessage() {}, setSyncProvider() {}, onSyncFrame() {}, onPeerConnect() {}, dial: async () => {},
    start: async () => {}, stop: async () => {}, multiaddrs: () => [], peerCount: () => 0 } as any;
}

test("Store round-trips the settler payout watermarks", () => {
  const dir = join(tmpdir(), `zira-sp-store-${process.pid}-${Date.now()}`);
  const store = new Store(dir);
  assert.equal(store.loadSettlerProgress(), null); // nothing persisted yet
  store.saveSettlerProgress({
    lastParticipationBucket: 5943797,
    lastAutonomousResonanceBucket: 5943797,
    paidResonatorRewards: ["r-a:100", "r-b:100"],
    settledCoordinationQueries: ["q1", "q2", "q3"],
  });
  const back = store.loadSettlerProgress()!;
  assert.equal(back.lastParticipationBucket, 5943797);
  assert.equal(back.lastAutonomousResonanceBucket, 5943797);
  assert.deepEqual(back.paidResonatorRewards, ["r-a:100", "r-b:100"]);
  assert.deepEqual(back.settledCoordinationQueries, ["q1", "q2", "q3"]);
});

test("a restarted settler restores its payout watermark instead of resetting to -1", async () => {
  const dir = join(tmpdir(), `zira-sp-node-${process.pid}-${Date.now()}`);
  // Simulate a settler that has already paid bucket 5943797 (and some resonator/coordination work), as would be
  // on disk after a normal run — the state a crash-restarted settler must NOT re-pay.
  new Store(dir).saveSettlerProgress({
    lastParticipationBucket: 5943797,
    lastAutonomousResonanceBucket: 5943797,
    paidResonatorRewards: ["r-x:5943797"],
    settledCoordinationQueries: ["auto:r-x:5943797"],
  });

  const node = new ZiraNode(genesis, founder, netStub(), dir);
  try {
    await node.start();
    const p = node.settlerProgress();
    // Restored, NOT reset to the -1 in-memory default — so settleFieldParticipation's `bucket <= watermark`
    // guard skips the already-paid bucket after a restart, and no divergent duplicate payout is issued.
    assert.equal(p.lastParticipationBucket, 5943797);
    assert.equal(p.lastAutonomousResonanceBucket, 5943797);
    assert.equal(p.paidResonatorRewards, 1);
    assert.equal(p.settledCoordinationQueries, 1);
  } finally {
    await node.stop().catch(() => {});
  }
});
