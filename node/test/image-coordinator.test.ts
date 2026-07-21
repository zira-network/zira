// node/test/image-coordinator.test.ts
// The dormant, flag-gated image-job coordinator (2.9.0 Track A / A5). Proves: it is inert unless enabled;
// jobs coalesce by deterministic id; provider commitments settle via the pure perceptual agreement and report
// exactly whom to pay; mismatched or excess commitments are rejected (bounded, anti-abuse); settlement is
// idempotent; and stale jobs expire.
import test from "node:test";
import assert from "node:assert/strict";
import { ImageCoordinator, type ImageJobRequest } from "../src/image/ImageCoordinator.js";
import { dHash, type ImageCommitment } from "@zira/protocol";

// Structured (non-degenerate) grayscale pattern; `noise` = honest cross-hardware drift; different (fx,fy) = a
// different image.
function img(fx: number, fy: number, noise = 0): Uint8Array {
  const w = 64, h = 64, px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const base = ((x * fx + y * fy) % 32) * 8;
    const j = noise ? ((x * 7 + y * 13) % (2 * noise + 1)) - noise : 0;
    px[y * w + x] = Math.max(0, Math.min(255, base + j));
  }
  return px;
}

const REQ: ImageJobRequest = { prompt: "a lighthouse at dawn", params: { steps: 20 }, modelId: "sd-turbo", seed: 7, asker: "zir1asker" };

function commit(job: { seed: number; modelId: string; paramsHash: string }, provider: string, luma: Uint8Array): ImageCommitment {
  return { provider, pHash: dHash(luma, 64, 64), seed: job.seed, modelId: job.modelId, paramsHash: job.paramsHash };
}

test("dormant by default: openJob is inert unless enabled", () => {
  const off = new ImageCoordinator({ enabled: false });
  assert.equal(off.isEnabled(), false);
  assert.equal(off.openJob(REQ, 1000), null);
  assert.equal(off.size(), 0);
});

test("opens a job, coalesces identical requests, settles on perceptual agreement", () => {
  const c = new ImageCoordinator({ enabled: true });
  const job = c.openJob(REQ, 1000);
  assert.ok(job, "job opened");
  // identical request returns the same job (deterministic id), not a duplicate
  const again = c.openJob(REQ, 1001);
  assert.equal(again!.jobId, job!.jobId);
  assert.equal(c.size(), 1);

  // one commitment: not settled yet
  const r1 = c.addCommitment(job!.jobId, commit(job!, "zir1p1", img(3, 1)), 1002);
  assert.equal(r1, null);
  // a second, perceptually-agreeing commitment: settles and names both providers
  const r2 = c.addCommitment(job!.jobId, commit(job!, "zir1p2", img(3, 1, 4)), 1003);
  assert.ok(r2 && r2.agreed);
  assert.deepEqual(r2!.agreeingProviders, ["zir1p1", "zir1p2"]);
  // a disagreeing third commitment does not change the already-settled outcome (idempotent)
  const r3 = c.addCommitment(job!.jobId, commit(job!, "zir1p3", img(1, 5)), 1004);
  assert.deepEqual(r3!.agreeingProviders, ["zir1p1", "zir1p2"]);
});

test("rejects commitments that do not match the job binding", () => {
  const c = new ImageCoordinator({ enabled: true });
  const job = c.openJob(REQ, 1000)!;
  const wrong: ImageCommitment = { ...commit(job, "zir1p1", img(3, 1)), seed: 999 };
  assert.equal(c.addCommitment(job.jobId, wrong, 1001), null);
  assert.equal(job.commitments.length, 0);
});

test("bounded: caps commitments per job and total jobs (anti-abuse)", () => {
  const c = new ImageCoordinator({ enabled: true, maxCommitmentsPerJob: 2, maxJobs: 1 });
  const job = c.openJob(REQ, 1000)!;
  c.addCommitment(job.jobId, commit(job, "zir1a", img(3, 1)), 1001);
  c.addCommitment(job.jobId, commit(job, "zir1b", img(1, 5)), 1002);
  c.addCommitment(job.jobId, commit(job, "zir1c", img(5, 2)), 1003); // exceeds cap, dropped
  assert.equal(job.commitments.length, 2);
  // maxJobs reached: a different request cannot open a new job
  const other = c.openJob({ ...REQ, prompt: "something else" }, 1004);
  assert.equal(other, null);
});

test("stale jobs expire to bound memory", () => {
  const c = new ImageCoordinator({ enabled: true, ttlMs: 5000 });
  const job = c.openJob(REQ, 1000)!;
  assert.equal(c.size(), 1);
  // opening any job runs expiry; advance the clock past TTL
  c.openJob({ ...REQ, prompt: "later" }, 1000 + 6000);
  assert.equal(c.getJob(job.jobId), undefined);
});

test("settler payout plan: splits price among agreeing providers, deterministic, no double-pay", () => {
  const c = new ImageCoordinator({ enabled: true });
  const job = c.openJob(REQ, 1000)!;
  c.addCommitment(job.jobId, commit(job, "zir1p1", img(3, 1)), 1001);
  c.addCommitment(job.jobId, commit(job, "zir1p2", img(3, 1, 4)), 1002); // settles: p1+p2 agree
  const paid = new Set<string>();
  const plan1 = c.drainSettledPayouts(1000, paid);
  assert.deepEqual([...plan1.payouts.entries()].sort(), [["zir1p1", 500], ["zir1p2", 500]]);
  assert.deepEqual(plan1.paidJobIds, [job.jobId]);
  // mark paid -> a second drain yields nothing (no double-pay across settler failover)
  plan1.paidJobIds.forEach((id) => paid.add(id));
  const plan2 = c.drainSettledPayouts(1000, paid);
  assert.equal(plan2.payouts.size, 0);
  assert.equal(plan2.paidJobIds.length, 0);
});

test("settler payout plan: an unsettled job pays nobody", () => {
  const c = new ImageCoordinator({ enabled: true });
  const job = c.openJob(REQ, 1000)!;
  c.addCommitment(job.jobId, commit(job, "zir1p1", img(3, 1)), 1001); // lone commitment, not settled
  const plan = c.drainSettledPayouts(1000, new Set());
  assert.equal(plan.payouts.size, 0);
});
