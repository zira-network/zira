// node/src/config.ts
// Node configuration from environment variables and sensible defaults. A node runs with zero
// config on devnet. The tier model is reflected here: Tier 1 (node participation) is always on;
// Tier 2 (inference provider) is opt in via ZIRA_PROVIDE. Old ZIRA_PROVIDER_* names are kept as
// aliases for backward compatibility.
//
// Hardware use is independent of mining. Two distinct switches live in the mining config (mining.json,
// see node/src/models/types.ts and ModelService): ZIRA_MINE serves the field for others and earns;
// ZIRA_LOCAL_INFERENCE ("My tasks only") uses local inference (native node-llama-cpp engine if a model
// is loaded locally, else the configured local endpoint) for the user's OWN Console/Resonator tasks
// without serving the field or earning. A user can set ZIRA_LOCAL_INFERENCE=1 without ever mining.
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PROVIDER_CONFIG,
  type NetworkId, type ProviderConfig, type Domain,
} from "@zira/protocol";

// The public VPS is the canonical mainnet sync source: full nodes dial it directly and mobile/web clients
// read its gateway RPC. We intentionally do NOT depend on a website-hosted bootstrap registry. More
// master/seed nodes can be appended here later. Keep this peer id in sync with the VPS seed node's stable
// libp2p identity (its persisted peer-key.bin). ZIRA_BOOTSTRAP overrides this at runtime.
const MAINNET_DEFAULT_BOOTSTRAP = [
  "/ip4/157.173.106.50/tcp/9645/p2p/12D3KooWDybdhTxKevNHXktAAKioj24d5oKpDYLF8JAdBMy92U86",
  "/ip4/157.173.106.50/tcp/9646/ws/p2p/12D3KooWDybdhTxKevNHXktAAKioj24d5oKpDYLF8JAdBMy92U86",
];

export interface NodeRuntimeConfig {
  network: NetworkId;
  dataDir: string;
  rpcPort: number;            // HTTP + WS for the Console GUI
  rpcHost: string;
  p2pPort: number;            // libp2p TCP
  wsPort: number;             // libp2p WebSocket (for browser light peers and cross host)
  bootstrap: string[];        // multiaddrs of peers to dial on start
  announce: string[];         // public multiaddrs to advertise, if behind NAT/known host
  bootstrapAuto: boolean;      // load signed seed registries when explicit bootstraps are missing/stale
  bootstrapRegistryUrl?: string;
  bootstrapRegistryPath?: string;
  bootstrapRequireSignature: boolean;
  founderAddress?: string;    // overrides the genesis founder, devnet/testing only
  founderKey?: string;        // private launch-authority key, so this node runs as a genesis steward
  serveConsole: boolean;      // serve the built Console at the rpc root
  consoleDir?: string;        // where the built console lives
  logLevel: "debug" | "info" | "warn" | "error";
  rpcAdminToken?: string;       // required for sensitive routes when RPC is exposed beyond loopback
  gateway: boolean;             // public gateway mode: a public RPC bind serves the SAFE PUBLIC read+query subset
                                // WITHOUT a token (sensitive/mutating/admin routes stay token-gated). This is what
                                // lets a VPS serve mobile/web clients. Without it, F6 refuses a public bind unless
                                // ZIRA_RPC_ADMIN_TOKEN is set.

  // Tier 1: node participation
  observeEnabled: boolean;    // submit PoR observations
  hardwareDetect: boolean;    // run GPU/CPU detection at startup
  obsRateLimit: number;       // max observations per minute per identity
  freeQueryLimit: number;     // free field queries per window per identity (the free tier, INITIAL allowance)
  freeQueryWindowMs: number;  // free-tier window length ("period of pause")
  freeTierDurationMs: number; // free tier tapers over this span from genesis, then closes (default 1 year)
  taskReapMs: number;         // interval between expired task scans
  fastSync: boolean;           // adopt peer snapshots, verified against a finalized checkpoint; on by default

  // Tier 2: inference provider
  provider: ProviderConfig;

  // Advanced / founder
  selfContained: boolean;     // activate FounderServices (model management, node-llama-cpp)
  eventsKey?: string;         // founder-held events/ecosystem wallet key, enables transparent airdrops
  eventsClaimZir?: number;    // ZIR per events claim
  anchorReserveKey?: string;  // founder-held anchor-reserve wallet key, enables anchor seat assignment
}

// Back-compat alias for older imports.
export type NodeConfig = NodeRuntimeConfig;

function envInt(name: string, def: number): number {
  const v = process.env[name];
  return v ? parseInt(v, 10) : def;
}
function envList(name: string): string[] {
  const v = process.env[name];
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}
function envBool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return def;
  return v === "1" || v.toLowerCase() === "true";
}

