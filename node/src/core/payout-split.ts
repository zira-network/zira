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

  // Every emitted output MUST be strictly positive: the ledger's parseBatchOutputs rejects the WHOLE batch
  // if any output is <= 0, which would wedge that settlement cycle and pay no one. When the pool cannot
  // cover one uZIR per payee, pay only the highest-weight `pool` payees (1 uZIR each) and drop the rest for
  // this cycle. On mainnet pool (billions of uZIR) vastly exceeds n (<=64) so this branch never triggers;
  // it only guards a mis-sized pool from breaking payouts entirely.
  if (pool < n) {
    return w
      .map((x, i) => ({ i, x }))
      .sort((a, b) => b.x - a.x || a.i - b.i)
      .slice(0, pool)
      .map((e) => e.i)
      .sort((a, b) => a - b)
      .map((i) => [payees[i]!, 1] as [string, number]);
  }

  // pool >= n: give every payee a base of 1 uZIR (guarantees no zero output), then apportion the remainder
  // by weight with the largest-remainder method so the outputs still sum EXACTLY to pool. The n-uZIR base is
  // dust against a multi-billion-uZIR pool, so the weighting is unchanged in practice; it just makes a live
  // verified payee's share provably positive.
  const remaining = pool - n;
  const raw = w.map((x) => (remaining * x) / total);
  const out: [string, number][] = payees.map((to, i) => [to, 1 + Math.floor(raw[i]!)]);
  let distributed = out.reduce((s, [, v]) => s + v, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
    .map((x) => x.i);
  for (let k = 0; distributed < pool; k++, distributed++) out[order[k % order.length]!]![1]++;
  return out;
}
