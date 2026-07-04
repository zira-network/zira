// node/test/task-reaper.test.ts
// The reaper drives task lifecycle fallbacks: an undelivered task past its expiry refunds; a
// delivered task the hirer never verifies auto-releases; a fresh task is untouched.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keypairFromPrivate, generateKeypair, sign as edSign, signRecord, signTx, standardGenesis, PROTOCOL, TASK_VERIFY_TIMEOUT_MS, type Resonator, type Task } from "@zira/protocol";
import { ZiraNode } from "../src/core/ZiraNode.js";

const founder = keypairFromPrivate("01".repeat(32));
const genesis = standardGenesis("devnet", founder.address, 1_700_000_000_000);

function netStub() {
  return { peerId: () => "p", peers: () => [], handle() {}, request: async () => [], publish: async () => {},
    onMessage() {}, setSyncProvider() {}, onSyncFrame() {}, onPeerConnect() {}, dial: async () => {},
    start: async () => {}, stop: async () => {}, multiaddrs: () => [], peerCount: () => 0 } as any;
}

function mkNode() {
  return new ZiraNode(genesis, founder, netStub(), join(tmpdir(), `zira-reap-${process.pid}-${Date.now()}-${Math.random()}`));
}

// A brand-new user Resonator must hold at least the creation cost in its AGENT wallet on-chain (anti-spam,
// SoftState.upsertResonator checks provisionalBalance(r.address), NOT the record's balanceUZIR field). Move
// creation-cost ZIR from the founder (the genesis holder) into the agent wallet so the gate clears — this
// mirrors how a real owner funds their Resonator's operating float before it stands up on Discover.
function fundAgent(node: ZiraNode, to: string, ts: number, nonce = 0) {
  const tx = signTx({
    network: genesis.network, from: founder.address, fromPubKey: founder.publicKey, to,
    amountUZIR: PROTOCOL.RESONATOR_CREATION_COST_UZIR, feeUZIR: 1000, nonce, kind: "transfer",
    parents: [], timestamp: ts, memo: "",
  }, founder.privateKey);
  const r = node.submitTx(tx);
  assert.equal(r.accepted, true, `fundAgent tx rejected: ${r.reason}`);
}

function task(id: string, status: Task["status"], over: Partial<Task>): Task {
  return { id, client: "zir1client", resonatorId: "r1", domain: "general", brief: "b", budgetUZIR: 1000, minZti: 0,
    status, createdAt: 0, expiresAt: 0, ...over };
}

test("an assigned task past its expiry transitions to refunded", () => {
  const node = mkNode();
  const now = Date.now();
  node.publishTask(task("t1", "assigned", { expiresAt: now - 1000 }));
  node.reapTasks(now);
  assert.equal(node.soft.tasks.get("t1")!.status, "refunded");
});

test("a delivered task past the verify timeout auto-releases", () => {
  const node = mkNode();
  const now = Date.now();
  node.publishTask(task("t2", "delivered", { deliveredAt: now - TASK_VERIFY_TIMEOUT_MS - 1000 }));
  node.reapTasks(now);
  assert.equal(node.soft.tasks.get("t2")!.status, "released");
});

test("a task that has not expired stays assigned", () => {
  const node = mkNode();
  const now = Date.now();
  node.publishTask(task("t3", "assigned", { expiresAt: now + 60_000 }));
  node.reapTasks(now);
  assert.equal(node.soft.tasks.get("t3")!.status, "assigned");
});

test("a funded resonance-enabled Resonator autonomously delivers assigned work", () => {
  const node = mkNode();
  const owner = generateKeypair();
  const agent = generateKeypair();
  const now = Date.now();
  const resonator = signRecord({
    id: "r-auto", owner: owner.address, address: agent.address,
    name: "Autonomous Test", purpose: "Test task progression.",
    systemPrompt: "Coordinate and deliver.", domains: ["general"], modelPref: "zira-field",
    zti: 0, ztiByDomain: {}, resonanceEnabled: true, balanceUZIR: PROTOCOL.RESONATOR_CREATION_COST_UZIR,
    spendLimits: { perTxUZIR: PROTOCOL.UZIR_PER_ZIR, perDayUZIR: PROTOCOL.UZIR_PER_ZIR, minCounterpartyZti: 0, allowedDomains: ["general"] },
    totalEarnedUZIR: 0, totalSpentUZIR: 0, jobsDone: 0,
    priceUZIR: PROTOCOL.UZIR_PER_ZIR, listed: true,
    createdAt: now - 20_000, updatedAt: now - 20_000, status: "learning",
  }, owner.privateKey) as Resonator;

  fundAgent(node, agent.address, now - 20_000);
  assert.equal(node.publishResonator(resonator), true);
  node.publishTask(task("t4", "assigned", { resonatorId: resonator.id, assignedAt: now - 20_000, expiresAt: now + 60_000 }));
  node.reapTasks(now);
  const delivered = node.soft.tasks.get("t4")!;
  assert.equal(delivered.status, "delivered");
  assert.equal(typeof delivered.resultRef, "string");
});

