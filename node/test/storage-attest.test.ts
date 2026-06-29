// node/test/storage-attest.test.ts
// Storage-proof work credit. A MASTER probes a peer that serves the model for a random chunk, verifies the
// bytes against its own copy, and submits a master-signed `storage_attest` crediting the peer. That sets the
// peer's lastWorkEpoch, so heartbeat (passive mining) emission becomes earnable by a genuine storage/serving
// miner, not only by a paid coordination payout. Only a master's attestation is honored; from anyone else it
// is a no-op. These tests prove the consensus rule directly on State.
import test from "node:test";
import assert from "node:assert/strict";
import {
  keypairFromPrivate, signTx, buildTxBody, standardGenesis, PROTOCOL,
  type GenesisDoc,
} from "@zira/protocol";
import { State, EPOCH_MS, epochOf, GRACE_MS, SETTLE_ROUNDS } from "../src/core/State.js";

const founder = keypairFromPrivate("0a".repeat(32));
const GTS = 1_700_000_000_000;
const m1 = keypairFromPrivate("21".repeat(32)); // genesis master (eligible + can attest)
const m2 = keypairFromPrivate("22".repeat(32));
const m3 = keypairFromPrivate("23".repeat(32));
const miner = keypairFromPrivate("31".repeat(32));   // a non-master storage miner
const other = keypairFromPrivate("32".repeat(32));   // never attested by a master

const masterGenesis: GenesisDoc = {
  ...standardGenesis("devnet", founder.address, GTS),
  masters: [m1, m2, m3].map((k) => ({ address: k.address, pubKey: k.publicKey })),
};

function attest(from: ReturnType<typeof keypairFromPrivate>, miners: string[], nonce: number, ts: number) {
  return signTx(buildTxBody({
    network: "devnet", from: from.address, fromPubKey: from.publicKey, to: from.address,
    amountUZIR: 0, feeUZIR: 0, nonce, kind: "storage_attest", parents: [], timestamp: ts,
    memo: JSON.stringify({ miners }),
  }), from.privateKey);
}
const at = (epoch: number): number => (epoch + SETTLE_ROUNDS + 1) * EPOCH_MS + GRACE_MS + 1;

test("a master's storage_attest credits a non-master miner's work (sets lastWorkEpoch)", () => {
  const s = new State(masterGenesis);
  const e = epochOf(GTS) + 1;
  assert.equal(s.accounts.get(miner.address)?.lastWorkEpoch ?? -1, -1, "miner starts un-credited");
  assert.equal(s.ingestTx(attest(m1, [miner.address], 0, e * EPOCH_MS + 10)).ok, true, "master attest is accepted");
  s.advance(at(e));
  const lwe = s.accounts.get(miner.address)?.lastWorkEpoch ?? -1;
  assert.ok(lwe >= e, "the miner's lastWorkEpoch is set to the epoch the attest applied");
});

test("a NON-master storage_attest is ignored (no credit)", () => {
  const s = new State(masterGenesis);
  const e = epochOf(GTS) + 1;
  // `miner` is not a master; its attest crediting `other` must be a no-op for the credit.
  assert.equal(s.ingestTx(attest(miner, [other.address], 0, e * EPOCH_MS + 10)).ok, true, "tx is well-formed and pools");
  s.advance(at(e));
  assert.equal(s.accounts.get(other.address)?.lastWorkEpoch ?? -1, -1, "a non-master cannot credit work");
  assert.equal(s.accounts.get(miner.address)?.nonce, 1, "the attester's nonce still advanced (tx consumed)");
});

test("a malformed attest memo credits no one and does not throw", () => {
  const s = new State(masterGenesis);
  const e = epochOf(GTS) + 1;
  const bad = signTx(buildTxBody({
    network: "devnet", from: m1.address, fromPubKey: m1.publicKey, to: m1.address, amountUZIR: 0,
    feeUZIR: 0, nonce: 0, kind: "storage_attest", parents: [], timestamp: e * EPOCH_MS + 10, memo: "not json",
  }), m1.privateKey);
  assert.equal(s.ingestTx(bad).ok, true);
  s.advance(at(e));
  assert.equal(s.accounts.get(m1.address)?.nonce, 1, "attester nonce advanced; malformed memo is harmless");
});
