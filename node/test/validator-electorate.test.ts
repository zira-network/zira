// node/test/validator-electorate.test.ts
// Decentralization cutover, Phase 3/4 (active path, via the test activation override). Proves that when the
// cutover is ACTIVE, an eligible community node (here via the anchor path — owning an anchor seat and running
// a node so it has a signing pubkey) is sealed into the root-committed validator registry, is admitted to the
// finality electorate at equal weight, and — the critical fork-safety property — two independent nodes with
// the same applied history compute the IDENTICAL state root (registry included), while a dormant node keeps
// the legacy root. This is the empirical determinism guarantee behind flipping the electorate on.
import test from "node:test";
import assert from "node:assert/strict";
import { keypairFromPrivate, standardGenesis, signTx, type GenesisDoc } from "@zira/protocol";
import { State, EPOCH_MS, epochOf, GRACE_MS, SETTLE_ROUNDS } from "../src/core/State.js";

const founder = keypairFromPrivate("0a".repeat(32));
const GTS = 1_700_000_000_000;
const m1 = keypairFromPrivate("11".repeat(32));
const m2 = keypairFromPrivate("12".repeat(32));
const m3 = keypairFromPrivate("13".repeat(32));
const val = keypairFromPrivate("51".repeat(32)); // a community node that owns anchor A-001 and runs a node
const base = standardGenesis("devnet", founder.address, GTS);
const genesis: GenesisDoc = {
  ...base,
  masters: [m1, m2, m3].map((k) => ({ address: k.address, pubKey: k.publicKey })),
  // Give the community node two anchor seats of DIFFERENT classes (A = top trust 0.95, F = bottom 0.45) to
  // prove the six classes carry different finality weight and a holder votes at its BEST class.
  anchorOwnership: [{ seatId: "A-001", owner: val.address }, { seatId: "F-144", owner: val.address }],
  allocations: [...base.allocations, { address: val.address, amountUZIR: 10_000_000, note: "test validator float" }],
};
const at = (epoch: number): number => (epoch + SETTLE_ROUNDS + 2) * EPOCH_MS + GRACE_MS + 1;
const ACT = 1; // activation override: active at every live epoch here (~3.4e8)

// Make `val` an eligible validator via the ANCHOR path. It must be an ACTUAL CONTRIBUTOR, using only
// deterministic applied-state signals: a signing pubkey on ledger (self-transfer), participation in field
// convergence (activeEpochs), and recent master-vouched work (lastWorkEpoch). The real pipeline that sets
// activeEpochs/lastWorkEpoch identically across nodes is proven by storage-vouch + heartbeat-emission tests;
// here we set them directly (identically on both nodes) to unit-test the SEAL's determinism.
function driveToSeal(s: State): void {
  const e = epochOf(GTS) + 1;
  s.advance(at(e));
  const ts = (e + 1) * EPOCH_MS + 5;
  const tx = signTx({
    network: genesis.network, from: val.address, fromPubKey: val.publicKey, to: val.address,
    amountUZIR: 1, feeUZIR: 1000, nonce: 0, kind: "transfer", parents: [], timestamp: ts, memo: "",
  }, val.privateKey);
  assert.equal(s.ingestTx(tx).ok, true);
  s.advance(at(e + SETTLE_ROUNDS + 5)); // applies the tx -> pubkey on ledger
  const acct = s.accounts.get(val.address)!;
  acct.activeEpochs = Math.max(acct.activeEpochs, 1);      // participated in applied field convergence
  acct.lastWorkEpoch = s.lastProcessedEpoch;               // a genesis master vouched its work recently
  s.advance(at(s.lastProcessedEpoch + 2));                 // seal picks up the now-eligible contributor
}

test("an anchor-holding community node is sealed into the electorate; two active nodes agree on the root", () => {
  const a = new State(genesis, ACT);
  const b = new State(genesis, ACT);
  driveToSeal(a);
  driveToSeal(b);

  // Sealed into the root-committed registry on both nodes.
  assert.deepEqual(a.validatorRegistry(), [val.address], "the anchor holder is a sealed validator (node a)");
  assert.deepEqual(b.validatorRegistry(), [val.address], "the anchor holder is a sealed validator (node b)");
  // Admitted at its BEST anchor class trust: it holds class A (0.95) and class F (0.45), so it votes 0.95 —
  // proving the six classes carry different weight and the higher class wins (not flat 1.0, not the F 0.45).
  assert.equal(a.masterZtiMap().get(val.publicKey), 0.95, "validator votes at its best class trust (A=0.95, not F=0.45)");
  assert.ok(a.isAuthorizedSettler(val.address), "the validator may issue pool_payout");
  // 3 genesis masters (zti 1.0 each) + 1 class-A validator (0.95) = 3.95 finality trust.
  assert.equal(a.totalMasterTrust(), 3.95, "the electorate grew by the validator's class weight");
  // The RPC/monitoring view (GET /validators) reports the same, identically on both nodes.
  const view = a.decentralizationView();
  assert.equal(view.active, true);
  assert.deepEqual(view.validators, [{ address: val.address, weight: 0.95 }], "view lists the validator + its class weight");
  assert.equal(view.totalMasterTrust, 3.95);
  assert.deepEqual(a.decentralizationView(), b.decentralizationView(), "the decentralization view is identical across nodes");
  // THE fork-safety property: identical applied history => identical state root, registry included.
  assert.equal(a.stateRoot(), b.stateRoot(), "two active nodes compute the identical root");
});

test("a dormant node never seals the validator and keeps the legacy (registry-free) root", () => {
  const active = new State(genesis, ACT);
  const dormant = new State(genesis);        // default activation (0 = disabled)
  driveToSeal(active);
  driveToSeal(dormant);

  assert.deepEqual(dormant.validatorRegistry(), [], "dormant node seals no validators");
  assert.equal(dormant.totalMasterTrust(), 3.0, "dormant electorate stays the 3 genesis masters");
  // The active node committed the validator leaf, so its root DIFFERS from the dormant (legacy) root even
  // though accounts/supply are identical — proving the registry is actually committed to the root.
  assert.notEqual(active.stateRoot(), dormant.stateRoot(), "the sealed registry changes the root");
});
