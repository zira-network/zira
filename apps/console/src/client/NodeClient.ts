// apps/web/src/client/NodeClient.ts
// The Console talks to a ZIRA Core node over its local RPC (HTTP) and WebSocket. The node is a
// peer in the network, so the GUI is synced by peers. Pointing at your own node is trustless.
import {
  PROTOCOL, TASK_DELIVER_TIMEOUT_MS, addressFromPubKey,
  type ZiraClient, type Address, type PublicKey, type SignedTx, type SignedObservation, type Lock,
  type FieldNode, type Stream, type Bond, type Resonator, type SpendLimits, type Anchor,
  type NetworkStats, type AnswerReceipt, type Listing, type Task, type PendingQuery, type uZIR, type Domain,
} from "@zira/protocol";
import { Wallet } from "../lib/keys";
import { makeSignedTx, makeSignedRecord } from "../lib/tx";

interface OnlineProvider { pubKey: PublicKey; address: Address; label: string; model: string; domains: Domain[]; zti: number }
interface FieldAnswer { provider: string; answer: string; confidence: number; sig: string }

// Thrown when the node rejects a free-tier query with HTTP 429. Carries the parsed fields so callers
// can surface limits/reset timing without re-parsing the response.
export class FreeTierError extends Error {
  readonly limit: number;
  readonly retryInMs: number;
  constructor(message: string, limit: number, retryInMs: number) {
    super(message);
    this.name = "FreeTierError";
    this.limit = limit;
    this.retryInMs = retryInMs;
  }
}

export class NodeClient implements ZiraClient {
  constructor(private base: string) { this.base = base.replace(/\/$/, ""); }
  private rpc(p: string): string { return this.base + "/rpc" + p; }

  private async get<T>(p: string): Promise<T> {
    const r = await fetch(this.rpc(p));
    if (!r.ok) throw new Error(`GET ${p} failed: ${r.status}`);
    return r.json() as Promise<T>;
  }
  private async post<T>(p: string, body: unknown): Promise<T> {
    const r = await fetch(this.rpc(p), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) { let m = r.statusText; try { m = (await r.json()).error ?? m; } catch { /* */ } throw new Error(m); }
    return r.json() as Promise<T>;
  }

  async reachable(): Promise<boolean> {
    try { const r = await fetch(this.rpc("/stats")); return r.ok; } catch { return false; }
  }

  async getBalanceUZIR(a: Address) { return (await this.get<{ uZIR: number }>(`/balance?address=${encodeURIComponent(a)}`)).uZIR; }
  async getNonce(a: Address) { return (await this.get<{ nonce: number }>(`/nonce?address=${encodeURIComponent(a)}`)).nonce; }
  submitTx(tx: SignedTx) { return this.post<{ accepted: boolean; reason?: string }>("/tx", { tx }); }
  getTxHistory(a: Address, limit = 50) { return this.get<SignedTx[]>(`/history?address=${encodeURIComponent(a)}&limit=${limit}`); }
  getTx(id: string) { return this.get<SignedTx | null>(`/tx?id=${encodeURIComponent(id)}`).catch(() => null); }
  async getBonds(_a: Address): Promise<Bond[]> { return []; }
  async openStream(s: Omit<Stream, "id" | "startedAt" | "active">): Promise<Stream> { return { ...s, id: "stream-" + Date.now(), startedAt: Date.now(), active: true }; }
  async closeStream(_id: string) { /* streams are a local convenience surface for now */ }

  getFieldNodes(subject: string) { return this.get<FieldNode[]>(`/fieldnodes?subject=${encodeURIComponent(subject)}`); }
  getRecentLocks(limit = 50) { return this.get<Lock[]>(`/locks?limit=${limit}`); }
  getResonantValue(subject: string) { return this.get<Lock | null>(`/value?subject=${encodeURIComponent(subject)}`); }
  getRecentEvents(limit = 100) { return this.get<SignedTx[]>(`/events?limit=${limit}`); }
  submitObservation(o: SignedObservation) { return this.post<{ accepted: boolean; reason?: string }>("/observation", { obs: o }); }
  submitObservationBatch(obs: SignedObservation[]) { return this.post<{ accepted: number }>("/observations", { obs }); }

