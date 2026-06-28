// apps/console/src/lib/fetchDedup.ts
// Deduplication wrapper: if a GET is already in-flight for the same URL, share that request instead of
// firing a second one. Each caller receives a fresh response.clone() so every consumer can independently
// read the body (a Response body can only be read once; sharing the raw Response would break the second
// reader's .json()/.text()). Requests carrying a body, or anything but GET, are never deduped.
const inflight = new Map<string, Promise<Response>>();

function dedupable(init?: RequestInit): boolean {
  const method = (init?.method ?? "GET").toUpperCase();
  return method === "GET" && init?.body == null && init?.signal == null;
}

export function fetchDedup(url: string, init?: RequestInit): Promise<Response> {
  if (!dedupable(init)) return fetch(url, init);
  const key = "GET|" + url;
  const existing = inflight.get(key);
  if (existing) return existing.then((r) => r.clone());
  const p = fetch(url, init).finally(() => inflight.delete(key));
  inflight.set(key, p);
  // The originating caller also gets a clone, so the cached promise's Response stays unconsumed for any
  // concurrent sharer that resolves later.
  return p.then((r) => r.clone());
}
