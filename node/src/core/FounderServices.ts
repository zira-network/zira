// node/src/core/FounderServices.ts
// All model management lives here, isolated from the standard node path. It is instantiated only on
// a founder node (the genesis key) or in advanced self contained mode (ZIRA_SELF_CONTAINED=1).
// Non-founder, non-self-contained nodes never construct this, so the built in engine, GGUF
// distribution, and auto model reconciliation are completely out of their execution path.
//
// Regular users do not need any of this: providing inference is done in Tier 2 via an OpenAI
// compatible endpoint (see InferenceProvider). Launch authority is advisory here (publishing
// ModelRecommendation soft state), with ZTI enforcing quality network wide.
import { signRecord, type Keypair, type ModelRecommendation, type Domain } from "@zira/protocol";
import type { ModelService } from "../models/ModelService.js";
import { log } from "../log.js";

export class FounderServices {
  constructor(
    private models: ModelService,
    private identity: Keypair,
    private gossipRecommendation: (rec: ModelRecommendation) => void,
  ) {}

  /** Keep the auto miner (built in engine) running the recommended model. Founder/self-contained only. */
  async reconcile(): Promise<void> {
    try { await this.models.reconcileAuto(); } catch (e) { log.debug("founder reconcile", (e as Error).message); }
  }

  /** Publish a signed, advisory model recommendation. Providers may follow it; ZTI enforces quality. */
  publishRecommendation(input: { label: string; backendHint: string; domains: Domain[]; notes: string }): ModelRecommendation {
    const draft = {
      id: "rec-" + Date.now().toString(36),
      label: input.label,
      backendHint: input.backendHint,
      domains: input.domains,
      notes: input.notes,
      publishedAt: Date.now(),
    };
    const rec = signRecord(draft, this.identity.privateKey);
    this.gossipRecommendation(rec);
    log.info(`founder published model recommendation: ${rec.label}`);
    return rec;
  }
}
