// node/test/founder-models.test.ts
// Only active launch authority can add a model to the field. A non-authority provide is refused
// locally, and a model announcement not signed by active authority is rejected by peers.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import { keypairFromPrivate, generateKeypair, standardGenesis, canonical, sign as edSign } from "@zira/protocol";
import { ModelService } from "../src/models/ModelService.js";

const founder = keypairFromPrivate("01".repeat(32));
const genesis = standardGenesis("devnet", founder.address, 1_700_000_000_000);

// a network stub: ModelService only needs peerId/peers/handle for these checks
function netStub() {
  return { peerId: () => "peerX", peers: () => [], handle() {}, request: async () => [], publish: async () => {},
    onMessage() {}, setSyncProvider() {}, onSyncFrame() {}, onPeerConnect() {}, start: async () => {}, stop: async () => {},
    multiaddrs: () => [], peerCount: () => 0 } as any;
}

function tinyGguf(): string {
  const dir = join(tmpdir(), `zira-fm-${process.pid}-${Date.now()}`); mkdirSync(dir, { recursive: true });
  const p = join(dir, "m.gguf");
  const bytes = Buffer.alloc(400000, 9);
  bytes.write("GGUF", 0, "utf8");
  writeFileSync(p, bytes);
  return p;
}

test("a non founder cannot provide a model", async () => {
  const stranger = generateKeypair();
  const svc = new ModelService(join(tmpdir(), `zira-fm-s-${process.pid}-${Date.now()}`), netStub(), stranger, founder.address, () => {});
  await assert.rejects(() => svc.provide(tinyGguf(), "Sneaky"), /only active launch authority/);
});

test("the founder can provide, and the announcement verifies for peers", async () => {
  const announces: any[] = [];
  const svc = new ModelService(join(tmpdir(), `zira-fm-f-${process.pid}-${Date.now()}`), netStub(), founder, founder.address, (a) => announces.push(a));
  const meta = await svc.provide(tinyGguf(), "Official Model", { quant: "Q4_K_M" });
  assert.ok(announces.length >= 1, "an announcement is emitted");
  const a = announces[0];
  // a peer accepts it
  const peer = new ModelService(join(tmpdir(), `zira-fm-p-${process.pid}-${Date.now()}`), netStub(), generateKeypair(), founder.address, () => {});
  assert.equal(peer.onAnnounce(a), true, "peer accepts the authority-signed model");
  assert.ok(peer.knownModels().some((m) => m.meta.id === meta.id));
});

test("an authority wallet can authorize a model even when the node identity is not authority", async () => {
  const announces: any[] = [];
  const nodeIdentity = generateKeypair();
  const svc = new ModelService(join(tmpdir(), `zira-fm-w-${process.pid}-${Date.now()}`), netStub(), nodeIdentity, founder.address, (a) => announces.push(a));
  const buf = Buffer.alloc(1024, 7);
  buf.write("GGUF", 0, "utf8");
  const bytes = buf.toString("base64");
  const input = { url: `data:application/octet-stream;base64,${bytes}`, name: "Wallet Signed Model", quant: "Q4_K_M", domains: ["general"], ts: Date.now() };
  const requestSig = edSign(canonical(input), founder.privateKey);
  const meta = await svc.prepareByUrl(input as any, founder.publicKey, requestSig);
  const manifestSig = edSign(canonical(meta), founder.privateKey);
  const authorized = svc.authorizePrepared(meta, founder.publicKey, manifestSig);
  assert.equal(authorized.id, meta.id);
  assert.ok(announces.length >= 1, "wallet-authorized model announcement is emitted");
});

test("an authority wallet cannot authorize a Git LFS pointer as a model", async () => {
  const nodeIdentity = generateKeypair();
  const svc = new ModelService(join(tmpdir(), `zira-fm-lfs-${process.pid}-${Date.now()}`), netStub(), nodeIdentity, founder.address, () => {});
  const pointer = "version https://git-lfs.github.com/spec/v1\noid sha256:" + "a".repeat(64) + "\nsize 8589934592\n";
  const input = { url: `data:text/plain;base64,${Buffer.from(pointer).toString("base64")}`, name: "Pointer", quant: "Q4_K_M", domains: ["general"], ts: Date.now() };
  const requestSig = edSign(canonical(input), founder.privateKey);
  await assert.rejects(() => svc.prepareByUrl(input as any, founder.publicKey, requestSig), /Git LFS pointer/);
});

test("a peer rejects a model announcement not signed by launch authority", () => {
  const impostor = generateKeypair();
  const peer = new ModelService(join(tmpdir(), `zira-fm-r-${process.pid}-${Date.now()}`), netStub(), generateKeypair(), founder.address, () => {});
  const fakeMeta = { id: "deadbeef", name: "Fake", sizeBytes: 1, chunkSize: 1, chunkCount: 1, ts: 1 };
  const sig = edSign(canonical(fakeMeta), impostor.privateKey);
  const announce = { meta: fakeMeta, founderPubKey: impostor.publicKey, manifestSig: sig, peerId: "p", host: impostor.address, ts: 1 };
  assert.equal(peer.onAnnounce(announce as any), false, "impostor signed model is rejected");
});
