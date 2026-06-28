// node/src/provider/inference.ts
// An OpenAI compatible client to the operator's local model. The node never bundles a model; it
// calls the operator's own endpoint (for example Ollama). Used when the node serves as a provider.
export interface ChatArgs {
  endpoint: string;
  model: string;
  apiKey?: string;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  signal?: AbortSignal;
  // Bound generation length and wall-clock so a slow/stuck endpoint cannot hang the miner loop.
  maxTokens?: number;
  timeoutMs?: number;
}

export const PROVIDER_SYSTEM_PROMPT =
  "You are a helpful, accurate, and concise assistant. Answer the user's question directly. Do not " +
  "bring up the ZIRA network, how you are hosted, or tokens unless the user asks about them. Never use " +
  "an em dash; use periods, commas, colons, or parentheses instead. If unsure, say so and lower your confidence.";

export async function chat(args: ChatArgs): Promise<string> {
  const url = args.endpoint.replace(/\/$/, "") + "/chat/completions";
  // Always bound the call: a default wall-clock timeout (combined with the caller's signal) so a slow or
  // wedged endpoint can never hang the miner loop, and max_tokens so the server bounds generation length.
  const timeoutMs = args.timeoutMs ?? 60_000;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const onAbort = () => ac.abort();
  if (args.signal) { if (args.signal.aborted) ac.abort(); else args.signal.addEventListener("abort", onAbort); }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(args.apiKey ? { Authorization: `Bearer ${args.apiKey}` } : {}) },
      body: JSON.stringify({ model: args.model, messages: args.messages, max_tokens: args.maxTokens ?? 256, stream: false }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`local model not reachable at ${args.endpoint} (status ${res.status})`);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
    if (args.signal) args.signal.removeEventListener("abort", onAbort);
  }
}
