// apps/web/src/provider/ProviderMode.ts
// Intelligent mining in the browser. The user turns Provider mode on, registers with the
// coordinator (proving key ownership with a signed challenge), then polls for queries, answers
// them with their own local model, signs the answers, and earns ZIR. No hashing, useful work.
import type { ZiraClient, Domain } from "@zira/protocol";
import { Wallet } from "../lib/keys";
import { chat, PROVIDER_SYSTEM_PROMPT } from "./inference";

export interface ProviderConfig {
  endpoint: string;
  model: string;
  apiKey?: string;
  domains: Domain[];
  label: string;
}

export interface ProviderStats {
  running: boolean;
  earnedThisSessionUZIR: number;
  queriesAnswered: number;
  lastError?: string;
}

type Listener = (s: ProviderStats) => void;

export class ProviderMode {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stats: ProviderStats = { running: false, earnedThisSessionUZIR: 0, queriesAnswered: 0 };
  private listeners = new Set<Listener>();
  private reRegisterAt = 0;

  constructor(private client: ZiraClient, private cfg: ProviderConfig) {}

  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.stats);
    return () => this.listeners.delete(fn);
  }
  private emit() { this.listeners.forEach((l) => l({ ...this.stats })); }

  isRunning() { return this.running; }

  async start(): Promise<void> {
    if (this.running) return;
    if (!Wallet.isUnlocked()) throw new Error("unlock your wallet to serve as a provider");
    this.running = true;
    this.stats.running = true;
    this.stats.lastError = undefined;
    this.emit();
    await this.register();
    this.loop();
  }

  stop(): void {
    this.running = false;
    this.stats.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.emit();
  }

  private async register(): Promise<void> {
    const pubKey = Wallet.publicKey();
    if (!pubKey) throw new Error("wallet locked");
    const challenge = `zira-provider-register:${pubKey}:${Date.now()}`;
    const sig = Wallet.sign(challenge);
    await this.client.registerProvider({
      pubKey, label: this.cfg.label, model: this.cfg.model, domains: this.cfg.domains, sig, challenge,
    });
    this.reRegisterAt = Date.now() + 60_000; // re register each minute to stay online
  }

  private loop(): void {
    if (!this.running) return;
    this.tick().finally(() => {
      if (this.running) {
        this.timer = setTimeout(() => this.loop(), 2500); // gentle poll, do not hammer the host
      }
    });
  }

  private async tick(): Promise<void> {
    try {
      const pubKey = Wallet.publicKey();
      if (!pubKey) { this.stop(); return; }
      if (Date.now() > this.reRegisterAt) await this.register();

      const queries = await this.client.pollQueries(this.cfg.domains, pubKey);
      for (const q of queries) {
        if (!this.running) break;
        await this.answer(q);
      }
    } catch (e) {
      this.stats.lastError = e instanceof Error ? e.message : "poll failed";
      this.emit();
    }
  }

  private async answer(q: { id: string; question: string; history: { role: "user" | "assistant"; content: string }[] }): Promise<void> {
    const pubKey = Wallet.publicKey();
    if (!pubKey) return;
    try {
      const messages = [
        { role: "system" as const, content: PROVIDER_SYSTEM_PROMPT },
        ...q.history.map((h) => ({ role: h.role, content: h.content })),
        { role: "user" as const, content: q.question },
      ];
      const answer = await chat({ endpoint: this.cfg.endpoint, model: this.cfg.model, apiKey: this.cfg.apiKey, messages });
      // confidence: a simple heuristic the model could be asked to provide; default mid high
      const confidence = 0.75;
      const sig = Wallet.sign(`${q.id}\n${answer}`);
      const res = await this.client.submitAnswer({ queryId: q.id, provider: pubKey, answer, confidence, sig });
      this.stats.earnedThisSessionUZIR += res.rewardedUZIR ?? 0;
      this.stats.queriesAnswered += 1;
      this.stats.lastError = undefined;
      this.emit();
    } catch (e) {
      this.stats.lastError = e instanceof Error ? e.message : "answer failed";
      this.emit();
    }
  }
}
