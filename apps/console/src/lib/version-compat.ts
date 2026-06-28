// apps/console/src/lib/version-compat.ts
// Lightweight semver-style version comparison for API feature gating. This is the core of API version
// negotiation: future Console releases can ship features that depend on a newer node, gate them behind
// nodeAtLeast(), and degrade gracefully (feature hidden/disabled, never a crash or a failing fetch loop)
// when the connected node is older. A missing/unknown node version is treated as "0.0.0" so any
// version-sensitive feature stays OFF rather than firing requests an old node cannot answer.

// Strip a leading "v" and any build/prerelease suffix (e.g. "v1.2.3-rc1" -> "1.2.3").
function normalize(v: string): string {
  return v.trim().replace(/^v/i, "").split(/[-+]/)[0] ?? "0.0.0";
}

// Returns true when nodeVersion >= minVersion. Treats a missing/unknown version as "0.0.0".
export function hasNodeFeature(nodeVersion: string | null | undefined, minVersion: string): boolean {
  const parse = (v: string) => normalize(v).split(".").map((n) => parseInt(n, 10) || 0);
  const nv = parse(nodeVersion ?? "0.0.0");
  const mv = parse(minVersion);
  for (let i = 0; i < Math.max(nv.length, mv.length); i++) {
    const a = nv[i] ?? 0, b = mv[i] ?? 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true; // equal
}

// A friendly display for the node version: the raw string when known, "unknown" otherwise. Older nodes
// do not yet report a version field on /rpc/stats, so this is expected to read "unknown" against them.
export function formatNodeVersion(nodeVersion: string | null | undefined): string {
  return nodeVersion && nodeVersion.trim() ? nodeVersion.trim() : "unknown";
}
