// node/test/single-finalizer-snapshot.test.ts
// Phase 1 of the full-working plan: validate the single-finalizer pivot.
//
// The recurring mainnet freeze is snapshot-boot finality: 4 co-located masters realigned to a BYTE-IDENTICAL
// snapshot still would not self-finalize forward (they only ever re-adopted the frozen epoch from gossip), so a
// gap opened between processed and finalized and never closed. A SINGLE deterministic finalizer cannot get into
// that state: its own vote is 100% >= 0.67, so it finalizes every epoch it processes, finalized stays glued to
// processed, and a restart from its own snapshot resumes finality immediately with NO peers to agree with.
//
// This test proves that property end-to-end: one finalizer reaches finality from genesis, is stopped, and a
// fresh node booted on the SAME data dir (loading the persisted snapshot, zero peers) advances finality PAST
// where it left off. That is the structural fix the plan is built on.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { keypairFromPrivate, standardGenesis, genesisId, type GenesisDoc } from "@zira/protocol";
import { Libp2pNetwork } from "../src/p2p/Libp2pNetwork.js";
import { topics as buildTopics } from "../src/p2p/topics.js";
import { ZiraNode } from "../src/core/ZiraNode.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const founder = keypairFromPrivate("0a".repeat(32));
// A single genesis master = the deterministic finalizer (leader).
const leader = keypairFromPrivate("51".repeat(32));
const genesis: GenesisDoc = {
  ...standardGenesis("devnet", founder.address, 1_700_000_000_000),
  masters: [{ address: leader.address, pubKey: leader.publicKey }],
};
const topicList = buildTopics(genesisId(genesis)).all();

test("single finalizer resumes finality after a restart from its own snapshot (snapshot-boot property)", { timeout: 180_000 }, async () => {
  const dir = join(tmpdir(), `zira-sf-${process.pid}-${Date.now()}`);

  // Round 1: boot from genesis, reach finality, let a snapshot persist.
  let net = new Libp2pNetwork({ p2pPort: 19760, wsPort: 19761, bootstrap: [], announce: [], topics: topicList });
  let node = new ZiraNode(genesis, leader, net, dir);
  await node.start();
  let fin1 = -1;
  for (let i = 0; i < 120; i++) { fin1 = node.stats().finalizedEpoch; if (fin1 > 0) break; await sleep(500); }
  assert.ok(fin1 > 0, `a lone finalizer reaches finality from genesis (got ${fin1})`);
  // gap must stay ~0 for a single finalizer: it finalizes every epoch it processes
  const s = node.stats();
  assert.ok(s.currentEpoch - s.finalizedEpoch <= 3, `finalized tracks processed (gap ${s.currentEpoch - s.finalizedEpoch})`);
  await sleep(7000); // allow a snapshot write + finality to advance
  const finBefore = node.stats().finalizedEpoch;
  await node.stop(); await net.stop();
  assert.ok(existsSync(join(dir, "snapshot.json")), "a snapshot was persisted for the restart to load");

  // Round 2: fresh node, SAME dir (loads the mid-life snapshot), ZERO peers — must self-finalize forward.
  net = new Libp2pNetwork({ p2pPort: 19762, wsPort: 19763, bootstrap: [], announce: [], topics: topicList });
  node = new ZiraNode(genesis, leader, net, dir);
  await node.start();
  let advanced = false, finAfter = -1;
  for (let i = 0; i < 120; i++) {
    finAfter = node.stats().finalizedEpoch;
    if (finAfter > finBefore) { advanced = true; break; }
    await sleep(500);
  }
  try {
    assert.ok(advanced, `finality must advance past the snapshot epoch after a snapshot-boot with no peers (before=${finBefore}, after=${finAfter})`);
  } finally {
    await node.stop(); await net.stop();
  }
});
