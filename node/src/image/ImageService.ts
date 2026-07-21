// node/src/image/ImageService.ts
// Thin orchestrator tying the T2I pieces together (2.9.0 Track A / A5-wire), DORMANT (ZIRA_IMAGE_ENABLE=1).
//   Provider side: screen the prompt (G1 safety) -> generate in the isolated engine -> produce an
//     ImageCommitment (perceptual hash) the node gossips. The raw PNG is delivered to the asker out of band.
//   Coordinator side: the master collects commitments (ImageCoordinator) and settles by pure perceptual
//     agreement, paying the agreeing providers via the node's existing signed payout path.
// It holds no consensus state and is fully injectable (engine + coordinator) so it is testable without the SD
// binary. Not yet imported by ZiraNode; the RPC + settler hookup is the final wiring step once the binary ships.

import type { ImageCoordinator, ImageJob } from "./ImageCoordinator.js";
import type { ImageEngine } from "./ImageEngine.js";
import { screenImagePrompt } from "./ImageSafety.js";
import type { ImageCommitment } from "@zira/protocol";

export interface ServeResult {
  commitment: ImageCommitment;
  pngPath: string;
}

export class ImageService {
  constructor(
    private readonly coordinator: ImageCoordinator,
    private readonly engine: ImageEngine,
    private readonly address: string,
    private readonly resolveModelPath: (modelId: string) => string | null,
  ) {}

  isEnabled(): boolean { return this.coordinator.isEnabled() && this.engine.available(); }

  /** Provider side: safely generate an image for a job and return the commitment to gossip, or null when the
   * prompt is prohibited, the engine is unavailable, the model is not held, or generation fails. NEVER throws. */
  async serveJob(job: ImageJob, outPath: string): Promise<ServeResult | null> {
    const verdict = screenImagePrompt(job.prompt, job.params.negativePrompt);
    if (!verdict.allowed) return null;                       // G1: prohibited prompt, refuse
    if (!this.engine.available()) return null;               // dormant / no binary
    const modelPath = this.resolveModelPath(job.modelId);
    if (!modelPath) return null;                             // model not held locally
    const res = await this.engine.generate({
      prompt: job.prompt, params: job.params, seed: job.seed, modelPath, outPath,
    }).catch(() => null);
    if (!res) return null;
    const commitment: ImageCommitment = {
      provider: this.address, pHash: res.pHash, seed: job.seed, modelId: job.modelId, paramsHash: job.paramsHash,
    };
    return { commitment, pngPath: res.pngPath };
  }

  /** Record a peer provider's commitment on the master side; returns the settlement if it now agrees. */
  ingestCommitment(jobId: string, c: ImageCommitment, now: number) {
    return this.coordinator.addCommitment(jobId, c, now);
  }
}
