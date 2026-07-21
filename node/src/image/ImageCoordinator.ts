// node/src/image/ImageCoordinator.ts
// Text-to-image job coordination (2.9.0 Track A / A5), DORMANT by default (ZIRA_IMAGE_ENABLE != "1").
//
// This is the node-side orchestration that sits between the protocol's fork-safe perceptual-agreement
// primitives and the (later) RPC + provider-serving + settler wiring. It owns the image-job lifecycle:
//   open a job -> collect provider commitments (one per provider) -> when enough perceptually agree, settle and
//   report exactly which providers to pay.
// It holds NO image bytes (those flow asker <- provider out of band) and touches NO consensus state directly:
// settlement is decided by the pure `imageAgreementOutcome`, and the node drives its existing signed payout
// path with the returned providers. Everything is bounded (max jobs, max commitments, TTL) so a public net
// cannot exhaust memory (G6). Flag-gated so the whole feature is inert until armed.

import {
  imageAgreementOutcome, imageJobId, imageParamsHash, normalizeImageParams, IMAGE_AGREEMENT,
  type ImageCommitment, type ImageParams, type ImageAgreementResult,
} from "@zira/protocol";

export interface ImageJobRequest {
  prompt: string;
  params?: Partial<ImageParams>;
  modelId: string;
  seed: number;
  asker: string;
}

export interface ImageJob {
  jobId: string;
  prompt: string;
  params: ImageParams;
  paramsHash: string;
  modelId: string;
  seed: number;
  asker: string;
  createdAt: number;
  commitments: ImageCommitment[];
  settlement: ImageAgreementResult | null;
}

export interface ImageCoordinatorOptions {
  enabled?: boolean;             // overrides the env flag (for tests / explicit control)
  maxJobs?: number;              // bound on concurrently-open jobs
  maxCommitmentsPerJob?: number; // bound on commitments retained per job
  ttlMs?: number;                // how long an unsettled job stays open
  minAgree?: number;             // providers required to settle
  maxHamming?: number;           // perceptual distance threshold
}

const DEFAULTS = {
  maxJobs: 256,
  maxCommitmentsPerJob: 32,
  ttlMs: 120_000,
  minAgree: IMAGE_AGREEMENT.MIN_AGREE,
  maxHamming: IMAGE_AGREEMENT.MAX_HAMMING,
};

export class ImageCoordinator {
  private jobs = new Map<string, ImageJob>();
  private readonly enabled: boolean;
  private readonly maxJobs: number;
  private readonly maxCommitmentsPerJob: number;
  private readonly ttlMs: number;
  private readonly minAgree: number;
  private readonly maxHamming: number;

  constructor(opts: ImageCoordinatorOptions = {}) {
    this.enabled = opts.enabled ?? (process.env.ZIRA_IMAGE_ENABLE === "1");
    this.maxJobs = opts.maxJobs ?? DEFAULTS.maxJobs;
    this.maxCommitmentsPerJob = opts.maxCommitmentsPerJob ?? DEFAULTS.maxCommitmentsPerJob;
    this.ttlMs = opts.ttlMs ?? DEFAULTS.ttlMs;
    this.minAgree = opts.minAgree ?? DEFAULTS.minAgree;
    this.maxHamming = opts.maxHamming ?? DEFAULTS.maxHamming;
  }

  isEnabled(): boolean { return this.enabled; }

  /** Open (or return the existing) job for a request. Returns null when the feature is dormant. Deterministic
   * jobId so the same request from the same asker coalesces rather than spawning duplicates. */
  openJob(req: ImageJobRequest, now: number): ImageJob | null {
    if (!this.enabled) return null;
    this.expire(now);
    const params = normalizeImageParams(req.params);
    const paramsHash = imageParamsHash(params);
    const jobId = imageJobId(req.prompt, params, req.modelId, req.seed, req.asker);
    const existing = this.jobs.get(jobId);
    if (existing) return existing;
    if (this.jobs.size >= this.maxJobs) return null; // bounded: refuse rather than grow unbounded
    const job: ImageJob = {
      jobId, prompt: String(req.prompt).slice(0, 4000), params, paramsHash,
      modelId: req.modelId, seed: req.seed, asker: req.asker, createdAt: now,
      commitments: [], settlement: null,
    };
    this.jobs.set(jobId, job);
    return job;
  }

  /** Record a provider's commitment. One per provider (a later commitment replaces an earlier one from the
   * same provider). Rejects commitments that do not match the job's binding (seed/model/paramsHash) or exceed
   * the per-job cap. Returns the settlement if this commitment tips the job into agreement. */
  addCommitment(jobId: string, c: ImageCommitment, now: number): ImageAgreementResult | null {
    if (!this.enabled) return null;
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (c.seed !== job.seed || c.modelId !== job.modelId || c.paramsHash !== job.paramsHash) return null;
    if (!/^[0-9a-f]+$/.test(c.pHash)) return null;
    const idx = job.commitments.findIndex((x) => x.provider === c.provider);
    if (idx >= 0) job.commitments[idx] = c;
    else {
      if (job.commitments.length >= this.maxCommitmentsPerJob) return job.settlement; // bounded
      job.commitments.push(c);
    }
    return this.trySettle(jobId, now);
  }

  /** Run the pure perceptual agreement over the job's commitments; settle idempotently. */
  trySettle(jobId: string, _now: number): ImageAgreementResult | null {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    if (job.settlement?.agreed) return job.settlement; // already settled, idempotent
    const outcome = imageAgreementOutcome(job.commitments, {
      seed: job.seed, modelId: job.modelId, paramsHash: job.paramsHash,
      minAgree: this.minAgree, maxHamming: this.maxHamming,
    });
    if (outcome.agreed) job.settlement = outcome;
    return outcome.agreed ? outcome : null;
  }

  getJob(jobId: string): ImageJob | undefined { return this.jobs.get(jobId); }

  /** The settler's fork-safe image payout plan: for each SETTLED job not already paid, split `pricePerJobUZIR`
   * equally among its agreeing providers (integer µZIR, remainder dropped) and return the per-address totals
   * plus the job ids that were paid. PURE given (jobs, alreadyPaid, price): only the active settler calls this,
   * folds the entries into its single signed batch_transfer, and persists `paidJobIds` (like the field payout's
   * settler-progress watermark) so a job is never double-paid across settler failover. Deterministic ordering
   * (sorted jobId, sorted provider) so any settler computes the identical plan. */
  drainSettledPayouts(pricePerJobUZIR: number, alreadyPaid: Set<string>): { payouts: Map<string, number>; paidJobIds: string[] } {
    const payouts = new Map<string, number>();
    const paidJobIds: string[] = [];
    const settled = [...this.jobs.values()]
      .filter((j) => j.settlement?.agreed && j.settlement.agreeingProviders.length > 0 && !alreadyPaid.has(j.jobId))
      .sort((a, b) => (a.jobId < b.jobId ? -1 : 1));
    for (const job of settled) {
      const providers = [...job.settlement!.agreeingProviders].sort();
      const share = Math.floor(pricePerJobUZIR / providers.length);
      if (share <= 0) continue;
      for (const addr of providers) payouts.set(addr, (payouts.get(addr) ?? 0) + share);
      paidJobIds.push(job.jobId);
    }
    return { payouts, paidJobIds };
  }

  /** Drop expired unsettled jobs (and settled jobs past TTL) to bound memory. */
  expire(now: number): void {
    for (const [id, job] of this.jobs) {
      if (now - job.createdAt > this.ttlMs) this.jobs.delete(id);
    }
  }

  size(): number { return this.jobs.size; }
}
