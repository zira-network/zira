// Checkpoint finality bookkeeping (vote buckets, the dedup set, the finalized map) must not grow
// without limit on a long-running node or under a vote flood. These structures are NOT part of the
// deterministic state root, so pruning settled history is consensus-neutral. The latest finalized
// checkpoint (the one fast-sync serves) and recent epochs are always retained.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeypair } from "@zira/protocol";
import { Checkpoints } from "../src/core/Checkpoints.ts";

test("checkpoint structures stay bounded across many finalized epochs", () => {
  const cp = new Checkpoints("mainnet");
  const master = generateKeypair();
  const masterMap = new Map([[master.publicKey, 1.0]]); // single master at full trust finalizes each epoch
  const N = 4200; // just over FINALIZED_CAP (4096) so the cap is exercised
  const rootFor = (e: number) => "root" + e.toString(16).padStart(8, "0");

  for (let epoch = 0; epoch < N; epoch++) {
    const vote = cp.createVote(epoch, rootFor(epoch), { emitted: epoch, burned: 0, reserve: 0 }, master, 1.0, 1_700_000_000_000 + epoch);
    cp.receiveVote(vote, 1.0, masterMap);
  }

  // Finality still works and advanced to the last epoch.
  assert.equal(cp.lastFinalizedEpoch, N - 1, "advanced to the last epoch");
  assert.equal(cp.lastFinalizedRoot, rootFor(N - 1), "tracks the latest finalized root");

  // The finalized map is capped (FINALIZED_CAP = 4096), not 5000.
  assert.ok(cp.finalized.size <= 4096, `finalized bounded, got ${cp.finalized.size}`);
  assert.ok(cp.finalized.size >= 4000, `but still retains a deep window, got ${cp.finalized.size}`);

  // The latest finalized checkpoint and its proving votes are retained (fast-sync depends on this).
  assert.ok(cp.finalized.has(N - 1), "keeps the latest finalized checkpoint");
  assert.ok(cp.finalizingVotes(N - 1, rootFor(N - 1)).length >= 1, "keeps votes proving the latest checkpoint");

  // Deep history is pruned: epoch 0's vote bucket and finalized entry are gone.
  assert.equal(cp.finalizingVotes(0, rootFor(0)).length, 0, "drops deep-history vote buckets");
  assert.ok(!cp.finalized.has(0), "drops deep-history finalized entries");
});
