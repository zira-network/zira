// node/test/multi-master-finality.test.ts
// The launch-critical property that the emission-model fix must guarantee: a cluster of genesis masters, each
// gossiping heartbeats over real libp2p, keeps quorum finality LIVE and computes a BYTE-IDENTICAL state root.
// Before the fix, base emission was split among each node's live-observed contributor set and scaled by a
// node-local demand multiplier, so supply.emitted and balances diverged across masters and no root ever
// gathered the 0.67 quorum — finality stalled. Now base emission credits the fixed master set deterministically,
// so every master derives the same root and finality holds. This test proves it end-to-end: 4 masters finalize,
// all 4 state roots match, and emitted is > 0 and IDENTICAL on every master.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keypairFromPrivate, standardGenesis, genesisId, type GenesisDoc } from "@zira/protocol";
import { Libp2pNetwork } from "../src/p2p/Libp2pNetwork.js";
import { topics as buildTopics } from "../src/p2p/topics.js";
import { ZiraNode } from "../src/core/ZiraNode.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const founder = keypairFromPrivate("0a".repeat(32));
// Four non-founder genesis masters (the shape of the real VPS bootstrap quorum).
const masters = [
  keypairFromPrivate("41".repeat(32)),
  keypairFromPrivate("42".repeat(32)),
  keypairFromPrivate("43".repeat(32)),
  keypairFromPrivate("44".repeat(32)),
];
const genesis: GenesisDoc = {
  ...standardGenesis("devnet", founder.address, 1_700_000_000_000),
  masters: masters.map((k) => ({ address: k.address, pubKey: k.publicKey })),
};
const topicList = buildTopics(genesisId(genesis)).all();

test("4 genesis masters keep finality live and compute an identical root + identical emitted supply", { timeout: 240_000 }, async () => {
  const dir = (n: string) => join(tmpdir(), `zira-mmf-${process.pid}-${n}-${Date.now()}`);
  const basePort = 19720;
  const nets: Libp2pNetwork[] = [];
  const nodes: ZiraNode[] = [];
  for (let i = 0; i < masters.length; i++) {
    const net = new Libp2pNetwork({ p2pPort: basePort + i * 2, wsPort: basePort + i * 2 + 1, bootstrap: [], announce: [], topics: topicList });
    nets.push(net);
    nodes.push(new ZiraNode(genesis, masters[i]!, net, dir(`m${i + 1}`)));
  }
  try {
    // Start node 1, then point 2..4 at it so the gossipsub mesh forms a connected cluster.
    await nodes[0]!.start();
    const a0 = nodes[0]!.netInfo().addrs
      .map((a) => a.replace("0.0.0.0", "127.0.0.1"))
      .find((a) => a.includes("/tcp/") && !a.includes("/ws") && a.includes("/p2p/"));
    assert.ok(a0, "node 1 should advertise a dialable multiaddr");
    for (let i = 1; i < nodes.length; i++) {
      nets[i]!.addBootstrap(a0!);
      await nodes[i]!.start();
    }

    // wait for the cluster to connect
    for (let i = 0; i < 80 && nodes.some((n) => n.netInfo().peers === 0); i++) await sleep(250);
    for (const n of nodes) assert.ok(n.netInfo().peers > 0, "every master should connect to the cluster");
    await sleep(4000); // let the gossipsub mesh graft

    // wait until EVERY master has finalized a checkpoint (with 4 masters at trust 1.0, quorum 0.67*4=2.68
    // requires 3 identical roots, so finalization already proves the masters agree on the state root)
    let allFinal = false;
    for (let i = 0; i < 480; i++) {
      if (nodes.every((n) => n.checkpoints.lastFinalizedEpoch >= 0)) { allFinal = true; break; }
      await sleep(250);
    }
    assert.ok(allFinal, "every master should reach a finalized checkpoint (finality did not stall)");

    // Wait for base emission to actually flow. A heartbeat stamped at T is only counted once its epoch enters
    // the settled window at the processing head: ~GRACE_MS (12s) + SETTLE_ROUNDS (15s) + the window offset,
    // so ~30-35s after the first heartbeats. Poll up to 100s, then verify determinism head-on.
    let emittedFlowed = false;
    for (let i = 0; i < 400; i++) {
      if (nodes.every((n) => n.state.supply.emitted > 0)) { emittedFlowed = true; break; }
      await sleep(250);
    }
    assert.ok(emittedFlowed, "base emission should flow to the masters within the settle window");
    await sleep(6000); // let a few more emission epochs finalize so the equality check is meaningful

    const finals = nodes.map((n) => n.checkpoints.lastFinalizedEpoch);
    const emitted = nodes.map((n) => n.state.supply.emitted);
    console.log("finalizedEpochs:", finals);
    console.log("emitted:", emitted);
    console.log("master balances:", masters.map((m) => nodes[0]!.state.balanceOf(m.address)));

    // finality kept advancing on every master (no stall)
    for (const f of finals) assert.ok(f > 0, "finalizedEpoch advanced past genesis on every master");

    // base emission actually flowed to the masters, and it is IDENTICAL across all of them (the fix)
    assert.ok(emitted[0]! > 0, "base emission flowed to the masters");
    for (const e of emitted) assert.equal(e, emitted[0], "emitted is byte-identical across masters");

    // the masters share the same finalized head, so compare their roots AT that shared epoch: pick the min
    // finalized epoch every master has, and assert the finalized root at it matches across the cluster.
    const shared = Math.min(...finals);
    const roots = nodes.map((n) => n.checkpoints.finalized.get(shared)?.stateRoot ?? "MISSING");
    console.log("roots@shared", shared, roots.map((r) => r.slice(0, 12)));
    for (const r of roots) assert.notEqual(r, "MISSING", "every master retains the shared finalized checkpoint");
    for (const r of roots) assert.equal(r, roots[0], "every master computed the same finalized state root");
  } finally {
    for (const n of nodes) await n.stop().catch(() => {});
  }
});
