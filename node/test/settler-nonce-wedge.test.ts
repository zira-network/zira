// node/test/settler-nonce-wedge.test.ts
// REGRESSION for a live mainnet incident (2026-07-05): the network settler's nonce froze and every field-
// participation payout stopped APPLYING (they still logged, because the log fires on submit-accept, not on
// apply), so miners earned nothing. Root mechanism: a batch_transfer that OVERSPENDS at apply is dropped
// WITHOUT consuming the sender's nonce (State.applyTx overspend paths), so it stays pinned at the sender's
// committed nonce forever; meanwhile the settler keeps issuing valid payouts at provisionalNonce = committed +
// pooledCount (i.e. NONCE+1, +2, ...), which are all future-nonce gaps that can never apply while the wedge
// sits at the committed nonce. Result: nonce frozen, valid payouts never land. This is the exact "a tx sits in
// the pool forever, silently occupying its sender's nonce and blocking every later tx" failure the ingestTx
// guard (non-finite timestamp) already calls out — but an unaffordable tx reaches the pool and wedges the same
// way. These tests pin the wedge and prove the self-heal: an unaffordable tx pinned at the committed nonce is
// dropped after a bounded, deterministic TTL WITH a nonce skip, so the sender's later payouts drain and miners
// are paid again. The skip is a pure function of (nonce, timestamp, epoch), so every node does it identically
// and the state root never diverges.
import test from "node:test";
import assert from "node:assert/strict";
import { keypairFromPrivate, signTx, standardGenesis, type GenesisDoc } from "@zira/protocol";
import { State, EPOCH_MS, epochOf, GRACE_MS, SETTLE_ROUNDS } from "../src/core/State.js";

const founder = keypairFromPrivate("0a".repeat(32));
const GTS = 1_700_000_000_000;
const m1 = keypairFromPrivate("11".repeat(32)); // masters[0] = settler
const m2 = keypairFromPrivate("12".repeat(32));
const m3 = keypairFromPrivate("13".repeat(32));
const genesis: GenesisDoc = {
  ...standardGenesis("devnet", founder.address, GTS),
  masters: [m1, m2, m3].map((k) => ({ address: k.address, pubKey: k.publicKey })),
};
const at = (epoch: number): number => (epoch + SETTLE_ROUNDS + 2) * EPOCH_MS + GRACE_MS + 1;

// A batch_transfer from the settler paying `payee` `amt`, at a chosen nonce and timestamp.
function batch(nonce: number, tsEpoch: number, payee: string, amt: number, poolAmt = amt): ReturnType<typeof signTx> {
  return signTx({
    network: genesis.network, from: m1.address, fromPubKey: m1.publicKey, to: m1.address,
    amountUZIR: poolAmt, feeUZIR: 1000, nonce, kind: "batch_transfer",
    parents: [], timestamp: tsEpoch * EPOCH_MS + 5, memo: JSON.stringify({ o: [[payee, amt]] }),
  }, m1.privateKey);
}

test("an unaffordable payout pinned at the settler's committed nonce must not freeze all later payouts forever", () => {
  const s = new State(genesis);
  const e = epochOf(GTS) + 40;
  s.advance(at(e));                                       // fund the settler from base emission
  const bal = s.balanceOf(m1.address);
  assert.ok(bal > 5_000_000_000, `settler funded (${bal})`);
  const startNonce = s.nonceOf(m1.address);

  const payee = keypairFromPrivate("41".repeat(32)).address;
  const baseEpoch = e + 1;
  // A PERMANENT wedge: a batch whose declared amount dwarfs anything the settler could ever accrue (so, unlike
  // a merely temporarily-underfunded tx, base emission never makes it affordable). It ingests (ingest does not
  // check balance) but can never apply, so it pins the committed nonce until the self-heal skips it. This models
  // the live incident, where the settler held ~9.4M ZIR yet its nonce stayed frozen for 20+ minutes.
  const tooBig = bal + 1_000_000_000_000_000; // + 1e9 ZIR: unaffordable for the entire test window
  assert.equal(s.ingestTx(batch(startNonce, baseEpoch, payee, tooBig)).ok, true, "the unaffordable batch ingests");
  // Then a stream of perfectly good, affordable payouts at the next nonces (what the live settler keeps doing).
  for (let i = 1; i <= 5; i++) {
    assert.equal(s.ingestTx(batch(startNonce + i, baseEpoch + i, payee, 1_000_000)).ok, true, `good payout ${i} ingests`);
  }

  // Advance well past the gap TTL so the wedge has had every chance to clear on its own.
  s.advance(at(baseEpoch + 200));

  // The self-heal contract: the wedge is eventually skipped, the good payouts apply, and the payee is paid.
  assert.notEqual(s.nonceOf(m1.address), startNonce, "settler nonce must not be frozen at the wedge");
  assert.equal(s.balanceOf(payee), 5_000_000, "all five affordable payouts eventually credit the payee");
});

test("a healthy stream of affordable payouts drains normally (no regression)", () => {
  const s = new State(genesis);
  const e = epochOf(GTS) + 40;
  s.advance(at(e));
  const startNonce = s.nonceOf(m1.address);
  const payee = keypairFromPrivate("42".repeat(32)).address;
  const baseEpoch = e + 1;
  for (let i = 0; i < 5; i++) assert.equal(s.ingestTx(batch(startNonce + i, baseEpoch + i, payee, 2_000_000)).ok, true);
  s.advance(at(baseEpoch + 20));
  assert.equal(s.balanceOf(payee), 10_000_000, "every affordable payout credits");
  assert.equal(s.nonceOf(m1.address), startNonce + 5, "nonce advanced by exactly the applied count");
});
