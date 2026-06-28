// node/test/models.test.ts
// Prove the peer to peer model field: node A "provides" a model file, it is announced over gossip,
// and node B fetches the file from A in chunks and verifies it by content address. This is how a
// GGUF model the founder supplies gets distributed to peers, with no central host.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { keypairFromPrivate, generateKeypair, standardGenesis, genesisId } from "@zira/protocol";
import { Libp2pNetwork } from "../src/p2p/Libp2pNetwork.js";
import { topics as buildTopics } from "../src/p2p/topics.js";
import { ZiraNode } from "../src/core/ZiraNode.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const founder = keypairFromPrivate("01".repeat(32));
const genesis = standardGenesis("devnet", founder.address, 1_700_000_000_000);
const topicList = buildTopics(genesisId(genesis)).all();

test("a model is provided on one node and replicated by a storage peer over P2P", { timeout: 70_000 }, async () => {
  const dir = (n: string) => join(tmpdir(), `zira-mtest-${process.pid}-${n}-${Date.now()}`);

  const netA = new Libp2pNetwork({ p2pPort: 19801, wsPort: 19802, bootstrap: [], announce: [], topics: topicList });
  const nodeA = new ZiraNode(genesis, founder, netA, dir("a"));
  const netB = new Libp2pNetwork({ p2pPort: 19803, wsPort: 19804, bootstrap: [], announce: [], topics: topicList });
  const nodeB = new ZiraNode(genesis, generateKeypair(), netB, dir("b"));

  try {
    await nodeA.start();
    const aAddr = nodeA.netInfo().addrs.map((a) => a.replace("0.0.0.0", "127.0.0.1"))
      .find((a) => a.includes("/tcp/") && !a.includes("/ws") && a.includes("/p2p/"));
    assert.ok(aAddr, "A should have a dialable address");
    netB.addBootstrap(aAddr!);
    await nodeB.start();

    for (let i = 0; i < 40 && nodeB.netInfo().peers === 0; i++) await sleep(250);
    assert.ok(nodeB.netInfo().peers > 0, "B connects to A");
    await sleep(3000); // mesh

    // build a dummy multi chunk "model" file (2.5 MiB of deterministic bytes)
    const srcDir = dir("src"); mkdirSync(srcDir, { recursive: true });
    const modelPath = join(srcDir, "tiny.gguf");
    const bytes = Buffer.alloc(2_500_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
    bytes.write("GGUF", 0, "utf8");
    writeFileSync(modelPath, bytes);
    const expectHash = createHash("sha256").update(bytes).digest("hex");

    // A provides it to the field
    const meta = await nodeA.models.provide(modelPath, "Tiny Test Model", { quant: "Q4_K_M" });
    assert.equal(meta.id, expectHash, "content address is the sha256 of the file");
    assert.ok(meta.chunkCount > 1, "should be multiple chunks");

    // wait for B to learn the model exists via gossip
    let known = false;
    for (let i = 0; i < 40; i++) { if (nodeB.models.knownModels().some((m) => m.meta.id === meta.id)) { known = true; break; } await sleep(250); }
    assert.ok(known, "B learns about the model from A's announcement");

    // Turning on P2P storage makes B pull the model from A and re-announce itself as a host.
    await nodeB.models.setMining({ storageEnabled: true, storageLimitGb: 1 });
    let replicated = false;
    for (let i = 0; i < 60; i++) {
      const status = await nodeB.models.status();
      if (status.local.some((m) => m.id === meta.id)) { replicated = true; break; }
      await sleep(250);
    }
    assert.ok(replicated, "B auto-replicates and verifies the model after storage is enabled");

    let founderSeesStorageHost = false;
    for (let i = 0; i < 40; i++) {
      const known = nodeA.models.knownModels().find((m) => m.meta.id === meta.id);
      if (known && known.providers >= 2) { founderSeesStorageHost = true; break; }
      await sleep(250);
    }
    assert.ok(founderSeesStorageHost, "A sees B as an additional model host");
  } finally {
    await nodeA.stop().catch(() => {});
    await nodeB.stop().catch(() => {});
  }
});

test("a late storage peer learns an existing model assignment and replicates it", { timeout: 70_000 }, async () => {
  const dir = (n: string) => join(tmpdir(), `zira-mlate-${process.pid}-${n}-${Date.now()}`);

  const netA = new Libp2pNetwork({ p2pPort: 19811, wsPort: 19812, bootstrap: [], announce: [], topics: topicList });
  const nodeA = new ZiraNode(genesis, founder, netA, dir("a"));
  const netB = new Libp2pNetwork({ p2pPort: 19813, wsPort: 19814, bootstrap: [], announce: [], topics: topicList });
  const nodeB = new ZiraNode(genesis, generateKeypair(), netB, dir("b"));

  try {
    await nodeA.start();
    const srcDir = dir("src"); mkdirSync(srcDir, { recursive: true });
    const modelPath = join(srcDir, "late.gguf");
    const bytes = Buffer.alloc(1_500_000, 12);
    bytes.write("GGUF", 0, "utf8");
    writeFileSync(modelPath, bytes);
    const meta = await nodeA.models.provide(modelPath, "Late Join Model", { quant: "Q4_K_M" });

    const aAddr = nodeA.netInfo().addrs.map((a) => a.replace("0.0.0.0", "127.0.0.1"))
      .find((a) => a.includes("/tcp/") && !a.includes("/ws") && a.includes("/p2p/"));
    assert.ok(aAddr, "A should have a dialable address");
    netB.addBootstrap(aAddr!);
    await nodeB.start();

    for (let i = 0; i < 40 && nodeB.netInfo().peers === 0; i++) await sleep(250);
    assert.ok(nodeB.netInfo().peers > 0, "B connects after the model already exists");

    let learned = false;
    for (let i = 0; i < 80; i++) {
      if (nodeB.models.knownModels().some((m) => m.meta.id === meta.id)) { learned = true; break; }
      await sleep(250);
    }
    assert.ok(learned, "B learns the existing model assignment from sync or replayed announcements");

    await nodeB.models.setMining({ storageEnabled: true, storageLimitGb: 1 });
    let replicated = false;
    for (let i = 0; i < 80; i++) {
      if ((await nodeB.models.status()).local.some((m) => m.id === meta.id)) { replicated = true; break; }
      await sleep(250);
    }
    assert.ok(replicated, "late storage peer pulls and verifies the existing model");
  } finally {
    await nodeA.stop().catch(() => {});
    await nodeB.stop().catch(() => {});
  }
});

test("three storage peers replicate an authority-authorized GGUF fixture", { timeout: 100_000 }, async () => {
  const dir = (n: string) => join(tmpdir(), `zira-m3store-${process.pid}-${n}-${Date.now()}`);

  const netFounder = new Libp2pNetwork({ p2pPort: 19821, wsPort: 19822, bootstrap: [], announce: [], topics: topicList });
  const nodeFounder = new ZiraNode(genesis, founder, netFounder, dir("founder"));
  const peers = [
    { net: new Libp2pNetwork({ p2pPort: 19823, wsPort: 19824, bootstrap: [], announce: [], topics: topicList }), node: null as ZiraNode | null },
    { net: new Libp2pNetwork({ p2pPort: 19825, wsPort: 19826, bootstrap: [], announce: [], topics: topicList }), node: null as ZiraNode | null },
    { net: new Libp2pNetwork({ p2pPort: 19827, wsPort: 19828, bootstrap: [], announce: [], topics: topicList }), node: null as ZiraNode | null },
  ];
  for (const p of peers) p.node = new ZiraNode(genesis, generateKeypair(), p.net, dir(`storage-${peers.indexOf(p)}`));

  try {
    await nodeFounder.start();

    const srcDir = dir("src"); mkdirSync(srcDir, { recursive: true });
    const modelPath = join(srcDir, "three-storage.gguf");
    const bytes = Buffer.alloc(768_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17 + 23) & 0xff;
    bytes.write("GGUF", 0, "utf8");
    writeFileSync(modelPath, bytes);
    const expectHash = createHash("sha256").update(bytes).digest("hex");
    const meta = await nodeFounder.models.provide(modelPath, "Three Storage Fixture", { quant: "Q4_K_M" });
    assert.equal(meta.id, expectHash);

    const founderAddr = nodeFounder.netInfo().addrs.map((a) => a.replace("0.0.0.0", "127.0.0.1"))
      .find((a) => a.includes("/tcp/") && !a.includes("/ws") && a.includes("/p2p/"));
    assert.ok(founderAddr, "founder should have a dialable address");

    for (const p of peers) {
      p.net.addBootstrap(founderAddr!);
      await p.node!.start();
      await p.node!.models.setMining({ storageEnabled: true, storageLimitGb: 1 });
    }

    for (const p of peers) {
      for (let i = 0; i < 60 && p.node!.netInfo().peers === 0; i++) await sleep(250);
      assert.ok(p.node!.netInfo().peers > 0, "storage peer connects to founder");
    }

    for (const p of peers) {
      let replicated = false;
      for (let i = 0; i < 80; i++) {
        if ((await p.node!.models.status()).local.some((m) => m.id === meta.id)) { replicated = true; break; }
        await sleep(250);
      }
      assert.ok(replicated, "each storage peer replicates and verifies the model by hash");
    }

    let enoughProviders = false;
    for (let i = 0; i < 60; i++) {
      const known = nodeFounder.models.knownModels().find((m) => m.meta.id === meta.id);
      if (known && known.providers >= 4 && known.ready && known.distributionProgress >= 1) { enoughProviders = true; break; }
      await sleep(250);
    }
    assert.ok(enoughProviders, "founder sees the model distributed beyond the target host count");
  } finally {
    await nodeFounder.stop().catch(() => {});
    for (const p of peers) await p.node?.stop().catch(() => {});
  }
});
