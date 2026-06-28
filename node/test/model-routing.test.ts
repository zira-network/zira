// node/test/model-routing.test.ts
// Typed model registry + routing: a model is registered with a modality (type) + domains, and the
// field routes a query in a domain to the matching model TYPE first. Also covers the network-Resonator
// seeding (founder-owned coordinators) and the multi-LLM coordination settlement split.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import {
  keypairFromPrivate, generateKeypair, standardGenesis, PROTOCOL,
  MAINNET_NETWORK_RESONATOR_OWNER, NETWORK_RESONATOR_SPECS, sign as edSign,
} from "@zira/protocol";
import { ZiraNode } from "../src/core/ZiraNode.js";
import { genesisFor } from "../src/genesis-docs.js";

// Local ed25519 sign helper matching addAnswer's verification (queryId + "\n" + answer).
function signFor(kp: { privateKey: string }, msg: string): string { return edSign(msg, kp.privateKey); }

const founder = keypairFromPrivate("01".repeat(32));
const genesis = standardGenesis("devnet", founder.address, 1_700_000_000_000);

function netStub() {
  return { peerId: () => "p", peers: () => [], handle() {}, request: async () => [], publish: async () => {},
    onMessage() {}, setSyncProvider() {}, onSyncFrame() {}, onPeerConnect() {}, dial: async () => {},
    start: async () => {}, stop: async () => {}, multiaddrs: () => [], peerCount: () => 0 } as any;
}

function gguf(dir: string, name: string, fill: number): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const bytes = Buffer.alloc(300_000, fill);
  bytes.write("GGUF", 0, "utf8");
  writeFileSync(path, bytes);
  return path;
}

test("a model registers with a type+domains and the field routes a domain to the right model TYPE", async () => {
  const dir = join(tmpdir(), `zira-route-type-${process.pid}-${Date.now()}`);
  const node = new ZiraNode(genesis, founder, netStub(), dir);

  const codeModel = await node.models.provide(gguf(join(dir, "src"), "code.gguf", 1), "Code Model", { type: "code", domains: ["code"] });
  const textModel = await node.models.provide(gguf(join(dir, "src"), "text.gguf", 2), "Text Model", { type: "text", domains: ["language", "reasoning"] });

  // a code query routes to the code model (preferred type first)
  assert.equal(node.models.modelForDomain("code"), codeModel.id, "code query routes to the code model");
  // a reasoning query routes to the text model
  assert.equal(node.models.modelForDomain("reasoning"), textModel.id, "reasoning query routes to the text model");

  // grouped-by-type view exposes both modalities
  const byType = node.models.modelsByType();
  assert.ok(byType.code?.some((m) => m.id === codeModel.id), "code bucket holds the code model");
  assert.ok(byType.text?.some((m) => m.id === textModel.id), "text bucket holds the text model");

  // knownModels surfaces the type + routing domains on every model
  const known = node.models.knownModels();
  const codeKnown = known.find((m) => m.meta.id === codeModel.id)!;
  assert.equal(codeKnown.meta.type, "code");
  assert.deepEqual(codeKnown.meta.domains, ["code"]);
});

test("a legacy model with no type defaults to text and serves general queries", async () => {
  const dir = join(tmpdir(), `zira-route-legacy-${process.pid}-${Date.now()}`);
  const node = new ZiraNode(genesis, founder, netStub(), dir);
  const legacy = await node.models.provide(gguf(join(dir, "src"), "legacy.gguf", 3), "Legacy Model", {});
  assert.equal(node.models.modelForDomain("general"), legacy.id);
  const known = node.models.knownModels().find((m) => m.meta.id === legacy.id)!;
  assert.equal(known.meta.type, "text", "no type defaults to text");
});

