// apps/console/src/client/createClient.ts
// Factory: the Console only ever talks to a ZIRA Core node. The node is a peer in the P2P network,
// so the GUI is synced by peers. A manual override lives in Settings. Pointing the Console at your
// own local node is fully trustless for you.
import type { ZiraClient } from "@zira/protocol";
import { NodeClient } from "./NodeClient";
import { isDesktop, isNativeApp } from "../lib/platform";

export type ClientMode = "auto" | "node";
export interface ClientInfo { client: ZiraClient; mode: "node"; base: string; }

// The default public ZIRA gateway. Used by the web and mobile builds when no build-time gateway is set,
// so a plain build is reachable out of the box instead of pointing at a non-existent local node. Set
// VITE_ZIRA_NODE_URL at build time (for example to a TLS domain like https://gateway.zira.network) to
// override this, or change it in Settings at runtime (zira.nodeBase). Keep this in sync with the
// Android cleartext allowlist (network_security_config.xml) and web/.env.example.
export const DEFAULT_PUBLIC_GATEWAY = "http://157.173.106.50:8645";

// Resolve the default node/gateway base at call time (not module load), so platform globals that the
// host injects (Capacitor's window.Capacitor, the desktop bridge) are reliably present. The Settings
// override (zira.nodeBase) always wins in getApiBase(). Priority after that:
//  1. A build-time gateway baked into the bundle (VITE_ZIRA_NODE_URL).
//  2. A Capacitor native app (Android/iOS): ALWAYS the public gateway. It serves its bundle from
//     localhost but is not a node, so it must never resolve to same-origin (the old bug that left the
//     mobile app forever "connecting" against itself).
//  3. The desktop app or a self-hosted node serving the Console: same origin, fully trustless.
//  4. A browser build served from a local node: same origin; any other static host: the public gateway.
function computeDefaultBase(): string {
  const configured = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_ZIRA_NODE_URL;
  if (configured && configured.trim()) return configured.trim().replace(/\/$/, "");
  if (isNativeApp()) return DEFAULT_PUBLIC_GATEWAY;
  if (isDesktop()) {
    if (typeof window !== "undefined") return window.location.origin.replace(/\/$/, "");
    return "http://127.0.0.1:8645";
  }
  if (typeof window !== "undefined") {
    const origin = window.location.origin;
    const proto = window.location.protocol;
    if (proto === "http:" || proto === "https:") {
      const host = window.location.hostname;
      if (host === "localhost" || host === "127.0.0.1" || host === "::1") return origin.replace(/\/$/, "");
    }
  }
  return DEFAULT_PUBLIC_GATEWAY;
}

export function getApiBase(): string {
  if (typeof localStorage !== "undefined") return localStorage.getItem("zira.nodeBase") || computeDefaultBase();
  return computeDefaultBase();
}
export function setApiBase(base: string): void { localStorage.setItem("zira.nodeBase", base); }

// Local mode (use your own machine for your own tasks) only makes sense when the Console talks to a
// LOCAL node: the desktop app, or a browser pointed at a node on this machine. On the web build the
// node is a remote gateway, so Local mode and the own-hardware control are hidden and only Field is
// offered. This is the right test, not "is Electron": a self-hosted node opened in a browser is local.
export function isLocalNode(): boolean {
  if (isDesktop()) return true;
  try {
    const host = new URL(getApiBase()).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch { return false; }
}

export function getClientMode(): ClientMode {
  return (localStorage.getItem("zira.clientMode") as ClientMode) || "auto";
}
export function setClientMode(mode: ClientMode): void { localStorage.setItem("zira.clientMode", mode); }

export async function createClient(_myAddress?: string): Promise<ClientInfo> {
  const base = getApiBase();
  // Both "auto" and "node" always return the NodeClient. If the node probe fails we still return it;
  // the shell shows a disconnected/offline badge rather than falling back to any local simulator.
  const node = new NodeClient(base);
  return { client: node, mode: "node", base };
}
