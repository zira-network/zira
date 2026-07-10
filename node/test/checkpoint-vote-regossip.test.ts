// node/test/checkpoint-vote-regossip.test.ts
// Unit proof of the 2026-07-10 finality-freeze fix at the Checkpoints layer.
//
// Root cause of the freeze: voteCheckpoints casts ONE vote per epoch and never re-votes, so a single vote
// lost to a gossipsub mesh race leaves that epoch permanently below quorum — finalizedEpoch stops advancing
// while currentEpoch keeps climbing (the exact "frozen finality, growing gap" signature).
//
// The fix: each node re-broadcasts the votes it is holding for still-unfinalized epochs
// (Checkpoints.recentUnfinalizedVotes). Re-delivery is idempotent (signed + de-duped by the `seen` set) and
// consensus-neutral (it only re-sends votes that already exist, never invents a root), so a lagging master
// eventually collects the missing vote and the epoch crosses quorum.
//
// This test induces a lost vote (an epoch stuck at 2/4 = below the 0.67 threshold), proves the held votes are
// retrievable for re-gossip, and proves that re-delivering the missing vote finalizes the epoch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeypair } from "@zira/protocol";
import { Checkpoints } from "../src/core/Checkpoints.ts";

test("a vote lost to a mesh race is re-gossippable and, once re-delivered, crosses quorum (no permanent split)", () => {
  const cp = new Checkpoints("mainnet");

  // 4 genesis masters, each pinned at full trust; quorum threshold is 0.67 -> needs > 2.68 of 4.0 trust,
  // i.e. 2/4 votes (2.0) is BELOW quorum and 3/4 (3.0) is ABOVE. Clear margin on both sides.
  const M = [generateKeypair(), generateKeypair(), generateKeypair(), generateKeypair()];
  const totalMasterTrust = 4.0;
  const masterMap = new Map(M.map((k) => [k.publicKey, 1.0] as const));

  const EPOCH = 42;
  const ROOT = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4"; // deterministic emission -> every master computes the same root
  const supply = { emitted: 1000, burned: 0, reserve: 0 };

  // Every master signs its own vote for the same (epoch, root). Each stamps its own wall-clock time (as the
  // live node does), so the votes have distinct ids and are counted independently. In the freeze, these
  // scatter across the mesh and no single master ever collects a quorum of them.
  const votes = M.map((k, i) => cp.createVote(EPOCH, ROOT, supply, k, 1.0, 1_700_000_000_000 + i));

  // INDUCE THE LOST VOTE: this master only ever received votes 0 and 1 (its own + one peer). Votes 2 and 3
  // were dropped by the mesh. 2/4 = 2.0 trust < 2.68 -> the epoch cannot finalize.
  assert.equal(cp.receiveVote(votes[0]!, totalMasterTrust, masterMap), null, "vote 0: below quorum");
  assert.equal(cp.receiveVote(votes[1]!, totalMasterTrust, masterMap), null, "vote 1: still below quorum");
  assert.notEqual(cp.lastFinalizedEpoch, EPOCH, "epoch is NOT finalized while a vote is lost (the freeze)");

  // THE RE-GOSSIP SOURCE: the held votes for the unfinalized epoch are retrievable so the node can re-broadcast
  // them. This is what was missing — without it the epoch stays split forever.
  const held = cp.recentUnfinalizedVotes(200);
  assert.equal(held.length, 2, "the two held votes are available for re-gossip");
  assert.ok(held.every((v) => v.epoch === EPOCH && v.stateRoot === ROOT), "held votes are for the stuck epoch/root");

  // Re-delivering an already-seen vote is a harmless no-op (idempotent dedup), so re-gossip cannot double-count.
  assert.equal(cp.receiveVote(votes[0]!, totalMasterTrust, masterMap), null, "re-delivering a seen vote does nothing");
  assert.notEqual(cp.lastFinalizedEpoch, EPOCH, "a re-sent duplicate cannot manufacture quorum");

  // THE HEAL: a peer re-gossips the vote this master had lost. Now it holds 3/4 = 3.0 trust >= 2.68 -> finalize.
  const fin = cp.receiveVote(votes[2]!, totalMasterTrust, masterMap);
  assert.ok(fin, "re-delivering the lost vote finalizes the epoch");
  assert.equal(fin!.epoch, EPOCH, "the previously-stuck epoch is the one that finalized");
  assert.equal(fin!.stateRoot, ROOT, "finalized on the one agreed root (no fork)");
  assert.equal(cp.lastFinalizedEpoch, EPOCH, "finality advanced past the freeze");

  // Once finalized, the epoch drops out of the re-gossip set (only UNfinalized votes are re-sent).
  assert.equal(cp.recentUnfinalizedVotes(200).length, 0, "a finalized epoch is no longer re-gossiped");
});
