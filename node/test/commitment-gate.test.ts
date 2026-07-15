// node/test/commitment-gate.test.ts
// Invariant I1 (earning is pay for lending the machine, not for merely being reachable). A community node that
// has NOT committed its hardware (mining off AND storage off) must not answer the reverse liveness challenge
// with its address, so a master never vouches it and the settler never pays it. A committed node (mining OR
// storage on) answers normally and can be vouched. A genesis/earned master always answers, even when running
// light (mining + storage off), so master-to-master liveness and settler failover keep working.
//   challenge -> serveLiveness (commitment-gated) -> address returned only when committed -> vouched -> paid
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keypairFromPrivate, generateKeypair, standardGenesis, type GenesisDoc } from "@zira/protocol";
import { ZiraNode } from "../src/core/ZiraNode.js";
import type { ZiraNetwork } from "../src/p2p/Network.js";

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

function fakeNet(): ZiraNetwork {
  return {
    start: async () => {}, stop: async () => {}, publish: async () => {}, onMessage: () => {},
    setSyncProvider: () => {}, onSyncFrame: () => {}, handle: () => {}, request: async () => [],
    onPeerConnect: () => {}, dial: async () => {}, multiaddrs: () => [], peerId: () => "test-peer",
    peerCount: () => 0, peers: () => [], seedPeers: () => [],
  } as unknown as ZiraNetwork;
}
function nodeFor(id: ReturnType<typeof keypairFromPrivate>, tag: string): ZiraNode {
  const dir = join(tmpdir(), `zira-commit-${process.pid}-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return new ZiraNode(genesis, id, fakeNet(), dir, {});
}
function setCommit(node: ZiraNode, mining: boolean, storage: boolean): void {
  const m = (node as unknown as { models: { mining: { enabled: boolean; storageEnabled: boolean } } }).models.mining;
  m.enabled = mining; m.storageEnabled = storage;
}
async function challenge(node: ZiraNode): Promise<{ address?: string; pubKey?: string; sig?: string; committed?: boolean; ok?: boolean }> {
  const bytes = new TextEncoder().encode(JSON.stringify({ nonce: "test-nonce-123" }));
  const gen = (node as unknown as { serveLiveness(r: Uint8Array, f: string): AsyncIterable<Uint8Array> }).serveLiveness(bytes, "peerX");
  for await (const frame of gen) { return JSON.parse(new TextDecoder().decode(frame)); }
  return {};
}

test("I1: an uncommitted community node (mining off, storage off) returns no address, so it cannot be vouched", async () => {
  const miner = generateKeypair();
  const node = nodeFor(miner, "off");
  setCommit(node, false, false);
  const r = await challenge(node);
  assert.equal(r.address, undefined, "no address means a master will not add it to verifiedMiners");
  assert.equal(r.committed, false, "explicitly flagged uncommitted");
});

test("I1: a committed community node (mining on) answers with its signed address so it can be vouched and paid", async () => {
  const miner = generateKeypair();
  const node = nodeFor(miner, "mine");
  setCommit(node, true, false);
  const r = await challenge(node);
  assert.equal(r.address, miner.address, "answers with its own address");
  assert.ok(r.sig, "and a signature over the nonce");
});

test("I1: a node serving storage (storage on, mining off) is committed and answers", async () => {
  const miner = generateKeypair();
  const node = nodeFor(miner, "store");
  setCommit(node, false, true);
  const r = await challenge(node);
  assert.equal(r.address, miner.address, "storage-serving is lending the machine, so it earns");
});

test("I1: a genesis master always answers even when light (mining + storage off), preserving consensus liveness", async () => {
  const node = nodeFor(masters[0]!, "master");
  setCommit(node, false, false);
  const r = await challenge(node);
  assert.equal(r.address, masters[0]!.address, "masters stay live regardless of the mining toggle");
});
