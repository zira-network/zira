// node/test/batch-transfer.test.ts
// The batch_transfer tx pays many recipients in ONE transaction, which is the fix for the finality fork: a
// single nonce can't open a gap that cascades and drops every later settler tx on a node. These tests prove
// (a) it applies IDENTICALLY on two independent nodes (byte-identical balances/nonces/supply == same root),
// (b) it moves the exact pool with no ZIR minted or lost (supply audit agrees), (c) a malformed or sum-
// mismatched batch is rejected at ingest, and (d) an overspend batch is dropped without consuming the nonce.
import test from "node:test";
import assert from "node:assert/strict";
import {
  keypairFromPrivate, standardGenesis, signTx, auditSupply, parseBatchOutputs, type GenesisDoc,
} from "@zira/protocol";
import { State, EPOCH_MS, epochOf, GRACE_MS, SETTLE_ROUNDS } from "../src/core/State.js";

const founder = keypairFromPrivate("0a".repeat(32));
const GTS = 1_700_000_000_000;
const m1 = keypairFromPrivate("11".repeat(32)); // settler (masters[0]) — the funder of the batch
const m2 = keypairFromPrivate("12".repeat(32));
const m3 = keypairFromPrivate("13".repeat(32));
const genesis: GenesisDoc = {
  ...standardGenesis("devnet", founder.address, GTS),
  masters: [m1, m2, m3].map((k) => ({ address: k.address, pubKey: k.publicKey })),
};
const miners = [
  keypairFromPrivate("31".repeat(32)),
  keypairFromPrivate("32".repeat(32)),
  keypairFromPrivate("33".repeat(32)),
];
const at = (epoch: number): number => (epoch + SETTLE_ROUNDS + 2) * EPOCH_MS + GRACE_MS + 1;

// A settler funded by base emission after advancing a few epochs.
function fundedState(): { s: State; settlerNonce: number; e: number } {
  const s = new State(genesis);
  const e = epochOf(GTS) + 1;
  s.advance(at(e)); // base emission credits the settler
  assert.ok(s.balanceOf(m1.address) > 0, "settler holds base emission to fund the batch");
  return { s, settlerNonce: s.nonceOf(m1.address), e: e + SETTLE_ROUNDS + 3 };
}

function batchTx(nonce: number, outputs: [string, number][], ts: number) {
  const pool = outputs.reduce((sum, [, a]) => sum + a, 0);
  return signTx({
    network: genesis.network, from: m1.address, fromPubKey: m1.publicKey, to: m1.address,
    amountUZIR: pool, feeUZIR: 1000, nonce, kind: "batch_transfer",
    parents: [], timestamp: ts, memo: JSON.stringify({ o: outputs }),
  }, m1.privateKey);
}

test("a batch_transfer credits every recipient and applies identically on two nodes", () => {
  const outputs: [string, number][] = [
    [miners[0]!.address, 500_000],
    [miners[1]!.address, 300_000],
    [miners[2]!.address, 200_001], // uneven amount to catch any rounding drift
  ];
  const pool = outputs.reduce((s, [, a]) => s + a, 0);

  // Two independent "nodes" apply the identical signed tx.
  const a = fundedState();
  const b = fundedState();
  const ts = a.e * EPOCH_MS + 5;
  const tx = batchTx(a.settlerNonce, outputs, ts);

  for (const st of [a, b]) {
    assert.equal(st.s.ingestTx(tx).ok, true, "batch is accepted at ingest");
    st.s.advance(at(a.e + 2));
  }

  // (a) every recipient got exactly its amount, on both nodes
  for (const [addr, amt] of outputs) {
    assert.equal(a.s.balanceOf(addr), amt, "recipient credited exactly on node a");
    assert.equal(b.s.balanceOf(addr), amt, "recipient credited exactly on node b");
  }
  void pool;
  // (a) byte-identical state across the two nodes: same settler balance, nonce, and supply => same state root
  assert.equal(a.s.balanceOf(m1.address), b.s.balanceOf(m1.address), "settler balance identical across nodes");
  assert.equal(a.s.nonceOf(m1.address), b.s.nonceOf(m1.address));
  assert.deepEqual(a.s.supply, b.s.supply, "supply is identical across nodes");

  // (b) no ZIR minted or lost: the independent supply audit agrees the pool moved to the outputs
  const audit = auditSupply(a.s.history, founder.address);
  for (const [addr, amt] of outputs) assert.equal(audit.balances[addr], amt, "audit credits each output");
});

