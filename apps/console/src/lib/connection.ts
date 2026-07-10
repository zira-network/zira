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

// The canonical public read gateway, used ONLY to cross-check a LOCAL node's settled balance/history when
// that node lags the mesh. A churny home miner keeps finalizing but can miss a gossiped payout tx, so its
// own balanceOf(self) under-reports and the app looked like it earned nothing even though every master had
// credited it. This is a display-layer reconciliation: it never signs, never spends, and never changes what
// the local node stores or votes. Overridable at build time (VITE_ZIRA_CONSENSUS_GATEWAY) so a private
// deployment can point it at its own public read node.
export const NETWORK_CONSENSUS_GATEWAY: string = (() => {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_ZIRA_CONSENSUS_GATEWAY;
  return (env && env.trim()) ? env.trim().replace(/\/$/, "") : "https://gateway.zira.network";
})();

// A best-effort read of the network-consensus view for one address: the settled balance PLUS emittedUZIR,
// the monotonic pure-epoch supply counter used to tell which view is more advanced. Never throws; returns
// ok:false when the gateway is unreachable so callers simply keep the local value.
export interface NetworkView { balanceUZIR: number; emittedUZIR: number; ok: boolean; }
export async function fetchNetworkView(address: string, signal?: AbortSignal): Promise<NetworkView> {
  const base = NETWORK_CONSENSUS_GATEWAY;
  try {
    const [balR, statR] = await Promise.all([
      fetch(`${base}/rpc/balance?address=${encodeURIComponent(address)}`, { signal }),
      fetch(`${base}/rpc/stats`, { signal }),
    ]);
    if (!balR.ok || !statR.ok) return { balanceUZIR: 0, emittedUZIR: 0, ok: false };
    const bal = (await balR.json()) as { uZIR?: unknown };
    const stat = (await statR.json()) as { emittedUZIR?: unknown };
    return {
      balanceUZIR: typeof bal.uZIR === "number" ? bal.uZIR : 0,
      emittedUZIR: typeof stat.emittedUZIR === "number" ? stat.emittedUZIR : 0,
      ok: true,
    };
  } catch {
    return { balanceUZIR: 0, emittedUZIR: 0, ok: false };
  }
}

// A best-effort read of an address's settled tx history from the network-consensus gateway, used when the
// local node is detected to be behind so the wallet still shows the full earning history. Never throws.
export async function fetchNetworkHistory(address: string, limit = 250, signal?: AbortSignal): Promise<unknown[] | null> {
  try {
    const r = await fetch(`${NETWORK_CONSENSUS_GATEWAY}/rpc/history?address=${encodeURIComponent(address)}&limit=${limit}`, { signal });
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
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
