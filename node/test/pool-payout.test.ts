// node/test/pool-payout.test.ts
// Decentralization cutover, Phase 2. pool_payout lets ANY authorized settler (a genesis master OR a sealed
// validator) pay the community out of the fixed emission POOL, so miners keep earning when the primary
// settler (box1) is offline. These prove it is fork-safe: (a) a NON-primary master pays from the pool and two
// independent nodes apply it identically (same balances/supply => same root) and the supply audit agrees;
// (b) it is idempotent per bucket (a racing second payout for the same bucket is a no-op, no double-pay);
// (c) only an authorized settler may issue it; (d) it is INERT until the activation epoch (dormant = rejected).
import test from "node:test";
import assert from "node:assert/strict";
import { keypairFromPrivate, standardGenesis, signTx, auditSupply, type GenesisDoc } from "@zira/protocol";
import { State, EPOCH_MS, epochOf, GRACE_MS, SETTLE_ROUNDS } from "../src/core/State.js";

const founder = keypairFromPrivate("0a".repeat(32));
const GTS = 1_700_000_000_000;
const m1 = keypairFromPrivate("11".repeat(32)); // masters[0] = the emission POOL (primary settler / box1)
const m2 = keypairFromPrivate("12".repeat(32)); // masters[1] = a FAILOVER settler (a different host)
const outsider = keypairFromPrivate("77".repeat(32)); // not a master, not a validator
const genesis: GenesisDoc = {
  ...standardGenesis("devnet", founder.address, GTS),
  masters: [m1, m2, keypairFromPrivate("13".repeat(32))].map((k) => ({ address: k.address, pubKey: k.publicKey })),
};
const miners = [keypairFromPrivate("31".repeat(32)), keypairFromPrivate("32".repeat(32))];
const at = (epoch: number): number => (epoch + SETTLE_ROUNDS + 2) * EPOCH_MS + GRACE_MS + 1;
const ACT = 1; // activation override: any epoch >= 1 is active (the live epochs here are ~3.4e8)

// A state with the decentralization cutover ACTIVE and a pool (m1) funded by base emission.
function activeFundedState(): { s: State; e: number } {
  const s = new State(genesis, ACT);
  const e = epochOf(GTS) + 1;
  s.advance(at(e));
  assert.ok(s.balanceOf(m1.address) > 0, "the emission pool (m1) holds base emission");
  return { s, e: e + SETTLE_ROUNDS + 3 };
}

function poolPayoutTx(k: typeof m1, nonce: number, bucket: number, outputs: [string, number][], ts: number) {
  const sum = outputs.reduce((s, [, a]) => s + a, 0);
  return signTx({
    network: genesis.network, from: k.address, fromPubKey: k.publicKey, to: m1.address /* the pool */,
    amountUZIR: sum, feeUZIR: 1000, nonce, kind: "pool_payout",
    parents: [], timestamp: ts, memo: JSON.stringify({ b: bucket, o: outputs }),
  }, k.privateKey);
}

test("a NON-primary master pays miners from the pool; two nodes apply it identically", () => {
  const outputs: [string, number][] = [[miners[0]!.address, 400_000], [miners[1]!.address, 250_001]];
  const sum = outputs.reduce((s, [, a]) => s + a, 0);
  const a = activeFundedState();
  const b = activeFundedState();
  const ts = a.e * EPOCH_MS + 5;
  // m2 (a failover settler with ZERO balance) issues the payout, funded entirely by the pool.
  assert.equal(a.s.balanceOf(m2.address), 0, "m2 holds no balance of its own");
  const tx = poolPayoutTx(m2, a.s.nonceOf(m2.address), 100, outputs, ts);

  for (const st of [a, b]) {
    assert.equal(st.s.ingestTx(tx).ok, true, "pool_payout accepted at ingest");
    st.s.advance(at(a.e + 2));
  }

  for (const [addr, amt] of outputs) {
    assert.equal(a.s.balanceOf(addr), amt, "miner credited exactly (node a)");
    assert.equal(b.s.balanceOf(addr), amt, "miner credited exactly (node b)");
  }
  void sum;
  // Byte-identical state across the two independent nodes => identical state root (the fork-safety property).
  assert.equal(a.s.balanceOf(m1.address), b.s.balanceOf(m1.address), "pool balance identical across nodes");
  assert.equal(a.s.balanceOf(m2.address), 0, "the failover settler still holds nothing (pool paid the fee)");
  assert.equal(a.s.nonceOf(m2.address), b.s.nonceOf(m2.address), "issuer nonce identical across nodes");
  assert.deepEqual(a.s.supply, b.s.supply, "supply identical across nodes");
  // Independent supply audit agrees on where the ZIR went.
  const audit = auditSupply(a.s.history, founder.address);
  for (const [addr, amt] of outputs) assert.equal(audit.balances[addr], amt, "audit credits each miner");
});

test("pool_payout is idempotent per bucket (a racing second payout for the same bucket is a no-op)", () => {
  const { s, e } = activeFundedState();
  const ts = e * EPOCH_MS + 5;
  const out1: [string, number][] = [[miners[0]!.address, 300_000]];
  // m1 pays bucket 100.
  assert.equal(s.ingestTx(poolPayoutTx(m1, s.nonceOf(m1.address), 100, out1, ts)).ok, true);
  s.advance(at(e + 2));
  assert.equal(s.balanceOf(miners[0]!.address), 300_000, "bucket 100 paid once");
  // m2 races a DIFFERENT payout for the SAME bucket 100 -> must be a no-op (no double-pay).
  const before = s.balanceOf(miners[1]!.address);
  assert.equal(s.ingestTx(poolPayoutTx(m2, s.nonceOf(m2.address), 100, [[miners[1]!.address, 999_000]], ts + 1)).ok, true);
  s.advance(at(e + 5));
  assert.equal(s.balanceOf(miners[1]!.address), before, "the duplicate-bucket payout paid nothing");
  // A NEW higher bucket is accepted.
  assert.equal(s.ingestTx(poolPayoutTx(m1, s.nonceOf(m1.address), 101, [[miners[1]!.address, 120_000]], ts + 2)).ok, true);
  s.advance(at(e + 8));
  assert.equal(s.balanceOf(miners[1]!.address), before + 120_000, "the next bucket pays");
});

test("only an authorized settler (master/validator) may spend the pool", () => {
  const { s, e } = activeFundedState();
  const ts = e * EPOCH_MS + 5;
  const before = s.balanceOf(miners[0]!.address);
  // An outsider (not a master, not a sealed validator) tries to drain the pool.
  assert.equal(s.ingestTx(poolPayoutTx(outsider, s.nonceOf(outsider.address), 200, [[miners[0]!.address, 500_000]], ts)).ok, true);
  s.advance(at(e + 3));
  assert.equal(s.balanceOf(miners[0]!.address), before, "an unauthorized pool_payout moved no money");
});

test("pool_payout is INERT until activation (dormant network rejects it, no money moves)", () => {
  // Default State => activation is the compiled default (0 = disabled).
  const s = new State(genesis);
  const e = epochOf(GTS) + 1;
  s.advance(at(e));
  const e2 = e + SETTLE_ROUNDS + 3;
  const ts = e2 * EPOCH_MS + 5;
  const before = s.balanceOf(miners[0]!.address);
  assert.equal(s.ingestTx(poolPayoutTx(m1, s.nonceOf(m1.address), 100, [[miners[0]!.address, 300_000]], ts)).ok, true);
  s.advance(at(e2 + 3));
  assert.equal(s.balanceOf(miners[0]!.address), before, "dormant: pool_payout paid nothing");
});
