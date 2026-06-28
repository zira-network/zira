// node/test/resonator-settlement.test.ts
// Resonator funding gives capacity, but ZTI is earned from verified released work.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeypair, signRecord, PROTOCOL, type Resonator, type Task } from "@zira/protocol";
import { SoftState } from "../src/core/SoftState.js";

test("released marketplace work advances Resonator stats and earned ZTI", () => {
  const owner = generateKeypair();
  const agent = generateKeypair();
  const soft = new SoftState();
  const resonator = signRecord({
    id: "res-settlement", owner: owner.address, address: agent.address,
    name: "Settlement Resonator", purpose: "Test verified work settlement.",
    systemPrompt: "Coordinate with the field.", domains: ["general"], modelPref: "zira-field",
    zti: 0, ztiByDomain: {}, resonanceEnabled: true,
    balanceUZIR: PROTOCOL.RESONATOR_CREATION_COST_UZIR,
    spendLimits: { perTxUZIR: 10 * PROTOCOL.UZIR_PER_ZIR, perDayUZIR: 100 * PROTOCOL.UZIR_PER_ZIR, minCounterpartyZti: 0, allowedDomains: ["general"] },
    totalEarnedUZIR: 0, totalSpentUZIR: 0, jobsDone: 0,
    priceUZIR: 10 * PROTOCOL.UZIR_PER_ZIR, listed: true,
    createdAt: 1, updatedAt: 1, status: "learning",
  }, owner.privateKey) as Resonator;

  assert.equal(soft.upsertResonator(resonator), true);
  const task: Task = {
    id: "task-settlement", client: generateKeypair().address, resonatorId: resonator.id,
    domain: "general", brief: "verify settlement", budgetUZIR: 10 * PROTOCOL.UZIR_PER_ZIR,
    minZti: 0.2, status: "released", createdAt: 2, assignedAt: 2, deliveredAt: 3,
    resolvedAt: 4, expiresAt: 60, resultRef: "ok",
  };
  assert.equal(soft.upsertTask(task), true);

  const updated = soft.resonators.get(resonator.id)!;
  assert.equal(updated.jobsDone, 1);
  assert.equal(updated.totalEarnedUZIR, task.budgetUZIR);
  assert.ok(updated.zti > 0);
  assert.ok((updated.ztiByDomain.general ?? 0) > 0);

  // Replaying the same released task must not double count.
  soft.upsertTask({ ...task, resolvedAt: 5 });
  assert.equal(soft.resonators.get(resonator.id)!.jobsDone, 1);
});

test("Resonator trust is node-authoritative and listed names must be unique", () => {
  const ownerA = generateKeypair();
  const ownerB = generateKeypair();
  const soft = new SoftState();
  const base = {
    purpose: "coordinate the field", systemPrompt: "y", domains: ["general"] as const, modelPref: "zira-field",
    ztiByDomain: {}, resonanceEnabled: false, balanceUZIR: PROTOCOL.RESONATOR_CREATION_COST_UZIR,
    spendLimits: { perTxUZIR: 0, perDayUZIR: 0, minCounterpartyZti: 0, allowedDomains: ["general"] },
    totalSpentUZIR: 0, priceUZIR: 0, createdAt: 1, updatedAt: 1, status: "idle" as const,
  };
  // An owner who signs themselves high ZTI/earnings/jobs gets them stripped; the node is authoritative.
  const forged = signRecord({ ...base, id: "res-forged", owner: ownerA.address, address: generateKeypair().address,
    name: "Field Orchestrator", zti: 0.99, jobsDone: 42, totalEarnedUZIR: 9_999_999, listed: true }, ownerA.privateKey) as Resonator;
  assert.equal(soft.upsertResonator(forged), true);
  const stored = soft.resonators.get("res-forged")!;
  assert.equal(stored.zti, 0);
  assert.equal(stored.jobsDone, 0);
  assert.equal(stored.totalEarnedUZIR, 0);
  // A different owner cannot list a verbatim duplicate of that name (no cloned templates).
  const dup = signRecord({ ...base, id: "res-dup", owner: ownerB.address, address: generateKeypair().address,
    name: "Field Orchestrator", zti: 0, listed: true }, ownerB.privateKey) as Resonator;
  assert.equal(soft.upsertResonator(dup), false);
  // A distinct name is accepted.
  const ok = signRecord({ ...base, id: "res-ok", owner: ownerB.address, address: generateKeypair().address,
    name: "My Own Resonator", zti: 0, listed: true }, ownerB.privateKey) as Resonator;
  assert.equal(soft.upsertResonator(ok), true);
});
