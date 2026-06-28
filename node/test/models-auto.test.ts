// node/test/models-auto.test.ts
// Model agnostic mining: miners default to auto mode and the node recommends the authorized field
// model, so a miner does not need to pick one. Peers learn authorized models by gossip.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { keypairFromPrivate, generateKeypair, standardGenesis } from "@zira/protocol";
import { ModelService } from "../src/models/ModelService.js";

const founder = keypairFromPrivate("01".repeat(32));
const genesis = standardGenesis("devnet", founder.address, 1_700_000_000_000);
function netStub() {
  return { peerId: () => "p", peers: () => [], handle() {}, request: async () => [], publish: async () => {},
    onMessage() {}, setSyncProvider() {}, onSyncFrame() {}, onPeerConnect() {}, dial: async () => {},
    start: async () => {}, stop: async () => {}, multiaddrs: () => [], peerCount: () => 0 } as any;
}
function gguf(n: number): string {
  const dir = join(tmpdir(), `zira-ma-${process.pid}-${n}-${Date.now()}`); mkdirSync(dir, { recursive: true });
  const p = join(dir, "m.gguf");
  const bytes = Buffer.alloc(300000 + n, n);
  bytes.write("GGUF", 0, "utf8");
  writeFileSync(p, bytes);
  return p;
}

test("mining defaults to auto, so a miner needs no specific model", async () => {
  const svc = new ModelService(join(tmpdir(), `zira-ma-c-${process.pid}-${Date.now()}`), netStub(), generateKeypair(), founder.address, () => {});
  const s = await svc.status();
  assert.equal(s.mining.mode, "auto");
});

test("the node recommends an authorized field model to auto miners", async () => {
  const announces: any[] = [];
  const f = new ModelService(join(tmpdir(), `zira-ma-f-${process.pid}-${Date.now()}`), netStub(), founder, founder.address, (a) => announces.push(a));
  await f.provide(gguf(1), "Model A");
  await f.provide(gguf(2), "Model B");

  const peer = new ModelService(join(tmpdir(), `zira-ma-p-${process.pid}-${Date.now()}`), netStub(), generateKeypair(), founder.address, () => {});
  assert.equal(peer.recommendedModelId(), null); // nothing known yet
  for (const a of announces) peer.onAnnounce(a);
  const rec = peer.recommendedModelId();
  assert.ok(rec, "a model is recommended once the founder has added one");
  assert.ok(peer.knownModels().some((m) => m.meta.id === rec), "the recommended model is in the field");
});
