// apps/console/src/lib/version.ts
// Bump this when you cut a new build so you can confirm at a glance which build is running
// (shown in the sidebar footer). If the app does not show this version, you are on an older build.
export const APP_VERSION = "v3.3.0";

// ---- update check (the app has no auto-updater; this is a lightweight "update available" signal) ----
// Best-effort: asks GitHub for the latest published release tag and compares it to APP_VERSION. Purely a
// read; never blocks the app. The UI can call this and show a banner + download link when an update exists.
const RELEASES_LATEST = "https://api.github.com/repos/zira-network/zira/releases/latest";
const DOWNLOAD_PAGE = "https://zira.network/#download";

function parseSemver(v: string): [number, number, number] {
  const m = String(v).replace(/^v/, "").match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}
/** True if `latest` is a strictly newer semver than `current`. */
export function isNewer(latest: string, current: string): boolean {
  const [la, lb, lc] = parseSemver(latest);
  const [ca, cb, cc] = parseSemver(current);
  if (la !== ca) return la > ca;
  if (lb !== cb) return lb > cb;
  return lc > cc;
}
export interface UpdateInfo { updateAvailable: boolean; latest: string; url: string; }
/** Check whether a newer release exists. Never throws; returns updateAvailable:false on any error/offline. */
export async function checkForUpdate(timeoutMs = 6000): Promise<UpdateInfo> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(RELEASES_LATEST, { headers: { Accept: "application/vnd.github+json" }, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) throw new Error("release lookup failed");
    const j = (await r.json()) as { tag_name?: string; html_url?: string };
    const latest = String(j.tag_name || "");
    return { updateAvailable: !!latest && isNewer(latest, APP_VERSION), latest, url: j.html_url || DOWNLOAD_PAGE };
  } catch {
    return { updateAvailable: false, latest: "", url: DOWNLOAD_PAGE };
  }
}
