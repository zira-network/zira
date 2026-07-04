// node/test/p2p.test.ts
// Real peer to peer: start two ZIRA Core nodes with libp2p, connect node B to node A via bootstrap,
// and prove they gossip events and converge on a finalized Proof of Resonance checkpoint. This is
// the launch critical property, genuine decentralized sync with no central server.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keypairFromPrivate, generateKeypair, standardGenesis, genesisId, signTx, buildTxBody, PROTOCOL } from "@zira/protocol";
import { Libp2pNetwork } from "../src/p2p/Libp2pNetwork.js";
import { topics as buildTopics } from "../src/p2p/topics.js";
import { ZiraNode } from "../src/core/ZiraNode.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const founder = keypairFromPrivate("01".repeat(32)); // devnet steward, becomes the bootstrap master
const genesis = standardGenesis("devnet", founder.address, 1_700_000_000_000);
const gid = genesisId(genesis);
const topicList = buildTopics(gid).all();

test("two nodes gossip events and finalize a checkpoint", { timeout: 280_000 }, async () => {
  const dir = (n: string) => join(tmpdir(), `zira-test-${process.pid}-${n}-${Date.now()}`);

  const netA = new Libp2pNetwork({ p2pPort: 19701, wsPort: 19702, bootstrap: [], announce: [], topics: topicList });
  const nodeA = new ZiraNode(genesis, founder, netA, dir("a"));
  const netB = new Libp2pNetwork({ p2pPort: 19703, wsPort: 19704, bootstrap: [], announce: [], topics: topicList });
  const nodeB = new ZiraNode(genesis, generateKeypair(), netB, dir("b"));
  try {
  await nodeA.start();

  // build A's dialable multiaddr for B to bootstrap to
  const aAddr = nodeA.netInfo().addrs
    .map((a) => a.replace("0.0.0.0", "127.0.0.1"))
    .find((a) => a.includes("/tcp/") && !a.includes("/ws") && a.includes("/p2p/"));
  assert.ok(aAddr, "node A should advertise a dialable multiaddr");

  netB.addBootstrap(aAddr!);
  await nodeB.start();

  // wait for the peers to connect
  for (let i = 0; i < 40 && nodeB.netInfo().peers === 0; i++) await sleep(250);
  assert.ok(nodeB.netInfo().peers > 0, "node B should connect to node A");

  // let the gossipsub mesh graft before publishing
  await sleep(4000);

  // A publishes a signed transaction; B should receive it by gossip (and periodic re-gossip)
  const alice = generateKeypair();
  const ts = Date.now() + PROTOCOL.ACCOUNTING_ROUND_MS; // next epoch
  const tx = signTx(buildTxBody({
    network: "devnet", from: founder.address, fromPubKey: founder.publicKey, to: alice.address,
    amountUZIR: 1_000_000, feeUZIR: PROTOCOL.BASE_FEE_UZIR, nonce: 0, kind: "reserve_grant", parents: [], timestamp: ts,
  }), founder.privateKey);
  const sub = nodeA.submitTx(tx);
  assert.equal(sub.accepted, true);

  let gotTx = false;
  for (let i = 0; i < 60; i++) { if (nodeB.state.knownIds.has("tx:" + tx.id)) { gotTx = true; break; } await sleep(250); }
  assert.ok(gotTx, "node B should receive the gossiped transaction");

  // A is the steward (bootstrap master), so checkpoints should finalize and reach B. Finality trails
  // wall-clock by the epoch GRACE (20s) plus the SETTLE_ROUNDS (8) evidence lag at EPOCH_MS=5s — ~60s, more
  // with mesh-graft and gossip jitter, so allow ~100s. (Loops were written for the old SETTLE_ROUNDS=3.)
  let finalized = false;
  for (let i = 0; i < 400; i++) {
    if (nodeB.checkpoints.lastFinalizedEpoch >= 0) { finalized = true; break; }
    await sleep(250);
  }
  assert.ok(finalized, "node B should see a finalized Proof of Resonance checkpoint from the master");

  // and the alice grant should converge on B once its epoch closes (plus the gossip + settle lag)
  let converged = false;
  for (let i = 0; i < 400; i++) {
    if (nodeB.state.balanceOf(alice.address) === 1_000_000) { converged = true; break; }
    await sleep(250);
  }
  assert.ok(converged, "node B should converge on the transferred balance");
  } finally {
    await nodeA.stop().catch(() => {});
    await nodeB.stop().catch(() => {});
  }
});
