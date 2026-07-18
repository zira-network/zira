// apps/console/src/lib/platform.ts
// Whether the Console is running inside the ZIRA desktop app. Mining (running a model on your CPU
// or GPU) is desktop only, so these features are hidden on the web and on mobile.
export interface HardwareTelemetry { cpuModel: string; cpuCores: number; cpuPct: number; gpuModel?: string; ramTotalGB: number; ramUsedGB: number; ramPct: number; platform: string; arch: string }
interface ZiraBridge { isDesktop: boolean; platform: string; version: string; resetAndRelaunch?: () => Promise<boolean>; resyncLedger?: () => Promise<boolean>; hardware?: () => Promise<HardwareTelemetry> }

export function isDesktop(): boolean {
  if (typeof window === "undefined") return false;
  // Dev-only opt-in so the desktop-gated pages (Mine) can be previewed in the browser dev server against a
  // local node. Never set in production; the real desktop app injects window.zira.isDesktop via preload.
  try { if (import.meta.env.DEV && localStorage.getItem("zira.devDesktop") === "1") return true; } catch { /* */ }
  return !!(window as unknown as { zira?: ZiraBridge }).zira?.isDesktop;
}

// Desktop only: ask the app to wipe EVERYTHING (ledger + wallet + model cache + app storage) and relaunch
// clean. Returns null when not running in the desktop app (web/mobile fall back to a browser-side wipe).
export function desktopResetAndRelaunch(): Promise<boolean> | null {
  const fn = (window as unknown as { zira?: ZiraBridge }).zira?.resetAndRelaunch;
  return typeof fn === "function" ? fn() : null;
}

// Desktop only: the SAFE remedy. Rebuild ONLY the local ledger (events/snapshot/zti-history) and relaunch,
// keeping the node identity + wallet + app storage intact. Returns null when not in the desktop app.
export function desktopResyncLedger(): Promise<boolean> | null {
  const fn = (window as unknown as { zira?: ZiraBridge }).zira?.resyncLedger;
  return typeof fn === "function" ? fn() : null;
}

// Desktop only: live machine telemetry (hardware names + CPU/RAM utilization) for the Mine page. Returns
// null when not in the desktop app (web/mobile have no hardware bridge); the UI degrades gracefully.
export function getHardwareTelemetry(): Promise<HardwareTelemetry> | null {
  const fn = (window as unknown as { zira?: ZiraBridge }).zira?.hardware;
  return typeof fn === "function" ? fn() : null;
}

// Whether the Console runs inside a Capacitor native app (Android/iOS). Such a build serves its own
// bundle from localhost but is NOT a ZIRA node, so it must always talk to the remote gateway rather than
// same-origin. Capacitor injects window.Capacitor into the WebView before the app bundle runs.
export function isNativeApp(): boolean {
  if (typeof window === "undefined") return false;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean; isNative?: boolean } }).Capacitor;
  if (!cap) return false;
  try { return typeof cap.isNativePlatform === "function" ? cap.isNativePlatform() : !!cap.isNative; }
  catch { return false; }
}

export function desktopPlatform(): string {
  return (window as unknown as { zira?: ZiraBridge }).zira?.platform ?? "";
}

// Whether this is an Apple platform (macOS / iOS), used to label the primary keyboard modifier as Cmd
// rather than Ctrl. Best-effort: prefers the desktop bridge platform, falls back to the user agent.
export function isApplePlatform(): boolean {
  const fromBridge = desktopPlatformSafe();
  if (fromBridge) return /darwin|mac/i.test(fromBridge);
  if (typeof navigator === "undefined") return false;
  const ua = navigator.platform || navigator.userAgent || "";
  return /mac|iphone|ipad|ipod/i.test(ua);
}

function desktopPlatformSafe(): string {
  try { return desktopPlatform(); } catch { return ""; }
}
