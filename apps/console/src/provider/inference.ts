// apps/web/src/provider/inference.ts
// An OpenAI compatible client to the user's own local model endpoint (default a local Ollama).
// The model runs on the user's machine. The coordinator never runs it.
export interface ChatArgs {
  endpoint: string;          // e.g. http://localhost:11434/v1
  model: string;             // e.g. qwen2.5-coder:14b
  apiKey?: string;           // optional, for paid endpoints
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  onToken?: (t: string) => void;
  signal?: AbortSignal;
}

// The provider system prompt keeps answers free of em dashes, per the brand rule.
export const PROVIDER_SYSTEM_PROMPT =
  "You are a ZIRA field provider. Answer accurately and concisely. Never use an em dash. " +
  "Use periods, commas, colons, or parentheses instead. If unsure, say so and lower your confidence.";

export async function chat(args: ChatArgs): Promise<string> {
  const url = args.endpoint.replace(/\/$/, "") + "/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(args.apiKey ? { Authorization: `Bearer ${args.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: args.model, messages: args.messages, stream: true }),
    signal: args.signal,
  });
  if (!res.ok || !res.body) {
    throw new Error(`configured assistant endpoint is not reachable at ${args.endpoint} (status ${res.status}). Check your endpoint is running.`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = "";
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload);
        const token = json.choices?.[0]?.delta?.content ?? "";
        if (token) {
          full += token;
          args.onToken?.(token);
        }
      } catch {
        // ignore partial json chunks
      }
    }
  }
  return full;
}

/** A simple non streaming probe to confirm the endpoint and model work. */
export async function testEndpoint(endpoint: string, model: string, apiKey?: string): Promise<{ ok: boolean; message: string }> {
  try {
    const answer = await chat({
      endpoint, model, apiKey,
      messages: [
        { role: "system", content: PROVIDER_SYSTEM_PROMPT },
        { role: "user", content: "Reply with the single word: ready" },
      ],
    });
    return { ok: true, message: answer.trim().slice(0, 80) || "ready" };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "unknown error" };
  }
}
