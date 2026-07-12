// node/test/single-finalizer-electorate.test.ts
// Unit-level proof of the single-finalizer electorate gate (Phase 1). Dormant => classic 4-master electorate;
// active (past the activation epoch) => the electorate is exactly the leader, whose vote is then 100% of trust.
// The managed-failover lever (finalityLeaderIndex) selects which genesis master leads, deterministically.
import test from "node:test";
import assert from "node:assert/strict";
import { keypairFromPrivate, standardGenesis, type GenesisDoc } from "@zira/protocol";
import { State, EPOCH_MS, epochOf, GRACE_MS, SETTLE_ROUNDS } from "../src/core/State.js";

const founder = keypairFromPrivate("0a".repeat(32));
const GTS = 60 * 5_666_668 * EPOCH_MS;
const genEpoch = epochOf(GTS);
const masters = [
  keypairFromPrivate("61".repeat(32)), keypairFromPrivate("62".repeat(32)),
  keypairFromPrivate("63".repeat(32)), keypairFromPrivate("64".repeat(32)),
];
const genesis: GenesisDoc = {
  ...standardGenesis("devnet", founder.address, GTS),
  masters: masters.map((k) => ({ address: k.address, pubKey: k.publicKey })),
};
const at = (e: number) => (e + SETTLE_ROUNDS + 2) * EPOCH_MS + GRACE_MS + 1;
// leader is the idx-th genesis master in GENESIS-DOC order (= the `masters` array order, deterministic).
const orderedLeader = (idx: number) => masters[idx]!;

function build(activationEnv?: string, leaderIdxEnv?: string): State {
  const prevA = process.env.ZIRA_SINGLE_FINALIZER_ACTIVATION_EPOCH;
  const prevL = process.env.ZIRA_FINALITY_LEADER_INDEX;
  if (activationEnv === undefined) delete process.env.ZIRA_SINGLE_FINALIZER_ACTIVATION_EPOCH;
  else process.env.ZIRA_SINGLE_FINALIZER_ACTIVATION_EPOCH = activationEnv;
  if (leaderIdxEnv === undefined) delete process.env.ZIRA_FINALITY_LEADER_INDEX;
  else process.env.ZIRA_FINALITY_LEADER_INDEX = leaderIdxEnv;
  const s = new State(genesis);
  s.advance(at(genEpoch + 40)); // move lastProcessedEpoch well past any small activation epoch
  if (prevA === undefined) delete process.env.ZIRA_SINGLE_FINALIZER_ACTIVATION_EPOCH; else process.env.ZIRA_SINGLE_FINALIZER_ACTIVATION_EPOCH = prevA;
  if (prevL === undefined) delete process.env.ZIRA_FINALITY_LEADER_INDEX; else process.env.ZIRA_FINALITY_LEADER_INDEX = prevL;
  return s;
}

test("pre-activation: classic 4-master electorate (a far-future activation epoch keeps it dormant)", () => {
  const s = build("999999999999");
  assert.equal(s.singleFinalizerActiveNow(), false);
  assert.equal(s.masterZtiMap().size, 4, "all 4 genesis masters are electors");
  assert.equal(s.totalMasterTrust(), 4, "total trust = 4 masters at zti 1.0");
});

test("active: electorate is exactly the leader (index 0), whose vote is 100% of trust", () => {
  const s = build("1"); // activate from epoch 1 (already past)
  assert.equal(s.singleFinalizerActiveNow(), true);
  const m = s.masterZtiMap();
  assert.equal(m.size, 1, "only the leader is an elector");
  const leader = orderedLeader(0);
  assert.ok(m.has(leader.publicKey), "the elector is the index-0 genesis master by sorted address");
  assert.equal(s.totalMasterTrust(), 1, "total trust = the leader alone");
  // the leader's own vote (1.0) / total (1.0) = 100% >= 0.67 -> finalizes alone
  assert.ok((m.get(leader.publicKey) ?? 0) / s.totalMasterTrust() >= 0.67, "leader alone crosses the finality threshold");
});

test("managed failover: finalityLeaderIndex promotes another genesis master, deterministically", () => {
  const s = build("1", "2");
  const m = s.masterZtiMap();
  assert.equal(m.size, 1);
  const leader = orderedLeader(2);
  assert.ok(m.has(leader.publicKey), "leader index 2 selects the 3rd genesis master by sorted address on every node");
});
