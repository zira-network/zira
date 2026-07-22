// node/src/provider/loop.ts
// The miner. It answers the field's questions with a model on its own machine, and earns when askers
// tip the contributors. The model source (the built in engine running a distributed model, or an
// OpenAI compatible endpoint like Ollama) is decided by the mining settings, so this loop just asks
// the model service whether it can serve and to generate an answer. Every answer is signed.
import { sign as edSign, type Keypair, type Domain } from "@zira/protocol";
import type { ZiraNode } from "../core/ZiraNode.js";
import { PROVIDER_SYSTEM_PROMPT } from "./inference.js";
import { log } from "../log.js";

export interface MinerConfig {
  domains: string[];
  label: string;
}

export function startMiner(node: ZiraNode, identity: Keypair, cfg: MinerConfig): () => void {
  let stopped = false;
  const answered = new Set<string>();
  // Bound the dedup set on a long-running miner: query ids are bucketed and never reappear once TTL-pruned,
  // so trimming the oldest is safe. Mirrors the InferenceProvider guard (else this Set leaks forever).
  const markAnswered = (id: string): void => { answered.add(id); if (answered.size > 4000) for (const old of [...answered].slice(0, 2000)) answered.delete(old); };
  const inFlight = new Set<string>();
  // Answering concurrency is HARDWARE-AWARE (ModelService.answerConcurrency): a small CPU stays at one query
  // at a time so it beats the TTL, a many-core CPU runs two, a GPU-offloaded node runs several in parallel so
  // a strong machine is actually used instead of idling between single answers. Resolved live each tick because
  // the mining config (GPU layers) can change at runtime. Purely local scheduling; never a consensus surface.
  const EXPECTED_GEN_MS = 35_000;  // a CPU generation takes tens of seconds; skip work that can't beat the TTL
  const QUERY_TTL_MS = 240_000;    // MUST match SoftState.QUERY_TTL_MS (240s): the field retains a query this long, so a serving miner must answer it across that whole window, not skip it after ~25s (which starved coordination answers)

  // The model this node serves can change at runtime (the steward adds models; an atomic swap moves us onto
  // a better local one), so resolve the served model's routing domains live each cycle rather than freezing
  // them at startup.
  function servedDomains(): Domain[] {
    const d = node.models.servingDomains();
    return d.length ? d : (cfg.domains as Domain[]);
  }
  // A generalist (a model tagged "general") attempts ANY query ([] = no filter) so the field always has an
  // answerer; a specialist only picks up queries in its own domains, so as the catalog grows queries route
  // to the right kind of model and the field coordinates them by domain trust.
  function pickupDomains(): Domain[] {
    const d = servedDomains();
    return d.includes("general" as Domain) ? [] : d;
  }

  function announce(): void {
    if (node.endpointProviderReady()) return; // the endpoint provider announces itself with model details
    if (!node.models.canServe()) return; // nothing to serve with yet
    if (!node.models.servableHealthy()) return; // has a model/endpoint but has NOT proven it can generate: do not advertise a phantom provider
    const challenge = `zira-provider:${identity.publicKey}:${Date.now()}`;
    const sig = edSign(challenge, identity.privateKey);
    node.publishProvider({ pubKey: identity.publicKey, address: identity.address, label: cfg.label, model: node.models.answerLabel(), domains: servedDomains(), challenge, sig, ts: Date.now() });
  }

  async function answerQuery(query: { id: string; question: string; domain?: Domain; history?: { role: "user" | "assistant"; content: string }[] }): Promise<void> {
    try {
      const messages = [...(query.history ?? []).map((h) => ({ role: h.role, content: h.content })), { role: "user" as const, content: query.question }];
      const answer = await node.models.generate(messages, PROVIDER_SYSTEM_PROMPT, query.domain);
      const id = node.identityAddress() + ":" + query.id;
      const sig = edSign(query.id + "\n" + answer, identity.privateKey);
      node.publishAnswer({ id, queryId: query.id, provider: identity.publicKey, answer, confidence: 0.75, sig, ts: Date.now() });
      markAnswered(query.id);
    } catch (e) { log.warn("field answer generation failed", (e as Error).message); }
  }

  async function tick(): Promise<void> {
    if (node.endpointProviderReady()) return;
    if (stopped || !node.models.canServe()) return;
    const maxInflight = node.models.answerConcurrency(); // hardware-tier parallelism, resolved live
    if (inFlight.size >= maxInflight) return; // already at the concurrency budget; let them finish first
    try {
      const now = Date.now();
      for (const query of node.soft.openQueries(pickupDomains(), now)) {
        if (inFlight.size >= maxInflight) break;
        if (answered.has(query.id) || inFlight.has(query.id)) continue;
        // Skip queries whose remaining time-to-live is shorter than a generation takes: the answer would
        // land after the query has TTL-expired from the field, wasting CPU and backing up the engine.
        if (typeof query.postedAt === "number" && (query.postedAt + QUERY_TTL_MS - now) < EXPECTED_GEN_MS) { markAnswered(query.id); continue; }
        inFlight.add(query.id);
        // Fire-and-forget up to maxInflight at once (matching the subprocess pool) instead of awaiting each
        // generation in series, so a slow answer never blocks picking up the next query.
        void answerQuery(query).finally(() => inFlight.delete(query.id));
      }
    } catch { /* ignore */ }
  }

  const annIv = setInterval(announce, 30_000);
  const pollIv = setInterval(() => void tick(), 2500);
  // Serve-baseline retry (opt-in, self-guarded no-op otherwise): keep trying to fetch + serve the baseline
  // model until this node can answer, so a node that booted before peers were reachable still comes up serving.
  const baseIv = setInterval(() => { if (!node.models.canServe()) void node.models.reconcileServeBaseline(); }, 30_000);
  // Full-utilization keepalive (STRICTLY opt-in via ZIRA_FULL_UTILIZATION): when there are no in-flight queries
  // for several checks, run one short throwaway warmup generation (result DISCARDED, never published, never
  // settled) so the accelerator stays warm. Cheap and fork-safe; the interval is not even created when off.
  const fullUtilization = process.env.ZIRA_FULL_UTILIZATION === "1" || process.env.ZIRA_FULL_UTILIZATION?.toLowerCase() === "true";
  const KEEPALIVE_IDLE_CHECKS = 4;   // consecutive idle checks (~20s) before warming
  let idleChecks = 0;
  let keepaliveRunning = false;
  const kaIv = fullUtilization ? setInterval(() => {
    if (stopped || keepaliveRunning) return;
    if (!node.models.canServe() || inFlight.size > 0) { idleChecks = 0; return; }
    if (++idleChecks < KEEPALIVE_IDLE_CHECKS) return;
    idleChecks = 0;
    keepaliveRunning = true;
    void node.models.warmupKeepalive().finally(() => { keepaliveRunning = false; });
  }, 5000) : null;
  // Keep the serve-health probe fresh (probeServable self-throttles to ~5 min); announce() only advertises
  // this node once it has PROVEN it can generate, so a broken model/endpoint never becomes a phantom provider.
  const probeIv = setInterval(() => { void node.models.probeServable(Date.now()); }, 60_000);
  void node.models.probeServable(Date.now()).then((ok) => { if (ok) announce(); });
  log.info(`miner ready, serving [${cfg.domains.join(", ")}] when mining is on`);
  return () => { stopped = true; clearInterval(annIv); clearInterval(pollIv); clearInterval(probeIv); clearInterval(baseIv); if (kaIv) clearInterval(kaIv); };
}
