// node/test/master-settler-finality.test.ts
// Miner-earning safety: the network settler (first genesis master) funds autonomous-coordination payouts by
// creating agent_spend txs from the base emission it earns. This test proves that a single master creating a
// stream of real coordination payout txs keeps quorum finality BYTE-IDENTICAL across all masters (the concern
// that once kept master-funded settlement disabled) AND that the paid miner's balance is identical on every
// master. If this holds, miners can earn coordination pay on the live network with no steward online.
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
  keypairFromPrivate("51".repeat(32)),
  keypairFromPrivate("52".repeat(32)),
  keypairFromPrivate("53".repeat(32)),
  keypairFromPrivate("54".repeat(32)),
];
const genesis: GenesisDoc = {
  ...standardGenesis("devnet", founder.address, 1_700_000_000_000),
  masters: masters.map((k) => ({ address: k.address, pubKey: k.publicKey })),
};
const topicList = buildTopics(genesisId(genesis)).all();
const miner = generateKeypair(); // the paid coordination contributor

test("the network settler funds coordination payouts without breaking finality", { timeout: 260_000 }, async () => {
  const dir = (n: string) => join(tmpdir(), `zira-msf-${process.pid}-${n}-${Date.now()}`);
  const basePort = 19772;
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

    // wait until the settler (masters[0]) has accrued enough base emission to fund payouts
    let funded = false;
    for (let i = 0; i < 400; i++) {
      if (nodes[0]!.state.balanceOf(masters[0]!.address) > 5_000_000) { funded = true; break; }
      await sleep(250);
    }
    assert.ok(funded, "the settler accrued base emission to fund payouts");

    // the settler streams real coordination payout txs to the miner (exactly the shape settleQueryCoordination
    // emits: agent_spend, positive amount, base fee, coordination-payout memo), one per second for a while.
    let nonce = nodes[0]!.state.provisionalNonce(masters[0]!.address);
    for (let k = 0; k < 8; k++) {
      const tx = signTx(buildTxBody({
        network: "devnet", from: masters[0]!.address, fromPubKey: masters[0]!.publicKey, to: miner.address,
        amountUZIR: 200_000, feeUZIR: PROTOCOL.BASE_FEE_UZIR, nonce: nonce++, kind: "agent_spend",
        parents: [], timestamp: Date.now(), memo: `coordination payout test-${k} general`,
      }), masters[0]!.privateKey);
      nodes[0]!.submitTx(tx);
      await sleep(1000);
    }

    // let the payouts settle through the lagged tx window and a few more epochs finalize
    let paid = false;
    for (let i = 0; i < 320; i++) {
      if (nodes.every((n) => n.state.balanceOf(miner.address) > 0)) { paid = true; break; }
      await sleep(250);
    }
    assert.ok(paid, "the miner was paid on every master");
    await sleep(8000);

    const finals = nodes.map((n) => n.checkpoints.lastFinalizedEpoch);
    const minerBal = nodes.map((n) => n.state.balanceOf(miner.address));
    const emitted = nodes.map((n) => n.state.supply.emitted);
    console.log("finalizedEpochs:", finals);
    console.log("miner balances:", minerBal);
    console.log("emitted:", emitted);

    for (const f of finals) assert.ok(f > 0, "finality advanced on every master (no stall from settler txs)");
    // the paid miner's balance is identical and positive on every master
    assert.ok(minerBal[0]! > 0, "the miner earned coordination pay");
    for (const b of minerBal) assert.equal(b, minerBal[0], "miner balance is byte-identical across masters");

    // roots at the shared finalized epoch match across the cluster
    const shared = Math.min(...finals);
    const roots = nodes.map((n) => n.checkpoints.finalized.get(shared)?.stateRoot ?? "MISSING");
    console.log("roots@shared", shared, roots.map((r) => r.slice(0, 12)));
    for (const r of roots) assert.equal(r, roots[0], "every master computed the same finalized state root");
  } finally {
    for (const n of nodes) await n.stop().catch(() => {});
  }
});
