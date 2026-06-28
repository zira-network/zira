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
  const inFlight = new Set<string>();
  const MAX_INFLIGHT = 1;          // a CPU node answers one query at a time (full cores -> fast enough to beat the TTL); the field parallelizes across nodes
  const EXPECTED_GEN_MS = 35_000;  // a CPU generation takes tens of seconds; skip work that can't beat the TTL
  const QUERY_TTL_MS = 60_000;     // mirrors SoftState.QUERY_TTL_MS: the field drops a query after this

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
      answered.add(query.id);
    } catch (e) { log.debug("answer failed", (e as Error).message); }
  }

  async function tick(): Promise<void> {
    if (node.endpointProviderReady()) return;
    if (stopped || !node.models.canServe()) return;
    if (inFlight.size >= MAX_INFLIGHT) return; // already at the concurrency budget; let them finish first
    try {
      const now = Date.now();
      for (const query of node.soft.openQueries(pickupDomains(), now)) {
        if (inFlight.size >= MAX_INFLIGHT) break;
        if (answered.has(query.id) || inFlight.has(query.id)) continue;
        // Skip queries whose remaining time-to-live is shorter than a generation takes: the answer would
        // land after the query has TTL-expired from the field, wasting CPU and backing up the engine.
        if (typeof query.postedAt === "number" && (query.postedAt + QUERY_TTL_MS - now) < EXPECTED_GEN_MS) { answered.add(query.id); continue; }
        inFlight.add(query.id);
        // Fire-and-forget up to MAX_INFLIGHT at once (matching the subprocess pool) instead of awaiting each
        // generation in series, so a slow answer never blocks picking up the next query.
        void answerQuery(query).finally(() => inFlight.delete(query.id));
      }
    } catch { /* ignore */ }
  }

  const annIv = setInterval(announce, 30_000);
  const pollIv = setInterval(() => void tick(), 2500);
  announce();
  log.info(`miner ready, serving [${cfg.domains.join(", ")}] when mining is on`);
  return () => { stopped = true; clearInterval(annIv); clearInterval(pollIv); };
}
