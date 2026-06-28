// node/src/provider/InferenceProvider.ts
// Tier 2. A node becomes an inference provider by pointing at any OpenAI compatible endpoint
// (Ollama, LM Studio, a remote API). This class has zero knowledge of model files; it only knows
// an endpoint URL and a model name. It:
//   1. builds and gossips a signed ProviderProfile,
//   2. polls the query relay for questions in its domains and answers them via the endpoint,
//   3. signs every answer with the node identity.
// Earnings come from query tips plus the inference emission share. ZTI tracks real quality.
import { sign as edSign, type Keypair, type Domain, type ProviderConfig, type ProviderProfile } from "@zira/protocol";
import type { ZiraNode } from "../core/ZiraNode.js";
import { buildProviderProfile } from "./profile.js";
import { chat, PROVIDER_SYSTEM_PROMPT } from "./inference.js";
import { log } from "../log.js";

const ANNOUNCE_MS = 30_000;
const POLL_MS = 2_500;
// Answer up to this many open queries at once. Field questions are independent, so a provider that
// sees several open queries should fan them out concurrently instead of blocking on each endpoint
// round-trip in turn (which previously serialized latency up to ANSWER_TIMEOUT_MS per query). The cap
// keeps a single endpoint from being flooded beyond what it can serve in parallel.
const MAX_CONCURRENT_ANSWERS = 4;
const ANSWER_TIMEOUT_MS = 45_000;

export class InferenceProvider {
  private answered = new Set<string>();
  private inFlight = new Set<string>();
  private timers: ReturnType<typeof setInterval>[] = [];
  private stopped = false;

  queriesAnswered = 0;
  reachable = false;
  lastProfile: ProviderProfile | null = null;

  constructor(
    private config: ProviderConfig,
    private node: ZiraNode,
    private identity: Keypair,
  ) {}

  get domains(): Domain[] { return this.config.domains.length ? this.config.domains : []; }

  start(): void {
    void this.publishProfile();
    void this.announce();
    this.timers.push(setInterval(() => void this.announce(), ANNOUNCE_MS));
    this.timers.push(setInterval(() => void this.publishProfile(), ANNOUNCE_MS * 4));
    this.timers.push(setInterval(() => void this.tick(), POLL_MS));
    log.info(`inference provider serving [${this.domains.length ? this.domains.join(", ") : "all domains"}] via ${this.config.endpoint}`);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** Build and gossip a signed ProviderProfile. */
  async publishProfile(): Promise<void> {
    // The throughput benchmark and context-window probe are independent endpoint round-trips, so run
    // them concurrently rather than awaiting one then the other (halves profile-refresh latency).
    const [tokensPerSec, contextWindowTokens] = await Promise.all([this.benchmarkThroughput(), this.probeContextWindow()]);
    const measured = { tokensPerSec, contextWindowTokens };
    const profile = buildProviderProfile(this.identity, this.config, measured);
    this.lastProfile = profile;
    this.node.publishProviderProfile(profile);
  }

  /** Legacy online announcement, so the provider appears online (with ZTI) and can be tipped. */
  private async announce(): Promise<void> {
    if (this.stopped) return;
    const challenge = `zira-provider:${this.identity.publicKey}:${Date.now()}`;
    const sig = edSign(challenge, this.identity.privateKey);
    this.node.publishProvider({
      pubKey: this.identity.publicKey, address: this.identity.address,
      label: this.config.label || "provider", model: this.config.endpointModel,
      domains: this.domains, challenge, sig, ts: Date.now(),
    });
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      // Fan out the open queries concurrently (bounded) instead of awaiting each in turn. Each query
      // is independent, so serial answering made total latency scale with the number of open queries.
      const pending = this.node.soft.openQueries(this.domains, Date.now())
        .filter((query) => !this.answered.has(query.id) && !this.inFlight.has(query.id))
        .slice(0, MAX_CONCURRENT_ANSWERS);
      if (pending.length === 0) return;
      await Promise.allSettled(pending.map((query) => this.answerAndPublish(query)));
    } catch { /* ignore */ }
  }

  /** Answer a single query and publish the signed answer. De-duped via the inFlight set. */
  private async answerAndPublish(query: { id: string; question: string; history: { role: "user" | "assistant"; content: string }[] }): Promise<void> {
    if (this.inFlight.has(query.id) || this.answered.has(query.id)) return;
    this.inFlight.add(query.id);
    try {
      const answer = await this.answer(query);
      const id = this.identity.address + ":endpoint:" + query.id;
      const sig = edSign(query.id + "\n" + answer, this.identity.privateKey);
      if (this.node.publishAnswer({ id, queryId: query.id, provider: this.identity.publicKey, answer, confidence: 0.78, sig, ts: Date.now() })) {
        this.answered.add(query.id);
        this.queriesAnswered++;
      }
    } catch (e) { log.debug("provider answer failed", (e as Error).message); }
    finally { this.inFlight.delete(query.id); }
  }

  /** Answer a query by forwarding the prompt to the configured endpoint. */
  async answer(query: { question: string; history: { role: "user" | "assistant"; content: string }[] }): Promise<string> {
    const messages = [
      { role: "system" as const, content: PROVIDER_SYSTEM_PROMPT },
      ...(query.history ?? []).map((h) => ({ role: h.role, content: h.content })),
      { role: "user" as const, content: query.question },
    ];
    const out = await chat({ endpoint: this.config.endpoint, model: this.config.endpointModel, messages, signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS) });
    this.reachable = true;
    return out;
  }

  /** Lightweight latency probe: a tiny completion, converted to a rough tokens/sec figure. */
  private async benchmarkThroughput(): Promise<number> {
    const t0 = Date.now();
    try {
      const out = await chat({ endpoint: this.config.endpoint, model: this.config.endpointModel, messages: [{ role: "user", content: "Reply with the single word: ok" }] });
      this.reachable = true;
      const ms = Math.max(1, Date.now() - t0);
      const tokens = Math.max(1, Math.round(out.length / 4));
      return Number(((tokens / ms) * 1000).toFixed(1));
    } catch {
      this.reachable = false;
      return 0;
    }
  }

  /** Probe /v1/models for a context length hint, else a sensible default. */
  private async probeContextWindow(): Promise<number> {
    try {
      const url = this.config.endpoint.replace(/\/$/, "") + "/models";
      const r = await fetch(url);
      if (r.ok) {
        const j = (await r.json()) as any;
        const m = (j?.data ?? []).find((x: any) => x.id === this.config.endpointModel) ?? j?.data?.[0];
        const ctx = m?.context_length ?? m?.context_window ?? m?.max_context_length;
        if (typeof ctx === "number" && ctx > 0) return ctx;
      }
    } catch { /* default below */ }
    return 8192;
  }

  status(): { active: boolean; endpoint: string; queriesAnswered: number; reachable: boolean } {
    return { active: !this.stopped, endpoint: this.config.endpoint, queriesAnswered: this.queriesAnswered, reachable: this.reachable };
  }
}
