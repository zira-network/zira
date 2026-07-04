// node/test/fastsync.test.ts
// Scalability: a node that joins after history has accrued does not replay everything. It adopts a
// finalized snapshot from a peer and then validates forward. Here node B comes online only AFTER a
// transfer was already processed by A, yet ends up with the correct balance via fast sync.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keypairFromPrivate, generateKeypair, standardGenesis, genesisId, signTx, buildTxBody, PROTOCOL } from "@zira/protocol";
import { Libp2pNetwork } from "../src/p2p/Libp2pNetwork.js";
import { topics as buildTopics } from "../src/p2p/topics.js";
import { ZiraNode } from "../src/core/ZiraNode.js";
import { EPOCH_MS } from "../src/core/State.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const founder = keypairFromPrivate("01".repeat(32));
const genesis = standardGenesis("devnet", founder.address, 1_700_000_000_000);
const topicList = buildTopics(genesisId(genesis)).all();

test("a late joining node fast syncs state from a peer without replaying history", { timeout: 220_000 }, async () => {
  const dir = (n: string) => join(tmpdir(), `zira-fs-${process.pid}-${n}-${Date.now()}`);
  const alice = generateKeypair();

  const netA = new Libp2pNetwork({ p2pPort: 19901, wsPort: 19902, bootstrap: [], announce: [], topics: topicList });
  const nodeA = new ZiraNode(genesis, founder, netA, dir("a"));
  let nodeB: ZiraNode | null = null;
  try {
    await nodeA.start();

    // A processes a grant to alice BEFORE B exists
    const ts = Date.now() + EPOCH_MS;
    const tx = signTx(buildTxBody({
      network: "devnet", from: founder.address, fromPubKey: founder.publicKey, to: alice.address,
      amountUZIR: 7_000_000, feeUZIR: PROTOCOL.BASE_FEE_UZIR, nonce: 0, kind: "reserve_grant", parents: [], timestamp: ts,
    }), founder.privateKey);
    assert.equal(nodeA.submitTx(tx).accepted, true);

    // Wait until A has actually applied it. A tx is settle-lagged by SETTLE_ROUNDS (8) epochs plus the epoch
    // GRACE (20s) so per-epoch state is byte-identical across nodes, so the balance only reflects ~70s after
    // submission at EPOCH_MS=5s. (These waits were written for the old SETTLE_ROUNDS=3 timing.)
    let committed = false;
    for (let i = 0; i < 480; i++) { if (nodeA.state.balanceOf(alice.address) === 7_000_000) { committed = true; break; } await sleep(250); }
    assert.ok(committed, "A commits the grant");
    const aEpoch = nodeA.state.lastProcessedEpoch;

    // NOW bring B online for the first time and bootstrap it to A
    const aAddr = nodeA.netInfo().addrs.map((a) => a.replace("0.0.0.0", "127.0.0.1"))
      .find((a) => a.includes("/tcp/") && !a.includes("/ws") && a.includes("/p2p/"));
    assert.ok(aAddr, "A dialable");
    const netB = new Libp2pNetwork({ p2pPort: 19903, wsPort: 19904, bootstrap: [aAddr!], announce: [], topics: topicList });
    nodeB = new ZiraNode(genesis, generateKeypair(), netB, dir("b"));
    await nodeB.start();

    // B should fast sync to A's state and have alice's balance, without ever processing that epoch
    let synced = false;
    for (let i = 0; i < 200; i++) {
      if (nodeB.state.balanceOf(alice.address) === 7_000_000) { synced = true; break; }
      await sleep(250);
    }
    assert.ok(synced, "B fast syncs alice's balance from A");
    assert.ok(nodeB.state.lastProcessedEpoch >= aEpoch, "B adopted A's epoch height");
  } finally {
    await nodeA.stop().catch(() => {});
    await nodeB?.stop().catch(() => {});
  }
});