export function loadConfig(overrides: Partial<NodeRuntimeConfig> = {}): NodeRuntimeConfig {
  const network = (process.env.ZIRA_NETWORK as NetworkId) || "devnet";
  const dataDir = process.env.ZIRA_DATA_DIR || join(homedir(), ".zira", network);
  // No website-hosted registry: mainnet nodes default-dial the VPS seed(s) directly (below). A registry
  // URL can still be supplied explicitly via ZIRA_BOOTSTRAP_REGISTRY_URL if ever wanted.
  const defaultBootstrapRegistryUrl = undefined;

  // Tier 2 provider, from the new ZIRA_PROVIDE_* vars, falling back to the old ZIRA_PROVIDER_* names.
  const endpoint = process.env.ZIRA_PROVIDE_ENDPOINT || process.env.ZIRA_PROVIDER_ENDPOINT;
  const provideEnabled = envBool("ZIRA_PROVIDE", Boolean(endpoint));
  const domains = (envList("ZIRA_PROVIDE_DOMAINS").length ? envList("ZIRA_PROVIDE_DOMAINS") : envList("ZIRA_PROVIDER_DOMAINS")) as Domain[];
  const provider: ProviderConfig = {
    ...DEFAULT_PROVIDER_CONFIG,
    enabled: provideEnabled,
    endpoint: endpoint || DEFAULT_PROVIDER_CONFIG.endpoint,
    endpointModel: process.env.ZIRA_PROVIDE_MODEL || process.env.ZIRA_PROVIDER_MODEL || DEFAULT_PROVIDER_CONFIG.endpointModel,
    domains,
    label: process.env.ZIRA_PROVIDE_LABEL || process.env.ZIRA_PROVIDER_LABEL || DEFAULT_PROVIDER_CONFIG.label,
    supportsStreaming: envBool("ZIRA_PROVIDE_STREAMING", false),
  };

  return {
    network,
    dataDir,
    rpcPort: envInt("ZIRA_RPC_PORT", 8645),
    rpcHost: process.env.ZIRA_RPC_HOST || "127.0.0.1",
    p2pPort: envInt("ZIRA_P2P_PORT", 9645),
    wsPort: envInt("ZIRA_WS_PORT", 9646),
    bootstrap: envList("ZIRA_BOOTSTRAP").length ? envList("ZIRA_BOOTSTRAP") : (network === "mainnet" ? MAINNET_DEFAULT_BOOTSTRAP : []),
    announce: envList("ZIRA_ANNOUNCE"),
    bootstrapAuto: envBool("ZIRA_BOOTSTRAP_AUTO", true),
    bootstrapRegistryUrl: process.env.ZIRA_BOOTSTRAP_REGISTRY_URL || defaultBootstrapRegistryUrl,
    bootstrapRegistryPath: process.env.ZIRA_BOOTSTRAP_REGISTRY_PATH || undefined,
    bootstrapRequireSignature: envBool("ZIRA_BOOTSTRAP_REQUIRE_SIGNATURE", network === "mainnet"),
    founderAddress: process.env.ZIRA_FOUNDER_ADDRESS,
    founderKey: process.env.ZIRA_FOUNDER_KEY,
    serveConsole: process.env.ZIRA_SERVE_CONSOLE !== "0",
    consoleDir: process.env.ZIRA_CONSOLE_DIR,
    logLevel: (process.env.ZIRA_LOG_LEVEL as NodeRuntimeConfig["logLevel"]) || "info",
    rpcAdminToken: process.env.ZIRA_RPC_ADMIN_TOKEN,
    gateway: envBool("ZIRA_GATEWAY", false),

    observeEnabled: envBool("ZIRA_OBSERVE", true),
    hardwareDetect: envBool("ZIRA_HARDWARE_DETECT", true),
    obsRateLimit: envInt("ZIRA_OBS_RATE_LIMIT", 20),
    freeQueryLimit: envInt("ZIRA_FREE_QUERY_LIMIT", 10),
    freeQueryWindowMs: envInt("ZIRA_FREE_QUERY_WINDOW_MS", 600_000),
    freeTierDurationMs: envInt("ZIRA_FREE_TIER_DURATION_MS", 365 * 24 * 60 * 60 * 1000),
    taskReapMs: envInt("ZIRA_TASK_REAP_MS", 30_000),
    // Fast-sync is hardened: a snapshot is adopted only when it hashes to a finalized checkpoint
    // backed by >= 67% of master trust including a genesis founder. On by default; ZIRA_FULL_SYNC=1
    // still forces a full replay from genesis.
    fastSync: envBool("ZIRA_FAST_SYNC", true),

    provider,

    selfContained: envBool("ZIRA_SELF_CONTAINED", false),
    eventsKey: process.env.ZIRA_EVENTS_KEY || undefined,
    eventsClaimZir: process.env.ZIRA_EVENTS_CLAIM_ZIR ? Number(process.env.ZIRA_EVENTS_CLAIM_ZIR) : undefined,
    anchorReserveKey: process.env.ZIRA_ANCHOR_RESERVE_KEY || undefined,
    ...overrides,
  };
}
