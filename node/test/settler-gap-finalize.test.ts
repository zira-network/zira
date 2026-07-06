// node/test/settler-gap-finalize.test.ts
// MULTI-NODE reproduction of the 2026-07-06 live failure: the settler's payouts apply on the settler's own node
// but never FINALIZE across the master set, so miners are not really credited. The single-State tests passed
// because they never exercised the cross-master finalize path. This spins up 4 real masters and checks:
//   (A) a payout at a GAP nonce (committed nonce left empty) never finalizes anywhere (the wedge), and
//   (B) once the committed-nonce HOLE is filled, the whole queue drains and the miner is paid byte-identically
//       on EVERY master (the fix contract: fill the CONSENSUS hole, not a local-only one).
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
  keypairFromPrivate("61".repeat(32)), keypairFromPrivate("62".repeat(32)),
  keypairFromPrivate("63".repeat(32)), keypairFromPrivate("64".repeat(32)),
];
const genesis: GenesisDoc = {
  ...standardGenesis("devnet", founder.address, 1_700_000_000_000),
  masters: masters.map((k) => ({ address: k.address, pubKey: k.publicKey })),
};
const topicList = buildTopics(genesisId(genesis)).all();
const miner = generateKeypair();

function payout(nonce: number, amt: number): ReturnType<typeof signTx> {
  return signTx(buildTxBody({
    network: "devnet", from: masters[0]!.address, fromPubKey: masters[0]!.publicKey, to: miner.address,
    amountUZIR: amt, feeUZIR: PROTOCOL.BASE_FEE_UZIR, nonce, kind: "agent_spend",
    parents: [], timestamp: Date.now(), memo: `coordination payout gap-${nonce} general`,
  }), masters[0]!.privateKey);
}

test("a settler payout stuck behind a nonce gap never finalizes, but filling the committed-nonce hole drains it on every master", { timeout: 460_000 }, async () => {
  const dir = (n: string) => join(tmpdir(), `zira-gapfin-${process.pid}-${n}-${Date.now()}`);
  const basePort = 19882;
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

    let funded = false;
    for (let i = 0; i < 400; i++) { if (nodes[0]!.state.balanceOf(masters[0]!.address) > 5_000_000) { funded = true; break; } await sleep(250); }
    assert.ok(funded, "the settler accrued base emission to fund payouts");

    const committed = nodes[0]!.state.nonceOf(masters[0]!.address);

    // (A) THE WEDGE: submit payouts at committed+1 and committed+2, leaving the committed nonce EMPTY (a gap).
    nodes[0]!.submitTx(payout(committed + 1, 300_000));
    nodes[0]!.submitTx(payout(committed + 2, 300_000));
    // give it plenty of time to (fail to) settle + finalize.
    for (let i = 0; i < 200; i++) { if (nodes.every((n) => n.state.balanceOf(miner.address) > 0)) break; await sleep(250); }
    assert.equal(nodes[0]!.state.balanceOf(miner.address) > 0, false, "gap payouts must NOT finalize (miner unpaid) while the committed nonce is empty");

    // (B) THE FIX: fill the committed-nonce hole. Now the whole queue must drain and finalize on EVERY master.
    nodes[0]!.submitTx(payout(committed, 300_000));
    let paid = false;
    for (let i = 0; i < 1400; i++) { if (nodes.every((n) => n.state.balanceOf(miner.address) >= 900_000)) { paid = true; break; } await sleep(250); }
    assert.ok(paid, "after the hole is filled, all three payouts finalize and the miner is paid on every master");

    await sleep(6000);
    const bals = nodes.map((n) => n.state.balanceOf(miner.address));
    console.log("miner balances across masters:", bals);
    for (const b of bals) assert.equal(b, bals[0], "miner balance is byte-identical across masters (no fork)");
    const finals = nodes.map((n) => n.checkpoints.lastFinalizedEpoch);
    const shared = Math.min(...finals);
    const roots = nodes.map((n) => n.checkpoints.finalized.get(shared)?.stateRoot ?? "MISSING");
    console.log("roots@shared", shared, roots.map((r) => r.slice(0, 12)));
    for (const r of roots) assert.equal(r, roots[0], "every master computed the same finalized root");
  } finally {
    for (const n of nodes) await n.stop().catch(() => {});
  }
});