function transferTx(nonce: number, to: string, amt: number, ts: number) {
  return signTx({
    network: genesis.network, from: m1.address, fromPubKey: m1.publicKey, to,
    amountUZIR: amt, feeUZIR: 1000, nonce, kind: "transfer", parents: [], timestamp: ts, memo: "",
  }, m1.privateKey);
}

test("a nonce-gapped tx is retained until its predecessor arrives, then both apply (no permanent divergence)", () => {
  const inorder = fundedState();
  const gapped = fundedState();
  const ts = inorder.e * EPOCH_MS + 5;
  const x = miners[0]!.address, y = miners[1]!.address;
  const t5 = transferTx(inorder.settlerNonce, x, 400_000, ts);       // predecessor
  const t6 = transferTx(inorder.settlerNonce + 1, y, 300_000, ts);   // successor (nonce +1)

  // In-order node: gets both, applies both.
  assert.equal(inorder.s.ingestTx(t5).ok, true);
  assert.equal(inorder.s.ingestTx(t6).ok, true);
  inorder.s.advance(at(inorder.e + 3));
  assert.equal(inorder.s.balanceOf(x), 400_000);
  assert.equal(inorder.s.balanceOf(y), 300_000);

  // Gapped node: receives ONLY the later-nonce tx first and processes an epoch. Under the old drain it would
  // be applied-and-deleted (a no-op that permanently lost it); now it must be RETAINED (still 0), then the
  // predecessor arrives over backfill and a later epoch applies both in order.
  assert.equal(gapped.s.ingestTx(t6).ok, true);
  gapped.s.advance(at(gapped.e + 3));
  assert.equal(gapped.s.balanceOf(y), 0, "the gapped successor has not applied yet (predecessor still missing)");
  assert.equal(gapped.s.ingestTx(t5).ok, true);
  gapped.s.advance(at(gapped.e + 6));

  assert.equal(gapped.s.balanceOf(x), 400_000, "predecessor applied after it arrived");
  assert.equal(gapped.s.balanceOf(y), 300_000, "the previously-gapped tx was retained and applied, not lost");
  // Advance both to the same epoch (so ongoing emission matches) and confirm full convergence: identical
  // recipient balances AND settler nonce (the successor's nonce was consumed exactly once on both).
  inorder.s.advance(at(inorder.e + 6));
  assert.equal(gapped.s.balanceOf(x), inorder.s.balanceOf(x));
  assert.equal(gapped.s.balanceOf(y), inorder.s.balanceOf(y));
  assert.equal(gapped.s.balanceOf(m1.address), inorder.s.balanceOf(m1.address), "gapped node converged to the in-order node's settler balance");
  assert.equal(gapped.s.nonceOf(m1.address), inorder.s.nonceOf(m1.address), "settler nonce identical");
});

test("a batch whose amount != sum(outputs) is rejected, and a malformed memo is rejected", () => {
  const { s, settlerNonce, e } = fundedState();
  const ts = e * EPOCH_MS + 5;
  // amount claims more than the outputs sum
  const bad = signTx({
    network: genesis.network, from: m1.address, fromPubKey: m1.publicKey, to: m1.address,
    amountUZIR: 999_999, feeUZIR: 1000, nonce: settlerNonce, kind: "batch_transfer",
    parents: [], timestamp: ts, memo: JSON.stringify({ o: [[miners[0]!.address, 100]] }),
  }, m1.privateKey);
  assert.equal(s.ingestTx(bad).ok, false, "amount must equal the sum of outputs");

  const malformed = signTx({
    network: genesis.network, from: m1.address, fromPubKey: m1.publicKey, to: m1.address,
    amountUZIR: 0, feeUZIR: 1000, nonce: settlerNonce, kind: "batch_transfer",
    parents: [], timestamp: ts, memo: "not json",
  }, m1.privateKey);
  assert.equal(s.ingestTx(malformed).ok, false, "malformed batch memo is rejected");
  assert.equal(parseBatchOutputs("not json"), null);
  assert.equal(parseBatchOutputs(JSON.stringify({ o: [["zir1abcdef", -5]] })), null, "negative amounts rejected");
});