test("AI-to-AI miner convergence releases paid Resonator coordination work", () => {
  const node = mkNode();
  const owner = generateKeypair();
  const agent = generateKeypair();
  const providerA = generateKeypair();
  const providerB = generateKeypair();
  const now = 1_700_000_000_000;
  const resonator = signRecord({
    id: "r-converge", owner: owner.address, address: agent.address,
    name: "Convergence Test", purpose: "Test autonomous AI-to-AI coordination.",
    systemPrompt: "Coordinate with model-backed miners.", domains: ["planning", "reasoning", "general"], modelPref: "zira-field",
    zti: 0, ztiByDomain: {}, resonanceEnabled: true, balanceUZIR: PROTOCOL.RESONATOR_CREATION_COST_UZIR,
    spendLimits: { perTxUZIR: PROTOCOL.UZIR_PER_ZIR, perDayUZIR: PROTOCOL.UZIR_PER_ZIR, minCounterpartyZti: 0, allowedDomains: ["planning", "reasoning", "general"] },
    totalEarnedUZIR: 0, totalSpentUZIR: 0, jobsDone: 0,
    priceUZIR: PROTOCOL.UZIR_PER_ZIR, listed: true,
    createdAt: now, updatedAt: now, status: "learning",
  }, owner.privateKey) as Resonator;

  fundAgent(node, agent.address, now);
  assert.equal(node.publishResonator(resonator), true);
  const first = node.coordinateAutonomousResonance(now);
  assert.equal(first.queries, 1);
  const query = [...node.soft.queries.values()][0]!;

  const answerA = "Coordinate model readiness, storage replication, and task routing.";
  const answerB = "Keep mining online, verify model-backed answers, and route resonance tasks.";
  assert.equal(node.publishAnswer({ id: "a", queryId: query.id, provider: providerA.publicKey, answer: answerA, confidence: 0.82, sig: edSign(query.id + "\n" + answerA, providerA.privateKey), ts: now + 1000 }), true);
  assert.equal(node.publishAnswer({ id: "b", queryId: query.id, provider: providerB.publicKey, answer: answerB, confidence: 0.8, sig: edSign(query.id + "\n" + answerB, providerB.privateKey), ts: now + 2000 }), true);

  const settled = node.coordinateAutonomousResonance(now + 31_000);
  assert.equal(settled.released, 1);
  const task = [...node.soft.tasks.values()].find((t) => t.resonatorId === resonator.id)!;
  assert.equal(task.status, "released");
  // Current (paid) design: an autonomous coordination cycle carries the per-cycle resonator reward
  // (AUTONOMOUS_RESONANCE_TASK_UZIR), so a driven Resonator earns real ZIR — not the old zero-budget model.
  // The gossiped, tx-free released task grows the Resonator's displayed totalEarned by exactly that budget.
  assert.ok(task.budgetUZIR > 0);
  assert.ok(["planning", "reasoning", "general"].includes(task.domain));
  assert.equal(node.soft.resonators.get(resonator.id)!.jobsDone, 1);
  assert.equal(node.soft.resonators.get(resonator.id)!.totalEarnedUZIR, task.budgetUZIR);
  assert.ok((node.soft.resonators.get(resonator.id)!.ztiByDomain[task.domain] ?? 0) > 0);
});

test("autonomous convergence ignores coordination fallback answers", () => {
  const node = mkNode();
  const owner = generateKeypair();
  const agent = generateKeypair();
  const fallbackProvider = generateKeypair();
  const modelProvider = generateKeypair();
  const secondModelProvider = generateKeypair();
  const now = 1_700_000_000_000;
  const resonator = signRecord({
    id: "r-fallback", owner: owner.address, address: agent.address,
    name: "Fallback Test", purpose: "Test fallback filtering.",
    systemPrompt: "Coordinate with model-backed miners.", domains: ["planning", "reasoning"], modelPref: "zira-field",
    zti: 0, ztiByDomain: {}, resonanceEnabled: true, balanceUZIR: PROTOCOL.RESONATOR_CREATION_COST_UZIR,
    spendLimits: { perTxUZIR: PROTOCOL.UZIR_PER_ZIR, perDayUZIR: PROTOCOL.UZIR_PER_ZIR, minCounterpartyZti: 0, allowedDomains: ["planning", "reasoning"] },
    totalEarnedUZIR: 0, totalSpentUZIR: 0, jobsDone: 0,
    priceUZIR: PROTOCOL.UZIR_PER_ZIR, listed: true,
    createdAt: now, updatedAt: now, status: "learning",
  }, owner.privateKey) as Resonator;

  fundAgent(node, agent.address, now);
  assert.equal(node.publishResonator(resonator), true);
  node.coordinateAutonomousResonance(now);
  const query = [...node.soft.queries.values()][0]!;
  const fallback = "This node is mining in coordination mode: it can relay signed queries.";
  const modelAnswer = "Strengthen the storage and mining loop, then route verified coordination tasks.";
  assert.equal(node.publishAnswer({ id: "fallback", queryId: query.id, provider: fallbackProvider.publicKey, answer: fallback, confidence: 0.9, sig: edSign(query.id + "\n" + fallback, fallbackProvider.privateKey), ts: now + 1000 }), true);
  assert.equal(node.publishAnswer({ id: "model", queryId: query.id, provider: modelProvider.publicKey, answer: modelAnswer, confidence: 0.8, sig: edSign(query.id + "\n" + modelAnswer, modelProvider.privateKey), ts: now + 2000 }), true);
  assert.equal(node.coordinateAutonomousResonance(now + 31_000).released, 0);

  const secondAnswer = "Keep provider answers online, compare convergence, and update Resonator routing.";
  assert.equal(node.publishAnswer({ id: "model2", queryId: query.id, provider: secondModelProvider.publicKey, answer: secondAnswer, confidence: 0.78, sig: edSign(query.id + "\n" + secondAnswer, secondModelProvider.privateKey), ts: now + 3000 }), true);
  assert.equal(node.coordinateAutonomousResonance(now + 32_000).released, 1);
});
