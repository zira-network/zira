// apps/console/src/lib/connection.ts
// Connection-quality helpers used by the store and the shell indicator.
//
// probeStats() does one timed GET to /rpc/stats and returns the round-trip latency plus the parsed
// payload (which, on a new-enough node, carries a `version` field). It deliberately does NOT go through
// the in-flight dedup cache: a latency probe must be its own request to measure a real round trip, and it
// runs on its own cadence alongside the existing poll loop.
import { getApiBase } from "../client/createClient";

export type ConnectionQuality = "good" | "fair" | "poor" | "offline";

// Latency thresholds for the small dot/label in the top bar. green < 150ms, amber < 600ms, red otherwise.
export const LATENCY_GOOD_MS = 150;
export const LATENCY_FAIR_MS = 600;

export function qualityFor(latencyMs: number | null): ConnectionQuality {
  if (latencyMs == null) return "offline";
  if (latencyMs < LATENCY_GOOD_MS) return "good";
  if (latencyMs < LATENCY_FAIR_MS) return "fair";
  return "poor";
}

// The node may expose a build version on /rpc/stats. Older nodes do not, so this is optional everywhere.
export interface StatsProbe {
  latencyMs: number;
  version: string | null;
  ok: boolean;
}

function statsUrl(): string {
  return getApiBase().replace(/\/$/, "") + "/rpc/stats";
}

// One timed probe of /rpc/stats. Resolves with latency + optional version, or { ok:false } when the node
// is unreachable. Accepts an AbortSignal so callers can cancel on unmount. Never throws.
export async function probeStats(signal?: AbortSignal): Promise<StatsProbe> {
  const start = performance.now();
  try {
    const r = await fetch(statsUrl(), { signal });
    const latencyMs = Math.round(performance.now() - start);
    if (!r.ok) return { latencyMs, version: null, ok: false };
    let version: string | null = null;
    try {
      const data = (await r.json()) as { version?: unknown };
      if (typeof data.version === "string" && data.version.trim()) version = data.version.trim();
    } catch { /* body optional for the probe */ }
    return { latencyMs, version, ok: true };
  } catch {
    return { latencyMs: 0, version: null, ok: false };
  }
}
