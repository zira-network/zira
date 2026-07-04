// node/src/core/payout-split.ts
// Deterministic weighted apportionment for the field-participation batch payout. Given payees, their
// (already-computed) weights, and a fixed integer pool, split the pool so every uZIR is assigned and the
// outputs sum EXACTLY to the pool with no drift. The settler computes this and issues it in ONE signed
// batch_transfer; every node applies the resulting outputs byte-identically, so the split may be weighted
// without any consensus risk (the ledger re-checks amountUZIR == sum(outputs)). Largest-remainder method:
// floor each proportional share, then hand out the leftover one uZIR at a time to the largest fractional
// remainders, ties broken by input order (which the caller keeps stable/sorted) so the result is fully
// deterministic across nodes.
export function weightedOutputs(payees: string[], weights: number[], pool: number): [string, number][] {
  const n = payees.length;
  if (n === 0 || pool <= 0) return [];
  const w = weights.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  let total = w.reduce((s, x) => s + x, 0);
  if (total <= 0) { total = n; for (let i = 0; i < n; i++) w[i] = 1; }
  const raw = w.map((x) => (pool * x) / total);
  const out: [string, number][] = payees.map((to, i) => [to, Math.floor(raw[i]!)]);
  let distributed = out.reduce((s, [, v]) => s + v, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
    .map((x) => x.i);
  for (let k = 0; distributed < pool; k++, distributed++) out[order[k % order.length]!]![1]++;
  return out;
}
