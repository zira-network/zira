// node/src/p2p/bootstrapRegistry.ts
// Signed bootstrap registry loading for first-contact peer discovery. Explicit bootstraps still win,
// but a clean node can now discover launch-authorized public seeds without manual address sharing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { multiaddr } from "@multiformats/multiaddr";
import { addressFromPubKey, verifyRecord, type Address, type NetworkId, type PublicKey, type Signature } from "@zira/protocol";
import { log } from "../log.js";

export interface BootstrapSeedEntry {
  multiaddr: string;
  label?: string;
  roles?: string[];
  region?: string;
  priority?: number;
}

export interface BootstrapSeedRegistry {
  version: 1;
  network: NetworkId;
  generatedAt: number;
  expiresAt?: number;
  seeds: BootstrapSeedEntry[];
  priority?: number;
  pubKey: PublicKey;
  sig: Signature;
}

export interface ResolveBootstrapOptions {
  explicit: string[];
  network: NetworkId;
  dataDir: string;
  authorizedFounders: Address[];
  auto: boolean;
  requireSignature: boolean;
  registryUrl?: string;
  registryPath?: string;
}

export interface ResolveBootstrapResult {
  peers: string[];
  discovered: string[];
  registriesLoaded: number;
}

const CACHE_FILE = "bootstrap-seeds-cache.json";
const REGISTRY_FILE = "bootstrap-seeds.json";
const ROLE_PRIORITY: Record<string, number> = {
  master: -30,
  "master-node": -30,
  "master-candidate": -20,
  bootstrap: -10,
  "community-seed": -5,
};

export function loadSavedBootstrapPeers(dataDir: string): string[] {
  try {
    const path = resolve(dataDir, "peers.json");
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return mergeBootstrapPeers(parsed.map((peer) => String(peer)));
  } catch {
    return [];
  }
}

export function mergeBootstrapPeers(peers: string[]): string[] {
  return uniqueValidPeers(peers);
}

export async function resolveBootstrapPeers(opts: ResolveBootstrapOptions): Promise<ResolveBootstrapResult> {
  const explicit = uniqueValidPeers(opts.explicit);
  if (!opts.auto) return { peers: explicit, discovered: [], registriesLoaded: 0 };

  const registries: BootstrapSeedRegistry[] = [];
  if (opts.registryUrl) {
    const remote = await loadRegistryUrl(opts.registryUrl, opts);
    if (remote) {
      registries.push(remote);
      saveRegistryCache(opts.dataDir, remote);
    }
  }
  const cache = loadRegistryFile(resolve(opts.dataDir, CACHE_FILE), opts);
  if (cache) registries.push(cache);
  for (const candidate of bundledFileCandidates(opts)) {
    const registry = loadRegistryFile(candidate, opts);
    if (registry) registries.push(registry);
  }

  const discovered = uniqueValidPeers(registries
    .flatMap((r, registryIndex) => r.seeds.map((seed, seedIndex) => ({
      multiaddr: seed.multiaddr,
      priority: rankSeed(seed, r, registryIndex),
      seedIndex,
    })))
    .sort((a, b) => (a.priority - b.priority) || (a.seedIndex - b.seedIndex))
    .map((seed) => seed.multiaddr));
  const peers = mergeBootstrapPeers([...explicit, ...discovered]);
  return { peers, discovered, registriesLoaded: registries.length };
}

function rankSeed(seed: BootstrapSeedEntry, registry: BootstrapSeedRegistry, registryIndex: number): number {
  const explicitPriority = seed.priority ?? registry.priority ?? registryIndex + 1;
  const roleBoost = Math.min(0, ...(seed.roles ?? []).map((role) => ROLE_PRIORITY[role.toLowerCase()] ?? 0));
  return explicitPriority + roleBoost;
}

export function verifyBootstrapRegistry(
  registry: unknown,
  opts: Pick<ResolveBootstrapOptions, "network" | "authorizedFounders" | "requireSignature">,
): registry is BootstrapSeedRegistry {
  if (!registry || typeof registry !== "object") return false;
  const r = registry as Partial<BootstrapSeedRegistry>;
  if (r.version !== 1 || r.network !== opts.network) return false;
  if (!Number.isFinite(r.generatedAt) || !Array.isArray(r.seeds)) return false;
  if (r.expiresAt !== undefined && (!Number.isFinite(r.expiresAt) || r.expiresAt < Date.now())) return false;
  if (!r.seeds.every(isSeedEntry)) return false;

  if (!opts.requireSignature) return true;
  if (typeof r.pubKey !== "string" || typeof r.sig !== "string") return false;
  if (!verifyRecord(r as BootstrapSeedRegistry)) return false;
  try {
    return opts.authorizedFounders.includes(addressFromPubKey(r.pubKey));
  } catch {
    return false;
  }
}

function bundledFileCandidates(opts: ResolveBootstrapOptions): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    opts.registryPath,
    resolve(process.cwd(), "docs", REGISTRY_FILE),
    resolve(process.cwd(), "source", "docs", REGISTRY_FILE),
    resolve(here, "..", "..", "docs", REGISTRY_FILE),
    resolve(here, "..", "..", "..", "docs", REGISTRY_FILE),
  ].filter(Boolean) as string[];
  return [...new Set(candidates)];
}

function loadRegistryFile(path: string, opts: ResolveBootstrapOptions): BootstrapSeedRegistry | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!verifyBootstrapRegistry(parsed, opts)) {
      log.debug("bootstrap registry rejected", path);
      return null;
    }
    log.info("bootstrap registry loaded", path);
    return parsed;
  } catch (e) {
    log.warn("bootstrap registry load failed", path, (e as Error).message);
    return null;
  }
}

async function loadRegistryUrl(url: string, opts: ResolveBootstrapOptions): Promise<BootstrapSeedRegistry | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = await res.json();
    if (!verifyBootstrapRegistry(parsed, opts)) {
      log.warn("remote bootstrap registry rejected", url);
      return null;
    }
    log.info("remote bootstrap registry loaded", url);
    return parsed;
  } catch (e) {
    log.warn("remote bootstrap registry load failed", url, (e as Error).message);
    return null;
  }
}

function saveRegistryCache(dataDir: string, registry: BootstrapSeedRegistry): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(resolve(dataDir, CACHE_FILE), `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  } catch (e) {
    log.warn("bootstrap registry cache write failed", (e as Error).message);
  }
}

function isSeedEntry(seed: unknown): seed is BootstrapSeedEntry {
  if (!seed || typeof seed !== "object") return false;
  const s = seed as Partial<BootstrapSeedEntry>;
  if (typeof s.multiaddr !== "string" || !isValidSeedMultiaddr(s.multiaddr)) return false;
  if (s.label !== undefined && typeof s.label !== "string") return false;
  if (s.region !== undefined && typeof s.region !== "string") return false;
  if (s.priority !== undefined && !Number.isFinite(s.priority)) return false;
  return s.roles === undefined || (Array.isArray(s.roles) && s.roles.every((r) => typeof r === "string"));
}

function uniqueValidPeers(peers: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const peer of peers) {
    const value = peer.trim();
    if (!value || seen.has(value) || !isValidSeedMultiaddr(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function isValidSeedMultiaddr(addr: string): boolean {
  try {
    const ma = multiaddr(addr);
    const value = ma.toString();
    return value.includes("/tcp/") && value.includes("/p2p/");
  } catch {
    return false;
  }
}
