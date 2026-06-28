// node/test/domain-routing.test.ts
// Domain-aware routing: specialists in the query's domain come first, then generalists, ranked by
// domain ZTI. With no specialists, generalists are used.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keypairFromPrivate, generateKeypair, standardGenesis, DEFAULT_PROVIDER_CONFIG } from "@zira/protocol";
import { ZiraNode } from "../src/core/ZiraNode.js";
import { buildProviderProfile } from "../src/provider/profile.js";

const founder = keypairFromPrivate("01".repeat(32));
const genesis = standardGenesis("devnet", founder.address, 1_700_000_000_000);

function netStub() {
  return { peerId: () => "p", peers: () => [], handle() {}, request: async () => [], publish: async () => {},
    onMessage() {}, setSyncProvider() {}, onSyncFrame() {}, onPeerConnect() {}, dial: async () => {},
    start: async () => {}, stop: async () => {}, multiaddrs: () => [], peerCount: () => 0 } as any;
}

function seedProvider(node: ZiraNode, domains: string[], zti: number) {
  const kp = generateKeypair();
  const profile = buildProviderProfile(kp, { ...DEFAULT_PROVIDER_CONFIG, domains: domains as any }, { tokensPerSec: 5, contextWindowTokens: 4096 });
  node.soft.upsertProviderProfile(profile);
  node.state.accounts.set(kp.address, { address: kp.address, pubkey: kp.publicKey, balance: 0, nonce: 0, zti, ztiByDomain: { reasoning: zti, general: zti }, accuracy: 0, consistency: 1, uptime: 0, isMaster: false });
  return kp.address;
}

test("selectProviders returns reasoning specialists before generalists", () => {
  const node = new ZiraNode(genesis, founder, netStub(), join(tmpdir(), `zira-route-${process.pid}-${Date.now()}`));
  const specialist = seedProvider(node, ["reasoning"], 0.6);
  const general = seedProvider(node, ["general"], 0.9);
  const picked = node.selectProviders({ domain: "reasoning" }, 3).map((p) => p.address);
  assert.equal(picked[0], specialist, "the reasoning specialist is preferred over a higher-ZTI generalist");
  assert.ok(picked.includes(general), "generalists still appear as fallback");
});

test("selectProviders falls back to generalists when there are no specialists", () => {
  const node = new ZiraNode(genesis, founder, netStub(), join(tmpdir(), `zira-route2-${process.pid}-${Date.now()}`));
  const general = seedProvider(node, ["general"], 0.7);
  const picked = node.selectProviders({ domain: "reasoning" }, 3).map((p) => p.address);
  assert.deepEqual(picked, [general]);
});
