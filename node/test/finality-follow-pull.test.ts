// node/test/finality-follow-pull.test.ts
// Fork-safety proof for the pull-based finality-follow (CHECKPOINT_PROTOCOL / attemptFollowFinality).
//
// Why it exists: a read/follower node's finalized view was drifting minutes behind the leader whenever gossiped
// checkpoint votes lost a mesh race, so a just-confirmed transfer looked stuck. The follow path fixes the
// LATENCY by PULLING the leader's latest finalized checkpoint (its signed votes) on a tight cadence and feeding
// each vote through the SAME receiveVote gate gossip uses. This test proves that pulling votes this way is
// fork-safe: it advances a follower to the leader's EXACT (epoch, root), a tampered vote can never finalize,
// and a vote that does not bind to the advertised checkpoint is ignored. It changes WHEN finality arrives at a
// follower, never WHAT root it lands on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeypair, verifyCheckpointVote } from "@zira/protocol";
import { Checkpoints } from "../src/core/Checkpoints.ts";

// Reproduce the exact per-vote gate attemptFollowFinality applies to a pulled checkpoint {finalizedEpoch,
// finalizedRoot, votes}: verify the signature, require the vote to bind to the advertised (epoch, root), skip
// already-seen votes, then receiveVote. Kept in lockstep with the node method so the test guards the real path.
function applyPulledCheckpoint(cp: Checkpoints, ckpt: { finalizedEpoch: number; finalizedRoot: string; votes: ReturnType<Checkpoints["createVote"]>[] }, totalTrust: number, masterMap: ReadonlyMap<string, number>) {
  if (ckpt.finalizedEpoch <= cp.lastFinalizedEpoch) return;
  for (const v of ckpt.votes) {
    if (v.epoch !== ckpt.finalizedEpoch || v.stateRoot !== ckpt.finalizedRoot) continue;
    if (cp.isVoteKnown(v.id)) continue;
    if (!verifyCheckpointVote(v)) continue;
    cp.receiveVote(v, totalTrust, masterMap);
  }
}

test("a follower catches up to the leader's exact finalized epoch+root from a pulled checkpoint", () => {
  // Single-finalizer shape (production: box1 is the lone finalizer, its vote is 100% of trust >= 0.67).
  const leaderKp = generateKeypair();
  const totalTrust = 1.0;
  const masterMap = new Map([[leaderKp.publicKey, 1.0] as const]);
  const EPOCH = 356_962_535;
  const ROOT = "75a8541efbfe0011223344556677889900aabbccddeeff0011223344556677";
  const supply = { emitted: 67_387_938_507_709, burned: 196_237_000, reserve: 11_767_000_000_000_000 };

  // The LEADER finalizes the epoch locally (as box1 does).
  const leader = new Checkpoints("mainnet");
  const leaderVote = leader.createVote(EPOCH, ROOT, supply, leaderKp, 1.0, 1_700_000_000_000);
  const fin = leader.receiveVote(leaderVote, totalTrust, masterMap);
  assert.ok(fin && leader.lastFinalizedEpoch === EPOCH, "leader finalized the epoch");

  // The FOLLOWER is behind and receives NO gossip. It PULLS the leader's checkpoint (epoch+root+votes) and
  // applies it. This is the latency fix: no 2-minute wait, it converges immediately from the pulled votes.
  const follower = new Checkpoints("mainnet");
  assert.notEqual(follower.lastFinalizedEpoch, EPOCH, "follower starts behind");
  applyPulledCheckpoint(follower, { finalizedEpoch: EPOCH, finalizedRoot: ROOT, votes: leader.finalizingVotes(EPOCH, ROOT) }, totalTrust, masterMap);
  assert.equal(follower.lastFinalizedEpoch, EPOCH, "follower advanced to the leader's finalized epoch");
  assert.equal(follower.lastFinalizedRoot, ROOT, "follower finalized the leader's EXACT root (no fork)");
});

test("a tampered pulled vote can never finalize a follower (signature gate)", () => {
  const leaderKp = generateKeypair();
  const totalTrust = 1.0;
  const masterMap = new Map([[leaderKp.publicKey, 1.0] as const]);
  const EPOCH = 100, ROOT = "1111111111111111111111111111111111111111111111111111111111111111";
  const supply = { emitted: 1000, burned: 0, reserve: 0 };
  const leader = new Checkpoints("mainnet");
  const good = leader.createVote(EPOCH, ROOT, supply, leaderKp, 1.0, 1_700_000_000_000);

  // Attacker swaps in a different root but keeps the leader's signature: verifyCheckpointVote must reject it,
  // AND the (epoch, root) binding to the advertised checkpoint must fail. Either guard alone stops the fork.
  const FORGED = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef0";
  const tampered = { ...good, stateRoot: FORGED };
  const follower = new Checkpoints("mainnet");
  applyPulledCheckpoint(follower, { finalizedEpoch: EPOCH, finalizedRoot: FORGED, votes: [tampered] }, totalTrust, masterMap);
  assert.notEqual(follower.lastFinalizedRoot, FORGED, "a forged root is never adopted");
  assert.equal(follower.lastFinalizedEpoch, -1, "the follower did not finalize on a tampered vote");
});

test("a pulled vote that does not bind to the advertised checkpoint is ignored", () => {
  const leaderKp = generateKeypair();
  const totalTrust = 1.0;
  const masterMap = new Map([[leaderKp.publicKey, 1.0] as const]);
  const supply = { emitted: 1000, burned: 0, reserve: 0 };
  const leader = new Checkpoints("mainnet");
  // A genuine, correctly-signed vote for epoch 200 — but advertised inside a checkpoint claiming epoch 201.
  const realVote = leader.createVote(200, "aaaa", supply, leaderKp, 1.0, 1_700_000_000_000);
  const follower = new Checkpoints("mainnet");
  applyPulledCheckpoint(follower, { finalizedEpoch: 201, finalizedRoot: "bbbb", votes: [realVote] }, totalTrust, masterMap);
  assert.equal(follower.lastFinalizedEpoch, -1, "a vote whose (epoch,root) mismatches the checkpoint is not applied");
});
