// Resonators LEARN from autonomous coordination. Each settled autonomous convergence task (released only
// when >= 2 model-backed answers converged) grows the resonator's domain ZTI asymptotically toward 1, scaled
// by the convergence quality and the reward budget, and increments jobs + earnings. The domain cycles per
// bucket, so a multi-domain resonator learns across all of its domains. Node-authoritative + deterministic.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keypairFromPrivate, generateKeypair, signRecord, standardGenesis, PROTOCOL, type Keypair, type Resonator, type Task, type Domain } from "@zira/protocol";
import { ZiraNode } from "../src/core/ZiraNode.js";
import type { ZiraNetwork } from "../src/p2p/Network.js";

const founder = keypairFromPrivate("0a".repeat(32));
const GTS = 1_700_000_000_000;

function fakeNet(): ZiraNetwork {
  return {
    start: async () => {}, stop: async () => {}, publish: async () => {}, onMessage: () => {},
    setSyncProvider: () => {}, onSyncFrame: () => {}, handle: () => {}, request: async () => [],
    onPeerConnect: () => {}, dial: async () => {}, multiaddrs: () => [], peerId: () => "test-peer",
    peerCount: () => 0, peers: () => [],
  } as unknown as ZiraNetwork;
}
function buildNode(): ZiraNode {
  const dir = join(tmpdir(), `zira-res-learn-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return new ZiraNode(standardGenesis("devnet", founder.address, GTS), founder, fakeNet(), dir);
}
function resonator(id: string, owner: Keypair, domains: Domain[]): Resonator {
  return signRecord({
    id, owner: owner.address, address: `zir1agent${id.replace(/[^a-z0-9]/g, "").slice(0, 26)}`, name: `R ${id}`, purpose: "p",
    systemPrompt: "s", domains, modelPref: "text", zti: 0, ztiByDomain: {},
    resonanceEnabled: true, balanceUZIR: PROTOCOL.RESONATOR_CREATION_COST_UZIR,
    spendLimits: { perTxUZIR: 0, perDayUZIR: 0, minCounterpartyZti: 0, allowedDomains: domains },
    totalEarnedUZIR: 0, totalSpentUZIR: 0, jobsDone: 0, priceUZIR: 0, listed: true,
    createdAt: GTS, updatedAt: GTS, status: "idle",
  }, owner.privateKey) as unknown as Resonator;
}
// A released autonomous-convergence task: minZti carries the convergence quality, budget the reward.
function convergenceTask(id: string, resonatorId: string, domain: Domain, convergence: number, budgetUZIR: number): Task {
  return {
    id, client: founder.address, resonatorId, domain, brief: "autonomous convergence",
    budgetUZIR, minZti: convergence, status: "released",
    createdAt: GTS, assignedAt: GTS, deliveredAt: GTS, resolvedAt: GTS, expiresAt: GTS + 10_000, resultRef: `ref-${id}`,
  } as unknown as Task;
}
const REWARD = 200_000_000; // 200 ZIR autonomous cycle reward

test("a settled autonomous task grows the resonator's domain ZTI and records the work", () => {
  const node = buildNode();
  const owner = generateKeypair();
  assert.equal(node.soft.upsertResonator(resonator("learn-1", owner, ["general"]), undefined), true);
  assert.equal(node.soft.resonators.get("learn-1")?.zti, 0, "starts at zero standing");

  node.soft.upsertTask(convergenceTask("t1", "learn-1", "general", 0.8, REWARD));
  const r = node.soft.resonators.get("learn-1")!;
  assert.ok((r.ztiByDomain.general ?? 0) > 0, "domain ZTI grew from the settled convergence");
  assert.equal(r.jobsDone, 1, "job recorded");
  assert.equal(r.totalEarnedUZIR, REWARD, "earnings recorded");
  assert.equal(r.status, "learning", "resonance-enabled resonator is learning");
});

test("learning is asymptotic: it keeps rising toward 1 but never exceeds it", () => {
  const node = buildNode();
  const owner = generateKeypair();
  node.soft.upsertResonator(resonator("learn-2", owner, ["general"]), undefined);
  let last = 0;
  for (let i = 0; i < 40; i++) {
    node.soft.upsertTask(convergenceTask(`t2-${i}`, "learn-2", "general", 0.9, REWARD));
    const z = node.soft.resonators.get("learn-2")!.ztiByDomain.general ?? 0;
    assert.ok(z >= last, "domain ZTI is monotonically non-decreasing");
    assert.ok(z <= 1, "domain ZTI never exceeds 1");
    last = z;
  }
  assert.ok(last > 0.8, "after sustained convergence the resonator becomes highly trusted in its domain");
});

test("higher convergence quality teaches the resonator faster", () => {
  const node = buildNode();
  const a = generateKeypair(), b = generateKeypair();
  node.soft.upsertResonator(resonator("hi", a, ["general"]), undefined);
  node.soft.upsertResonator(resonator("lo", b, ["general"]), undefined);
  node.soft.upsertTask(convergenceTask("th", "hi", "general", 0.95, REWARD));
  node.soft.upsertTask(convergenceTask("tl", "lo", "general", 0.10, REWARD));
  const hi = node.soft.resonators.get("hi")!.ztiByDomain.general ?? 0;
  const lo = node.soft.resonators.get("lo")!.ztiByDomain.general ?? 0;
  assert.ok(hi > lo, "a stronger-consensus answer earns a bigger learning step");
});

test("a multi-domain resonator learns each domain independently; overall ZTI is their mean", () => {
  const node = buildNode();
  const owner = generateKeypair();
  node.soft.upsertResonator(resonator("multi", owner, ["general", "code"]), undefined);
  node.soft.upsertTask(convergenceTask("m1", "multi", "general", 0.8, REWARD));
  node.soft.upsertTask(convergenceTask("m2", "multi", "code", 0.8, REWARD));
  const r = node.soft.resonators.get("multi")!;
  assert.ok((r.ztiByDomain.general ?? 0) > 0 && (r.ztiByDomain.code ?? 0) > 0, "both served domains grew");
  const mean = ((r.ztiByDomain.general ?? 0) + (r.ztiByDomain.code ?? 0)) / 2;
  assert.ok(Math.abs(r.zti - Number(mean.toFixed(4))) < 1e-6, "overall ZTI is the mean of domain standings");
});

test("the same convergence history yields identical learned standing on every node (deterministic)", () => {
  const build = () => {
    const node = buildNode();
    const owner = generateKeypair();
    node.soft.upsertResonator(resonator("det", owner, ["general"]), undefined);
    for (let i = 0; i < 5; i++) node.soft.upsertTask(convergenceTask(`d-${i}`, "det", "general", 0.7, REWARD));
    return node.soft.resonators.get("det")!.ztiByDomain.general ?? 0;
  };
  assert.equal(build(), build(), "identical task history -> identical learned ZTI");
});
