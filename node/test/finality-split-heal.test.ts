// node/test/finality-split-heal.test.ts
// Reproduction of the 2026-07-10 hard-wedge (finality stuck at 356724426): a settler payout reaches only
// SOME masters before its epoch's settle window closes, so they compute a different root, the finality vote
// splits, and — because voteCheckpoints votes each epoch once and never re-votes — the split is permanent.
//
// The fix (per-tick re-gossip of the UNFINALIZED tx window in ZiraNode's tick) must propagate the payout to
// the masters that missed it BEFORE the epoch finalizes, so all four converge on one root and stay live.
//
// We induce the split by applying the payout to a SUBSET of masters via state.ingestTx (which does NOT gossip),
// leaving the others without it. Then we assert the fix backfills it everywhere and finality holds identically.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keypairFromPrivate, generateKeypair, signTx, buildTxBody, standardGenesis, genesisId, PROTOCOL, type GenesisDoc } from "@zira/protocol";
import { Libp2pNetwork } from "../src/p2p/Libp2pNetwork.js";
import { topics as buildTopics } from "../src/p2p/topics.js";
import { ZiraNode } from "../src/core/ZiraNode.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const founder = keypairFromPrivate("0a".repeat(32));
const masters = [
  keypairFromPrivate("71".repeat(32)), keypairFromPrivate("72".repeat(32)),
  keypairFromPrivate("73".repeat(32)), keypairFromPrivate("74".repeat(32)),
];
const genesis: GenesisDoc = {
  ...standardGenesis("devnet", founder.address, 1_700_000_000_000),
  masters: masters.map((k) => ({ address: k.address, pubKey: k.publicKey })),
};
const topicList = buildTopics(genesisId(genesis)).all();
const miner = generateKeypair();

function payout(nonce: number, amt: number) {
  return signTx(buildTxBody({
    network: "devnet", from: masters[0]!.address, fromPubKey: masters[0]!.publicKey, to: miner.address,
    amountUZIR: amt, feeUZIR: PROTOCOL.BASE_FEE_UZIR, nonce, kind: "agent_spend",
    parents: [], timestamp: Date.now(), memo: `split-heal payout ${nonce} general`,
  }), masters[0]!.privateKey);
}

test("a payout applied on only 2 of 4 masters is backfilled to all and finality stays converged (no permanent split)", { timeout: 460_000 }, async () => {
  const dir = (n: string) => join(tmpdir(), `zira-splitheal-${process.pid}-${n}-${Date.now()}`);
  const basePort = 19920;
  const nets: Libp2pNetwork[] = [];
  const nodes: ZiraNode[] = [];
  for (let i = 0; i < masters.length; i++) {
    const net = new Libp2pNetwork({ p2pPort: basePort + i * 2, wsPort: basePort + i * 2 + 1, bootstrap: [], announce: [], topics: topicList });
    nets.push(net);
    nodes.push(new ZiraNode(genesis, masters[i]!, net, dir(`m${i + 1}`)));
  }
  try {
    await nodes[0]!.start();
    const a0 = nodes[0]!.netInfo().addrs.map((a) => a.replace("0.0.0.0", "127.0.0.1"))
      .find((a) => a.includes("/tcp/") && !a.includes("/ws") && a.includes("/p2p/"));
    assert.ok(a0, "settler advertises a dialable multiaddr");
    for (let i = 1; i < nodes.length; i++) { nets[i]!.addBootstrap(a0!); await nodes[i]!.start(); }
    for (let i = 0; i < 80 && nodes.some((n) => n.netInfo().peers === 0); i++) await sleep(250);
    for (const n of nodes) assert.ok(n.netInfo().peers > 0, "every master connected");
    await sleep(4000);

    // fund the settler from base emission
    let funded = false;
    for (let i = 0; i < 400; i++) { if (nodes[0]!.state.balanceOf(masters[0]!.address) > 5_000_000) { funded = true; break; } await sleep(250); }
    assert.ok(funded, "settler accrued base emission");

    const committed = nodes[0]!.state.nonceOf(masters[0]!.address);
    const tx = payout(committed, 250_000);

    // INDUCE THE SPLIT: apply the payout to only masters 0 and 1 (state.ingestTx does NOT gossip it).
    // Masters 2 and 3 have never seen it -> without the fix they vote a different root and the vote splits 2/2.
    nodes[0]!.state.ingestTx(tx);
    nodes[1]!.state.ingestTx(tx);
    assert.equal(nodes[2]!.state.balanceOf(miner.address), 0, "master 3 has not seen the payout yet");
    assert.equal(nodes[3]!.state.balanceOf(miner.address), 0, "master 4 has not seen the payout yet");

    // THE FIX: the per-tick unfinalized-window re-gossip on masters 0/1 must backfill the tx to 2/3, so all
    // four apply it and converge. Give it time to propagate + finalize.
    let healed = false;
    for (let i = 0; i < 1200; i++) {
      if (nodes.every((n) => n.state.balanceOf(miner.address) >= 250_000)) { healed = true; break; }
      await sleep(250);
    }
    assert.ok(healed, "the fix backfilled the payout to every master (no master left behind)");

    // finality must be LIVE and IDENTICAL across all masters (the split healed, not just the balance).
    await sleep(8000);
    const finE = Math.min(...nodes.map((n) => n.checkpoints.lastFinalizedEpoch));
    assert.ok(finE > 0, "finality is live on every master");
    const roots = nodes.map((n) => n.state.stateRoot());
    console.log("miner balances:", nodes.map((n) => n.state.balanceOf(miner.address)));
    console.log("finalizedEpochs:", nodes.map((n) => n.checkpoints.lastFinalizedEpoch));
    console.log("roots:", roots.map((r) => r.slice(0, 12)));
    for (const r of roots) assert.equal(r, roots[0], "all masters converge to one identical root (no fork)");
  } finally {
    for (const n of nodes) { try { await n.stop(); } catch { /* */ } }
    for (const net of nets) { try { await net.stop(); } catch { /* */ } }
  }
});