test("a self-contained node seeds the founder-owned network Resonators with seeded standing", async () => {
  // Use the mainnet genesis steward identity so the node IS the network-resonator owner.
  const mainnetGenesis = genesisFor("mainnet");
  // Seeding is owner-gated to the steward wallet. A random identity (not the steward) must NOT seed,
  // even in self-contained mode — so the founder-owned positions can only be created by their owner.
  const stewardGenesis = { ...mainnetGenesis, founder: MAINNET_NETWORK_RESONATOR_OWNER, founders: [MAINNET_NETWORK_RESONATOR_OWNER] };
  const dir = join(tmpdir(), `zira-seed-${process.pid}-${Date.now()}`);
  const node = new ZiraNode(stewardGenesis as any, generateKeypair(), netStub(), dir, { selfContained: true });
  await node.start();
  // identity != steward owner, so no FOUNDER-OWNED NETWORK resonators were seeded. (The 512 anchor
  // resonators are materialized deterministically on every node from the genesis anchor seats — that is
  // intended and separate from owner-gated network-resonator seeding, so we check the network set only.)
  const networkIds = new Set(NETWORK_RESONATOR_SPECS.map((s) => s.id));
  const seededNetwork = [...node.soft.resonators.values()].filter((r) => networkIds.has(r.id));
  assert.equal(seededNetwork.length, 0, "non-owner node does not seed the founder-owned network Resonators");
  await node.stop().catch(() => {});
});

test("settleQueryCoordination splits a funded budget across answerers with the §9 protocol slices", () => {
  const dir = join(tmpdir(), `zira-settle-${process.pid}-${Date.now()}`);
  const node = new ZiraNode(genesis, founder, netStub(), dir);
  // Fund the founder identity so it can pay out (devnet steward starts with the reserve).
  const startBal = node.state.balanceOf(founder.address);
  assert.ok(startBal > 10 * PROTOCOL.UZIR_PER_ZIR, "founder funded from genesis reserve");

  // Two model-backed providers answer a reasoning query, with different domain ZTI.
  const p1 = generateKeypair();
  const p2 = generateKeypair();
  node.state.accounts.set(p1.address, { address: p1.address, pubkey: p1.publicKey, balance: 0, nonce: 0, zti: 0.9, ztiByDomain: { reasoning: 0.9 }, accuracy: 0, consistency: 1, uptime: 0, isMaster: false });
  node.state.accounts.set(p2.address, { address: p2.address, pubkey: p2.publicKey, balance: 0, nonce: 0, zti: 0.3, ztiByDomain: { reasoning: 0.3 }, accuracy: 0, consistency: 1, uptime: 0, isMaster: false });

  const queryId = "q-settle-1";
  node.soft.addQuery({ id: queryId, domain: "reasoning", question: "coordinate", history: [], asker: founder.address, postedAt: Date.now() });
  const ans = (kp: typeof p1, text: string, conf: number) =>
    ({ id: text, queryId, provider: kp.publicKey, answer: text, confidence: conf, sig: signFor(kp, queryId + "\n" + text), ts: Date.now() });
  node.soft.addAnswer(ans(p1, "answer one with detail", 1.0));
  node.soft.addAnswer(ans(p2, "answer two with detail", 1.0));

  const budget = 2_000_000;
  const result = node.settleQueryCoordination(queryId, budget);
  assert.equal(result.ok, true, result.reason);
  assert.ok(result.payouts && result.payouts.length === 2, "both answerers are paid");
  // The payout txs are pooled and apply at epoch close; assert on the deterministic split itself.
  const pay1 = result.payouts!.find((p) => p.address === p1.address)!;
  const pay2 = result.payouts!.find((p) => p.address === p2.address)!;
  assert.ok(pay1.amountUZIR > pay2.amountUZIR, "the higher-trust provider earns the larger share");
  assert.ok((result.networkUZIR ?? 0) > 0 && (result.resonatorPoolUZIR ?? 0) > 0 && (result.ecosystemUZIR ?? 0) > 0 && (result.burnUZIR ?? 0) > 0, "the §9 protocol slices are carved off");
  // contributor payouts + the four protocol slices equal the funded budget (no minting).
  const paid = result.payouts!.reduce((s, p) => s + p.amountUZIR, 0);
  const slices = (result.networkUZIR ?? 0) + (result.resonatorPoolUZIR ?? 0) + (result.ecosystemUZIR ?? 0) + (result.burnUZIR ?? 0);
  assert.equal(paid + slices, budget, "payouts + protocol slices == budget, no ZIR minted");
});
