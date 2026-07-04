// node/test/coordination-batch.test.ts
// Coordination settlement now pays the whole §9 split (contributors 77% + network 8% + pool 10%) in ONE
// batch_transfer, with the 5% burn folded into the tx fee — instead of N separate agent_spends. N agent_spends
// were the coordination equivalent of the field-participation fork: one dropped tx gapped the settler's nonce,
// cascaded to drop every later settler tx on that node, diverged its root, and FROZE finality (2026-07-04).
// These tests prove the split composes into a VALID, ZIR-exact batch (parseBatchOutputs accepts it; outputs +
// fee-burn sum to the exact budget; every amount is a positive integer).
import test from "node:test";
import assert from "node:assert/strict";
import { settleCoordination, parseBatchOutputs, PROTOCOL, keypairFromPrivate } from "@zira/protocol";
import { settlementWalletsFor } from "../src/genesis-docs.js";

function buildCoordBatch(budget: number, contributions: { address: string; domainZti: number; confidence: number; agreement: number }[], poolBeneficiary?: string) {
  const split = settleCoordination(budget, contributions);
  const wallets = settlementWalletsFor("devnet");
  const poolTarget = poolBeneficiary && /^zir1[0-9a-z]{6,}$/.test(poolBeneficiary) ? poolBeneficiary : wallets.resonatorPool;
  const credits = new Map<string, number>();
  for (const p of split.payouts) if (p.amountUZIR > 0) credits.set(p.address, (credits.get(p.address) ?? 0) + p.amountUZIR);
  if (split.networkUZIR > 0) credits.set(wallets.network, (credits.get(wallets.network) ?? 0) + split.networkUZIR);
  if (split.resonatorPoolUZIR > 0) credits.set(poolTarget, (credits.get(poolTarget) ?? 0) + split.resonatorPoolUZIR);
  const outputs: [string, number][] = [...credits.entries()].filter(([a]) => /^zir1[0-9a-z]{6,}$/.test(a));
  const outSum = outputs.reduce((s, [, a]) => s + a, 0);
  const fee = Math.max(PROTOCOL.BASE_FEE_UZIR, split.burnUZIR);
  return { split, outputs, outSum, fee, memo: JSON.stringify({ o: outputs }) };
}

const providers = [
  keypairFromPrivate("41".repeat(32)).address,
  keypairFromPrivate("42".repeat(32)).address,
  keypairFromPrivate("43".repeat(32)).address,
];

test("coordination split composes into a valid batch_transfer memo (parseBatchOutputs accepts it)", () => {
  const budget = 1_000_000_000; // 1000 ZIR
  const contribs = providers.map((address, i) => ({ address, domainZti: 0.9, confidence: 0.8, agreement: 0.7 + i * 0.1 }));
  const { outputs, outSum, memo } = buildCoordBatch(budget, contribs);
  const parsed = parseBatchOutputs(memo);
  assert.ok(parsed, "parseBatchOutputs must accept the coordination batch memo");
  assert.equal(parsed!.reduce((s, [, a]) => s + a, 0), outSum, "parsed outputs sum to amountUZIR");
  assert.ok(outputs.every(([, a]) => Number.isInteger(a) && a > 0), "every output amount is a positive integer");
  assert.ok(outputs.length <= 256, "within the 256-output batch cap");
});

test("outputs + fee-burn account for the ENTIRE budget — no ZIR minted or lost", () => {
  for (const budget of [1_000_000_000, 200_000_000, 999_983, 7]) {
    const contribs = providers.map((a) => ({ address: a, domainZti: 0.5, confidence: 1, agreement: 1 }));
    const { split, outSum, fee } = buildCoordBatch(budget, contribs);
    // funder is debited outSum (the credited outputs) + fee (the burned slice). With fee == burn that is the
    // whole budget; the batch fee floor can only round the burn UP by <= BASE_FEE, never lose ZIR.
    if (split.burnUZIR >= PROTOCOL.BASE_FEE_UZIR) {
      assert.equal(outSum + fee, budget, `budget ${budget}: outputs + burn == budget exactly`);
    } else {
      assert.equal(fee, PROTOCOL.BASE_FEE_UZIR, "tiny-budget burn floored up to the base fee");
      assert.ok(outSum + fee >= budget, "never under-spends the budget");
    }
  }
});

test("a lone contributor still yields a valid single-output-plus-slices batch", () => {
  const { outputs, memo } = buildCoordBatch(500_000_000, [{ address: providers[0]!, domainZti: 0.9, confidence: 0.9, agreement: 1 }]);
  assert.ok(parseBatchOutputs(memo), "single-contributor batch is valid");
  assert.ok(outputs.some(([a]) => a === providers[0]), "the contributor is paid");
});