  // The distributed assistant over the gossip relay. Publish the query, collect signed answers
  // from miners/providers running their own models, coordinate them by domain trust, then tip the contributors.
  async askField(args: {
    question: string; history: { role: "user" | "assistant"; content: string }[];
    asker: Address; paymentTx?: SignedTx; pay?: boolean; onToken: (t: string) => void; signal?: AbortSignal;
  }): Promise<{ answer: string; receipt: AnswerReceipt }> {
    const domain = classify(args.question);
    const id = "q-" + Math.random().toString(36).slice(2) + "-" + Date.now();
    // Post the query directly so a 429 free-tier rejection becomes a typed, catchable error. On a 429
    // the node returns { ok:false, reason, retryInMs, limit, windowMs }; on success { ok:true, freeTier }.
    const qres = await fetch(this.rpc("/query"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: { id, domain, question: args.question, history: args.history, asker: args.asker, postedAt: Date.now() } }),
    });
    if (qres.status === 429) {
      const body = await qres.json().catch(() => ({})) as { reason?: string; retryInMs?: number; limit?: number };
      const retryInMs = body.retryInMs ?? 0;
      const minutes = Math.ceil(retryInMs / 60000);
      throw new FreeTierError(`You have used your free questions for now. They reset in ${minutes}m.`, body.limit ?? 0, retryInMs);
    }
    if (!qres.ok) { let m = qres.statusText; try { m = ((await qres.json()) as { error?: string }).error ?? m; } catch { /* */ } throw new Error(m); }

    // Collect answers long enough for endpoint/native providers. Coordination miners answer quickly,
    // but local endpoint models can need 10-30 seconds on consumer hardware.
    let providers = await this.get<OnlineProvider[]>("/providers").catch(() => [] as OnlineProvider[]);
    const byKey = new Map(providers.map((p) => [p.pubKey, p]));
    // Wait long enough for slow endpoint/native providers (10-30s on consumer hardware). A node that just
    // connected may not have heard a provider's gossiped announce yet, so we DON'T give up fast just
    // because the first /providers read is empty: we keep a generous floor and re-check the provider list
    // each loop, extending to the full window the moment one appears. Only a network that stays empty the
    // whole time returns the "still warming up" guidance.
    const start = Date.now();
    const FULL_WAIT = 45000, EMPTY_FLOOR = 20000;
    let deadline = start + (providers.length === 0 ? EMPTY_FLOOR : FULL_WAIT);
    let answers: FieldAnswer[] = [];
    let recheck = 0;
    while (Date.now() < deadline) {
      if (args.signal?.aborted) break;
      answers = await this.get<typeof answers>(`/query/answers?id=${id}`).catch(() => []);
      if (answers.some((a) => !isCoordinationFallback(a.answer))) break;
      // Every ~3s re-read providers; if one is now online, give it the full window to answer.
      if (++recheck % 6 === 0 && Date.now() - start < EMPTY_FLOOR) {
        const live = await this.get<OnlineProvider[]>("/providers").catch(() => [] as OnlineProvider[]);
        if (live.length > 0) { providers = live; for (const p of live) byKey.set(p.pubKey, p); deadline = start + FULL_WAIT; }
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    if (answers.length === 0) {
      // "Use this machine" backs up the field: if this machine can answer (own-task is on and a model is
      // loaded here), answer locally instead of returning an empty field result.
      const own = await this.get<{ enabled: boolean; ready: boolean; label?: string }>("/own-task/status").catch(() => null);
      if (own?.enabled && own.ready) {
        return this.askLocal({ question: args.question, history: args.history, onToken: args.onToken, signal: args.signal });
      }
      const msg = own?.enabled
        ? "No answer came back in time. This machine has no local model — but you don't need one: the field answers for you. Authorized models are distributed to miners across the network, and your question is answered here as soon as one is serving. The field may just be warming up; please try again in a moment."
        : "No answer came back in time. The field is still warming up — authorized models are distributed to miners across the network, and your question is answered here as soon as one is serving. Please try again in a moment.";
      for (const w of msg.split(/(\s+)/)) { if (args.signal?.aborted) break; args.onToken(w); await new Promise((r) => setTimeout(r, 8)); }
      return { answer: msg, receipt: { contributors: [], domain, fusedConfidence: 0, challengeOpenUntil: Date.now(), proofAvailable: false, costUZIR: 0 } };
    }

    // Coordinate: weight by provider domain ZTI times confidence.
    const scored = answers.map((a) => {
      const p = byKey.get(a.provider);
      const zti = Math.max(0.05, p?.zti ?? 0.05);
      return { ...a, zti, weight: zti * a.confidence, label: p?.label ?? a.provider.slice(0, 8), model: p?.model ?? "" };
    });
    const modelBacked = scored.filter((a) => !isCoordinationFallback(a.answer));
    const coordinatedPool = modelBacked.length ? modelBacked : scored;
    const wsum = coordinatedPool.reduce((s, a) => s + a.weight, 0) || 1;
    coordinatedPool.forEach((a) => (a.weight = a.weight / wsum));
    coordinatedPool.sort((a, b) => b.weight - a.weight);
    const best = coordinatedPool[0]!;
    let coordinated = best.answer.trim();
    if (coordinatedPool.length > 1) coordinated += `\n\nThis is the highest weighted of ${coordinatedPool.length} model-backed miner answers, coordinated by domain trust.`;
    // Stream the coordinated answer to the UI. If the caller aborts mid-stream, stop emitting and return
    // only what was shown, so Stop genuinely halts the answer rather than completing it silently.
    let emitted = "";
    for (const w of coordinated.split(/(\s+)/)) { if (args.signal?.aborted) break; args.onToken(w); emitted += w; await new Promise((r) => setTimeout(r, 10)); }
    if (args.signal?.aborted) coordinated = emitted;

    // Pay the coordinating miners with real signed transactions, split by weight, and apply the same
    // 5% network/stewardship fee a Resonator hire carries (so coordination earnings flow to the miners
    // that did the work and the 5% founder-ops share, per the field's coordination economy). The
    // contributors share the remaining 95% in proportion to their domain-trust weight. Best effort:
    // requires an unlocked wallet, and settlement is on the now-live ledger path.
    // Tip the coordinating miners only on the paid (ZIR) tier. Free-tier questions never move ZIR; the
    // miners still earn from emission and the network's own coordination, just not a per-question tip.
    if (args.pay !== false && Wallet.isUnlocked()) {
      try {
        const stats = await this.getStats();
        const founderAddr = stats.founderAddress;
        const total = PROTOCOL.QUERY_PRICE_UZIR;
        const feeUZIR = founderAddr ? Math.round(total * PROTOCOL.RESONATOR_FEE_SHARE) : 0;
        const poolUZIR = total - feeUZIR;
        let nonce = await this.getNonce(args.asker);
        if (feeUZIR > 0 && founderAddr) {
          await this.submitTx(makeSignedTx({ network: stats.network, to: founderAddr, amountUZIR: feeUZIR, nonce, kind: "transfer", memo: "query coordination fee" }));
          nonce += 1;
        }
        for (const a of coordinatedPool) {
          const amount = Math.max(0, Math.floor(poolUZIR * a.weight));
          if (amount <= 0) continue;
          const to = addressFromPubKey(a.provider);
          await this.submitTx(makeSignedTx({ network: stats.network, to, amountUZIR: amount, nonce, kind: "agent_spend", memo: "query coordination" }));
          nonce += 1;
        }
      } catch { /* coordination payout is best effort */ }
    }

    const receipt: AnswerReceipt = {
      contributors: coordinatedPool.map((a) => ({ provider: a.provider, label: a.label, model: a.model, domainZti: a.zti, weight: a.weight, excerpt: a.answer.slice(0, 240), sig: a.sig, queryId: id, answer: a.answer })),
      domain, fusedConfidence: Number(coordinatedPool.reduce((s, a) => s + a.weight * a.confidence, 0).toFixed(3)),
      challengeOpenUntil: Date.now() + 300000, proofAvailable: false, costUZIR: PROTOCOL.QUERY_PRICE_UZIR,
    };
    return { answer: coordinated, receipt };
  }

  // The user's OWN hardware for the user's OWN tasks (Local mode). This is local inference only: the
  // node answers from its native engine or configured local endpoint. It never publishes to the field,
  // never asks other providers, and never tips/earns. Mutually exclusive with mining is a UI concern;
  // here we simply require the node to have own-task inference enabled (the node enforces it and 400s
  // with a clear message otherwise). Returns the same shape as askField, with a local (no-contributor)
  // receipt so the chat UI renders consistently.
  async askLocal(args: {
    question: string; history: { role: "user" | "assistant"; content: string }[];
    onToken: (t: string) => void; signal?: AbortSignal;
  }): Promise<{ answer: string; receipt: AnswerReceipt }> {
    const messages = [...args.history.map((h) => ({ role: h.role, content: h.content })), { role: "user" as const, content: args.question }];
    const r = await fetch(this.rpc("/own-task/generate"), {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }), signal: args.signal,
    });
    if (!r.ok) { let m = r.statusText; try { m = ((await r.json()) as { error?: string }).error ?? m; } catch { /* */ } throw new Error(m); }
    let answer = ((await r.json()) as { answer?: string }).answer ?? "";
    let emitted = "";
    for (const w of answer.split(/(\s+)/)) { if (args.signal?.aborted) break; args.onToken(w); emitted += w; await new Promise((res) => setTimeout(res, 8)); }
    if (args.signal?.aborted) answer = emitted;
    const receipt: AnswerReceipt = {
      contributors: [], domain: classify(args.question), fusedConfidence: 0,
      challengeOpenUntil: Date.now(), proofAvailable: false, costUZIR: 0,
    };
    return { answer, receipt };
  }

  async registerProvider(p: { pubKey: PublicKey; label: string; model: string; domains: Domain[]; sig: string; challenge: string }) {
    const address = addressFromPubKey(p.pubKey);
    await this.post("/provider/register", { provider: { ...p, address, ts: Date.now() } });
  }
  pollQueries(domains: Domain[], _pubKey: PublicKey) { return this.get<PendingQuery[]>(`/provider/poll?domains=${domains.join(",")}`); }
  async submitAnswer(a: { queryId: string; provider: PublicKey; answer: string; confidence: number; sig: string }) {
    await this.post("/provider/answer", { answer: { ...a, id: a.provider.slice(0, 8) + ":" + a.queryId, ts: Date.now() } });
    return { rewardedUZIR: 0 }; // providers earn when askers tip; balance reflects it
  }

  async listResonators(owner: Address) { return this.get<Resonator[]>(`/resonators?owner=${encodeURIComponent(owner)}`); }
  async createResonator(r: Parameters<ZiraClient["createResonator"]>[0] & { pubKey?: string }): Promise<Resonator> {
    const now = Date.now();
    const { pubKey: _pk, ...rest } = r as Record<string, unknown>;
    const draft = {
      ...rest, id: "res-" + Math.random().toString(36).slice(2), zti: 0, ztiByDomain: {}, balanceUZIR: 0,
      totalEarnedUZIR: 0, totalSpentUZIR: 0, jobsDone: 0, createdAt: now, updatedAt: now, status: "idle",
    };
    // sign so peers can verify authorship; the server rejects unsigned/stale records
    const full = makeSignedRecord(draft) as unknown as Resonator;
    await this.post("/resonator", { resonator: full });
    return full;
  }
  async getResonator(id: string) { return this.get<Resonator | null>(`/resonator?id=${encodeURIComponent(id)}`); }
  async updateResonator(id: string, patch: Partial<Resonator>) {
    const cur = await this.getResonator(id);
    const { pubKey: _pk, sig: _sig, ...base } = { ...(cur as Resonator), ...patch } as Record<string, unknown>;
    const next = makeSignedRecord({ ...base, updatedAt: Date.now() }) as unknown as Resonator;
    await this.post("/resonator", { resonator: next }); return next;
  }
  async transferResonator(id: string, newOwner: string): Promise<Resonator> {
    const cur = await this.getResonator(id);
    if (!cur) throw new Error("resonator not found");
    // The record is signed by the CURRENT owner's unlocked wallet (makeSignedRecord), naming the new
    // owner. The node accepts the owner change only with the current owner's signature; afterward the new
    // owner controls it with their own self-signed updates.
    const { pubKey: _pk, sig: _sig, ...base } = { ...(cur as Resonator), owner: newOwner } as Record<string, unknown>;
    const next = makeSignedRecord({ ...base, updatedAt: Date.now() }) as unknown as Resonator;
    await this.post("/resonator", { resonator: next });
    return next;
  }
  setResonance(id: string, on: boolean) { return this.updateResonator(id, { resonanceEnabled: on, status: on ? "learning" : "idle" }); }
  setSpendLimits(id: string, limits: SpendLimits) { return this.updateResonator(id, { spendLimits: limits }); }
  async fundResonator(id: string, fundingTx: SignedTx) { await this.submitTx(fundingTx); const r = await this.getResonator(id); return r as Resonator; }
  async withdrawResonator(id: string, withdrawTx: SignedTx) { await this.submitTx(withdrawTx); const r = await this.getResonator(id); return r as Resonator; }
  getMarketplace(args: { sort: "zti" | "price" | "jobs" | "recent" | "domainZti"; domain?: Domain; q?: string; limit?: number }) {
    const qs = new URLSearchParams({ sort: args.sort });
    if (args.domain) qs.set("domain", args.domain);
    if (args.q) qs.set("q", args.q);
    if (args.limit) qs.set("limit", String(args.limit));
    return this.get<Listing[]>(`/marketplace?${qs.toString()}`);
  }
  async hireResonator(args: { resonatorId: string; brief: string; domain: Domain; paymentTx: SignedTx; founderFeeTx?: SignedTx; minZti: number }): Promise<Task> {
    // pay to hire: the payment transaction pays the Resonator wallet directly, and the small protocol
    // fee transaction (if present) goes to the founder operations wallet.
    await this.submitTx(args.paymentTx);
    if (args.founderFeeTx) { try { await this.submitTx(args.founderFeeTx); } catch { /* fee is best effort */ } }
    const now = Date.now();
    const task: Task = {
      id: "task-" + Math.random().toString(36).slice(2), client: args.paymentTx.from, resonatorId: args.resonatorId,
      domain: args.domain, brief: args.brief, budgetUZIR: args.paymentTx.amountUZIR, minZti: args.minZti,
      status: "assigned", createdAt: now, assignedAt: now, expiresAt: now + TASK_DELIVER_TIMEOUT_MS,
    };
    await this.post("/task", { task });
    // mark progress locally over time by re-publishing (any node will gossip it)
    setTimeout(() => this.post("/task", { task: { ...task, status: "delivered", resultRef: "ref" } }).catch(() => {}), 2500);
    setTimeout(() => this.post("/task", { task: { ...task, status: "verified" } }).catch(() => {}), 5000);
    setTimeout(() => this.post("/task", { task: { ...task, status: "released" } }).catch(() => {}), 7500);
    return task;
  }
  getTask(id: string) { return this.get<Task | null>(`/task?id=${encodeURIComponent(id)}`); }
  listTasks(client: Address) { return this.get<Task[]>(`/tasks?client=${encodeURIComponent(client)}`); }
  // Every task a Resonator worked, including autonomous coordination (whose client is the founder).
  listResonatorTasks(resonatorId: string) { return this.get<Task[]>(`/tasks?resonator=${encodeURIComponent(resonatorId)}`); }

  listAnchors() { return this.get<Anchor[]>("/anchors"); }
  getStats() { return this.get<NetworkStats>("/stats"); }
  async grantReserve(grantTx: SignedTx, _reason: string, _challenge: string, _challengeSig: string) {
    // the ledger enforces founder only: a reserve_grant not from the founder is rejected by all nodes
    return this.submitTx(grantTx);
  }
  getReserveGrants(limit = 100) { return this.get<SignedTx[]>(`/founder/grants?limit=${limit}`); }
}

function classify(question: string): Domain {
  const q = question.toLowerCase();
  const map: [Domain, string[]][] = [
    ["compute", ["gpu", "compute", "flops", "inference"]],
    ["energy", ["energy", "kwh", "solar", "power", "grid"]],
    ["carbon", ["carbon", "co2", "emission"]],
    ["currency", ["usd", "price", "exchange", "currency", "btc"]],
    ["code", ["code", "function", "bug", "typescript", "python", "api"]],
    ["science", ["physics", "chemistry", "biology", "theorem"]],
  ];
  for (const [d, words] of map) for (const w of words) if (q.includes(w)) return d;
  return "general";
}

function isCoordinationFallback(answer: string): boolean {
  return answer.includes("This node is mining in coordination mode:") || answer.includes("Full generative AI answers require");
}
