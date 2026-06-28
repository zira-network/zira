// apps/console/src/lib/platform.ts
// Whether the Console is running inside the ZIRA desktop app. Mining (running a model on your CPU
// or GPU) is desktop only, so these features are hidden on the web and on mobile.
interface ZiraBridge { isDesktop: boolean; platform: string; version: string }

export function isDesktop(): boolean {
  return typeof window !== "undefined" && !!(window as unknown as { zira?: ZiraBridge }).zira?.isDesktop;
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
