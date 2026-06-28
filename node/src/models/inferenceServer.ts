// node/src/models/inferenceServer.ts
// An OpenAI-compatible inference server that runs node-llama-cpp in its OWN process. The ZIRA node
// spawns this as a subprocess and points its mining endpoint at it, instead of native-loading the GGUF
// inside the node process (which starves/kills the node's RPC + consensus event loop). The native model
// load and every token generation happen here, fully isolated from the node's networking and ledger.
//
// Run via the main bundle: ZIRA_INFERENCE_SERVER=1 ZIRA_INFERENCE_MODEL=<gguf> ZIRA_INFERENCE_PORT=<n>
//
// Robustness (post-mortem of the field wedge): every generation is BOUNDED and CANCELLABLE so one slow or
// runaway prompt can never permanently block the server. Requests run on a small concurrency pool over the
// allocated context sequences (not a single serialized chain that head-of-line-blocks), each generation has
// a hard timeout, aborts if the client disconnects, and defaults to a modest token budget. On CPU these are
// the difference between a field that answers within the query TTL and one that falls irrecoverably behind.
import http from "node:http";
import { log } from "../log.js";

const GEN_TIMEOUT_MS = Number(process.env.ZIRA_INFERENCE_TIMEOUT_MS) || 60_000;
const DEFAULT_MAX_TOKENS = Number(process.env.ZIRA_INFERENCE_MAX_TOKENS) || 160;
const CONTEXT_SEQUENCES = 4;
// Default 1: on a CPU-only node, giving ONE generation all the cores finishes it within the query TTL;
// running several at once just makes each ~N times slower so none land in time (the field-wedge cause).
// GPU / high-core operators raise this via ZIRA_INFERENCE_CONCURRENCY (capped to the sequence pool).
const MAX_CONCURRENT = Math.max(1, Math.min(CONTEXT_SEQUENCES - 1, Number(process.env.ZIRA_INFERENCE_CONCURRENCY) || 1));

export async function runInferenceServer(modelPath: string, port: number): Promise<void> {
  // node-llama-cpp is an optional native dependency loaded dynamically, the same way the in-process
  // path loads it; here it is the only thing this process does.
  const mod = (await import("node-llama-cpp" as string)) as {
    getLlama: () => Promise<{ loadModel: (o: { modelPath: string; gpuLayers?: number }) => Promise<LlamaModelLike>; gpu?: string }>;
    LlamaChatSession: LlamaChatSessionCtor;
  };
  const llama = await mod.getLlama();
  log.info(`inference engine ready (gpu=${llama.gpu || "none"}); loading ${modelPath}`);
  const model = await llama.loadModel({ modelPath, gpuLayers: 999 });
  // A small pool of sequences with explicit release per request. Each query is independent (fresh
  // session + sequence), so we MUST dispose the sequence afterwards or the context runs out of slots
  // ("No sequences left") after the first generation.
  const context = await model.createContext({ contextSize: 4096, sequences: CONTEXT_SEQUENCES });

  // Bounded concurrency over the sequence pool: up to MAX_CONCURRENT generations run at once (each on its
  // own sequence), the rest queue. This replaces the old single serialized chain, where one stuck or slow
  // generation blocked every later request forever.
  let active = 0;
  const waiters: Array<() => void> = [];
  function acquire(): Promise<void> {
    return new Promise((resolve) => {
      const take = () => { if (active < MAX_CONCURRENT) { active++; resolve(); } else waiters.push(take); };
      take();
    });
  }
  function release(): void { active = Math.max(0, active - 1); const next = waiters.shift(); if (next) next(); }

  const readBody = (req: http.IncomingMessage) =>
    new Promise<string>((res) => { let s = ""; req.on("data", (d) => (s += d)); req.on("end", () => res(s)); });

  async function generate(messages: { role: string; content: string }[], maxTokens: number, signal: AbortSignal): Promise<string> {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n\n");
    const seq = context.getSequence();
    const session = new mod.LlamaChatSession({ contextSequence: seq, systemPrompt: system || undefined });
    try {
      // signal aborts generation on timeout or client disconnect, so a wedged prompt frees its slot.
      return await session.prompt(user, { maxTokens, signal });
    } finally {
      try { session.dispose(); } catch { /* */ }
      try { seq.dispose(); } catch { /* */ }
    }
  }

  const server = http.createServer((req, res) => {
    if (req.method === "POST" && (req.url || "").endsWith("/chat/completions")) {
      const ac = new AbortController();
      // Abort on a PREMATURE client disconnect — detected via the RESPONSE closing before we finished
      // writing. Do NOT listen on req 'close': on an IncomingMessage it fires as soon as the request BODY
      // is fully read (every normal request), which would abort every generation the instant it starts.
      const onClose = () => { if (!res.writableEnded) ac.abort(); };
      res.on("close", onClose);
      const timer = setTimeout(() => ac.abort(), GEN_TIMEOUT_MS);
      void (async () => {
        try {
          const b = JSON.parse(await readBody(req)) as { messages?: { role: string; content: string }[]; max_tokens?: number };
          const maxTokens = Math.max(16, Math.min(2048, b.max_tokens || DEFAULT_MAX_TOKENS));
          await acquire();
          let answer: string;
          try { answer = await generate(b.messages || [], maxTokens, ac.signal); }
          finally { release(); }
          if (!res.writableEnded) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: answer } }] }));
          }
        } catch (e: unknown) {
          if (!res.headersSent) res.writeHead(ac.signal.aborted ? 503 : 500, { "Content-Type": "application/json" });
          if (!res.writableEnded) res.end(JSON.stringify({ error: ac.signal.aborted ? "generation aborted (timeout or client gone)" : String((e as Error)?.message || e) }));
        } finally {
          clearTimeout(timer);
          res.off("close", onClose);
        }
      })();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, model: modelPath, active, queued: waiters.length }));
    }
  });
  server.listen(port, "127.0.0.1", () => log.info(`inference server listening on 127.0.0.1:${port} (max ${MAX_CONCURRENT} concurrent, ${GEN_TIMEOUT_MS}ms timeout)`));
}

interface LlamaSequenceLike { dispose: () => void; }
interface LlamaModelLike { createContext: (o: { contextSize?: number; sequences?: number }) => Promise<{ getSequence: () => LlamaSequenceLike }>; }
interface LlamaChatSessionCtor { new (o: { contextSequence: LlamaSequenceLike; systemPrompt?: string }): { prompt: (t: string, o?: { maxTokens?: number; signal?: AbortSignal }) => Promise<string>; dispose: () => void }; }
