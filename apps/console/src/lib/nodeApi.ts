// apps/console/src/lib/nodeApi.ts
// Thin helpers for node-specific RPC the ZiraClient interface does not cover: node + provider
// status (Tier 1/2), provider profiles, query coordination, ZTI history, resonator analytics,
// anchors, launch-authority model advisory, supply, and consensus.
import { getApiBase, isLocalNode, DEFAULT_PUBLIC_GATEWAY } from "../client/createClient";
import { fetchDedup } from "./fetchDedup";
import { Wallet } from "./keys";
import type { HardwareProfile, NodeConfig, ProviderConfig, Domain, Anchor, SignedTx } from "@zira/protocol";

function base(): string { return getApiBase().replace(/\/$/, "") + "/rpc"; }

// The anchor event (status + receiving addresses) and the contribution queue are a single, steward-run,
// network-wide feature served from the shared public gateway, NOT from a user's own local node. A desktop
// user's local node would each carry its own off-by-default copy, so reading/writing it there is exactly
// why the event the steward turned on was invisible to everyone else. These calls therefore always target
// the gateway: when the Console already talks to a remote node (mobile/web) that IS the gateway; on a local
// node (desktop) we use the build-time gateway override or the default public gateway.
function anchorBase(): string {
  if (!isLocalNode()) return base();
  const configured = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_ZIRA_NODE_URL;
  const gw = configured && configured.trim() ? configured.trim() : DEFAULT_PUBLIC_GATEWAY;
  return gw.replace(/\/$/, "") + "/rpc";
}
async function rpcGetFrom<T>(baseUrl: string, path: string): Promise<T> {
  const r = await fetchDedup(baseUrl + path);
  if (!r.ok) throw new Error(`GET ${path} failed: ${r.status}`);
  return r.json() as Promise<T>;
}
async function rpcPostTo<T>(baseUrl: string, path: string, body: unknown): Promise<T> {
  const r = await fetch(baseUrl + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `POST ${path} failed: ${r.status}`);
  return data as T;
}

// Sign a fresh steward challenge with the loaded wallet, so steward actions authorize on ANY node, even a
// keyless public gateway, by signature rather than by the node holding the key. The node verifies the
// signature is by a founder-address wallet (verifyStewardSig). Returns {} if no wallet is unlocked, in
// which case the node falls back to its own isFounder/canSteward check.
export function stewardAuth(): { stewardPubKey?: string; stewardChallenge?: string; stewardSig?: string } {
  try {
    const pubKey = Wallet.publicKey();
    if (!pubKey || !Wallet.isUnlocked()) return {};
    const challenge = `zira-steward:${Date.now()}`;
    return { stewardPubKey: pubKey, stewardChallenge: challenge, stewardSig: Wallet.sign(challenge) };
  } catch { return {}; }
}

// All GET RPC shares an in-flight request: if the same URL is already pending, the existing promise is
// reused instead of firing a second identical request. This is transparent to callers; it cuts duplicate
// traffic when several mounted views poll the same endpoint on overlapping cadences.
export async function rpcGet<T>(path: string): Promise<T> {
  const r = await fetchDedup(base() + path);
  if (!r.ok) throw new Error(`GET ${path} failed: ${r.status}`);
  return r.json() as Promise<T>;
}
export async function rpcPost<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(base() + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as { error?: string }).error ?? `POST ${path} failed: ${r.status}`);
  return data as T;
}

// ---- status (Tier 1 node + mining + Tier 2 provider) ----
export interface ProviderStatus { active: boolean; endpoint: string; reachable: boolean; queriesAnswered: number; earnedTodayUZIR: number }
export interface ModelMetaView { id: string; name: string; arch?: string; quant?: string; sizeBytes: number; domains?: Domain[]; version?: number; url?: string; ts: number }
export interface FieldModel { meta: ModelMetaView; providers: number; targetHosts?: number; distributionProgress?: number; ready?: boolean; local: boolean }
export interface MiningStatus {
  enabled: boolean;
  mode: "auto" | "select";
  modelId: string | null;
  endpoint?: string;
  endpointModel?: string;
  gpuLayers: number;
  threads: number;
  useRecommendedHardware: boolean;
  engineAvailable: boolean;
  loadedModel: string | null;
  serving: boolean;
  answerLabel: string;
  recommendedModelId: string | null;
  answered: number;
  localTaskPermission: boolean;
  // own-task local inference: the user's own hardware for the user's own Console/Resonator tasks,
  // independent of mining (does not serve the field, does not earn).
  ownTaskInference: boolean;
  ownTaskReady: boolean;
  ownTaskLabel: string;
  storageEnabled: boolean;
  storageCapBytes: number;
  storageLimitGb: number;
  storageUsedBytes: number;
  storageDownloadingBytes: number;
  known: FieldModel[];
}
export interface MiningPatch { enabled?: boolean; mode?: "auto" | "select"; modelId?: string | null; endpoint?: string; endpointModel?: string; gpuLayers?: number; threads?: number; useRecommendedHardware?: boolean; localTaskPermission?: boolean; ownTaskInference?: boolean; storageEnabled?: boolean; storageCapBytes?: number; storageLimitGb?: number }

// User-controllable peer-to-peer storage (soft infra, not ledger state). capBytes defaults to 1 GiB.
export interface StorageState { enabled: boolean; capBytes: number; usedBytes: number }
export interface StatusInfo {
  nodeConfig: NodeConfig;
  providerConfig: ProviderConfig;
  providerStatus: ProviderStatus;
  mining: MiningStatus;
  hardware: HardwareProfile | null;
  isFounder: boolean;
  founderAddresses?: string[];
  address: string;
  balanceUZIR: number;
}
export interface StatusPatch { nodeConfig?: Partial<NodeConfig>; mining?: MiningPatch; providerConfig?: Partial<ProviderConfig> }
export interface LocalLaunchMinerSummary {
  port: number;
  address: string;
  isFounder: boolean;
  mining: boolean;
  serving: boolean;
  providerActive: boolean;
  providerReachable: boolean;
  answerLabel: string;
  queriesAnswered: number;
  earnedTodayUZIR: number;
  balanceUZIR: number;
}

// ---- live, decentralized pricing ----
export interface Pricing { queryUZIR: number; taskBaseUZIR: number; resonatorCreationUZIR?: number; resonatorCreationOpen?: boolean; openQueries: number; providersOnline: number }

// ---- free tier (limited free field questions per rolling window, enforced by the node) ----
export interface FreeTierQuota { limit: number; used: number; remaining: number; resetMs: number; windowMs: number; contributor?: boolean; unlimited?: boolean; freeTierEnded?: boolean }

// ---- provider profiles ----
export interface ProviderView {
  pubKey: string; address: string; label: string; model: string; domains: Domain[]; zti: number;
  tokensPerSec: number; contextWindowTokens: number; supportsStreaming: boolean; modelHint?: string; updatedAt: number;
}

// ---- launch-authority model advisory ----
export interface ModelRecommendation { label: string; backendHint: string; domains: Domain[]; notes: string; publishedAt: number; pubKey: string; sig: string }

// ---- query fusion + ZTI history + analytics ----
export interface FusionContributor { address: string; zti: number; weight: number; answerSnippet: string }
export interface QueryFusion { queryId: string; contributors: FusionContributor[]; fusedAnswer: string; confidenceScore: number; domain: Domain }
export interface ZtiSnapshot { epoch: number; zti: number; domain: Domain }
export interface ResonatorStats { id: string; window: string; assigned: number; completed: number; expired: number; disputed: number; totalEarnedUZIR: number; avgResponseMs: number }

// ---- anchors ----
export interface AnchorClassInfo { class: string; name: string; seats: number; tier: "inner" | "outer"; weight: number; minZTI: number; stakeZIR: number; role: string }
export interface AnchorSeatInfo { class: string; name: string; total: number; taken: number; listed: number; available: number }
export interface AnchorSeatSummary { total: number; classes: AnchorSeatInfo[]; seats: Anchor[] }

export interface PeerConnection { peerId: string; addr: string; direction: string }
export interface NetInfo { peerId: string; addrs: string[]; peers: number; savedPeers: string[]; connections?: PeerConnection[] }
export interface SupplyInfo { emitted: number; burned: number; reserve: number; issued: number; circulating: number; maxSupplyUZIR: number; auditAgrees: boolean }
export interface BootstrapSeedCandidate {
  multiaddr: string;
  label: string;
  roles: string[];
  source: "self" | "connected" | "saved" | "storage";
  shareable: boolean;
  eligible: boolean;
  status: "ready" | "public-unchecked" | "local" | "unreachable";
  reason: string;
  score: number;
  priority: number;
}

export interface ExtendedStats {
  network: string; phase: string; providersOnline: number; activeNodes: number; avgZti: number;
  locksPerMinute: number; circulatingUZIR: number; emittedUZIR: number; burnedUZIR: number; reserveUZIR: number;
  peers: number; finalizedEpoch: number; currentEpoch?: number; stateRoot: string; pool: { txs: number; observations: number };
  models: number; mastersCount: number; maxSupplyUZIR: number;
}

export interface EventsStatus { configured: boolean; active: boolean; claimUZIR: number; walletUZIR: number; visible: boolean }
export interface TreasuryWallet { key: string; label: string; address: string; role: string; uZIR: number }
export interface Treasury { network: string; wallets: TreasuryWallet[] }

// ---- steward assigns anchor seats by contribution (no codes); see anchorTransferPositions ----
export interface AnchorPositionTransferResult { ok: boolean; reason?: string; seatIds?: string[]; vestingUZIR?: number; vestStartAt?: number; vestEndAt?: number }

export const NodeApi = {
  stats: () => rpcGet<ExtendedStats>("/stats"),

  // Canonical NETWORK view for the Explorer: always the shared consensus gateway (the same source the
  // website Explorer reads), so a desktop user's Explorer shows the WHOLE network rather than their own
  // local node's partial/still-syncing view — which is why the in-app and web explorers used to disagree.
  // On web/mobile anchorBase() already IS the gateway, so this is identical to stats()/supply() there.
  networkStats: () => rpcGetFrom<ExtendedStats>(anchorBase(), "/stats"),
  networkSupply: () => rpcGetFrom<SupplyInfo>(anchorBase(), "/supply"),
  // Network-scoped reads for the Explorer, mirroring networkStats/networkSupply: on a local desktop node
  // these target the shared consensus gateway so the Explorer shows the WHOLE network's online providers and
  // anchor seats, not just what the local node has heard. On web/mobile anchorBase() already IS the gateway.
  networkProviders: () => rpcGetFrom<ProviderView[]>(anchorBase(), "/providers"),
  networkAnchorSeats: () => rpcGetFrom<AnchorSeatSummary>(anchorBase(), "/anchors/seats"),

  // labeled project wallets (reserve, events, network, resonator pool, steward ops) + live balances
  treasury: () => rpcGet<Treasury>("/treasury"),

  // transparent ecosystem events (airdrops/grants from the founder-held events wallet)
  eventsStatus: () => rpcGet<EventsStatus>("/events/status"),
  eventsClaim: (address: string) => rpcPost<{ ok: boolean; amountUZIR?: number; reason?: string }>("/events/claim", { address }),
  eventsConfig: (patch: { active?: boolean; claimZir?: number }) => rpcPost<EventsStatus>("/events/config", { ...patch, ...stewardAuth() }),

  // node + mining + provider status (canonical; /mining kept server-side as an alias)
  status: () => rpcGet<StatusInfo>("/status"),
  setStatus: (patch: StatusPatch) => rpcPost<StatusInfo>("/status", patch),
  setMining: (patch: MiningPatch) => rpcPost<StatusInfo>("/status", { mining: patch }),
  refreshHardware: () => rpcPost<StatusInfo>("/hardware/refresh", {}),

  // What this address earned by ANSWERING the field (coordination payouts), derived on-chain by the node.
  answererEarnings: (address: string) => rpcGet<{ address: string; earnedUZIR: number; payouts: number }>(`/answerers/mine?address=${encodeURIComponent(address)}`),

  // user-controllable peer-to-peer storage: enable/disable + byte cap (default 1 GiB). Persisted node-side.
  getStorage: () => rpcGet<StorageState>("/storage"),
  setStorage: (patch: { enabled?: boolean; capBytes?: number }) => rpcPost<StorageState>("/storage", patch),
  clearStorage: () => rpcPost<StorageState & { cleared?: number; freedBytes?: number }>("/storage", { clear: true }),

  // own-task local inference: the user's own hardware for the user's own Console/Resonator tasks.
  // Decoupled from mining: it never serves the field, never answers others, and never earns.
  ownTaskStatus: () => rpcGet<{ enabled: boolean; ready: boolean; label: string }>("/own-task/status"),
  ownTaskGenerate: (messages: { role: "user" | "assistant"; content: string }[], system?: string) =>
    rpcPost<{ answer: string }>("/own-task/generate", { messages, system }),
  localLaunchMiners: async () => {
    const ports = [8645, 8745, 8845, 8945];
    const rows = await Promise.all(ports.map(async (port): Promise<LocalLaunchMinerSummary | null> => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/rpc/status`);
        if (!r.ok) return null;
        const st = await r.json() as StatusInfo;
        return {
          port,
          address: st.address,
          isFounder: st.isFounder,
          mining: st.mining.enabled,
          serving: st.mining.serving,
          providerActive: st.providerStatus.active,
          providerReachable: st.providerStatus.reachable,
          answerLabel: st.providerStatus.active && st.providerConfig.endpointModel ? st.providerConfig.endpointModel : st.mining.answerLabel,
          queriesAnswered: st.providerStatus.queriesAnswered,
          earnedTodayUZIR: st.providerStatus.earnedTodayUZIR,
          balanceUZIR: st.balanceUZIR,
        };
      } catch {
        return null;
      }
    }));
    return rows.filter((row): row is LocalLaunchMinerSummary => Boolean(row));
  },

  // the model field (everyone can read; only active launch authority can add)
  models: () => rpcGet<FieldModel[]>("/models"),
  provideModelLink: (m: { url: string; path?: string; name: string; arch?: string; quant?: string; domains?: Domain[]; version?: number; assigned?: boolean }) =>
    rpcPost<ModelMetaView>("/models/provide", m),
  prepareModelLink: (m: { input: { url: string; name: string; arch?: string; quant?: string; domains?: Domain[]; version?: number; ts: number }; founderPubKey: string; requestSig: string }) =>
    rpcPost<ModelMetaView>("/models/prepare", m),
  authorizeModel: (m: { meta: ModelMetaView; founderPubKey: string; manifestSig: string }) =>
    rpcPost<ModelMetaView>("/models/authorize", m),
  fetchModel: (id: string) => rpcPost<{ ok: boolean }>("/models/fetch", { id }),

  // live, decentralized pricing
  pricing: () => rpcGet<Pricing>("/pricing"),

  // free tier: how many free field questions remain for this address in the current window
  queryQuota: (address: string) => rpcGet<FreeTierQuota>(`/query/quota?address=${encodeURIComponent(address)}`),

  // provider profiles
  providers: () => rpcGet<ProviderView[]>("/providers"),
  myProvider: () => rpcGet<ProviderView | null>("/providers/mine"),

  // current ZTI (overall + per domain)
  zti: (address: string) => rpcGet<{ address: string; zti: number; ztiByDomain: Partial<Record<Domain, number>> }>(`/zti?address=${encodeURIComponent(address)}`),

  // query fusion + ZTI history + analytics
  queryFusion: (id: string) => rpcGet<QueryFusion>(`/query/fusion?id=${encodeURIComponent(id)}`),
  ztiHistory: (address: string, domain?: Domain, limit = 50) =>
    rpcGet<ZtiSnapshot[]>(`/zti/history?address=${encodeURIComponent(address)}${domain ? `&domain=${domain}` : ""}&limit=${limit}`),
  resonatorStats: (id: string, window = "7d") => rpcGet<ResonatorStats>(`/resonator/stats?id=${encodeURIComponent(id)}&window=${window}`),

  // launch-authority model advisory
  recommendations: () => rpcGet<ModelRecommendation[]>("/recommendations"),
  publishRecommendation: (r: { label: string; backendHint: string; domains: Domain[]; notes: string }) =>
    rpcPost<ModelRecommendation>("/recommendations", r),

  // anchors: ownership/listing live, activation future-gated
  anchorClasses: () => rpcGet<AnchorClassInfo[]>("/anchors/classes"),
  // Steward Anchor Event toggle (spec §2.1/§6.2): public read so clients gate the contribute section and
  // show the steward-set USDT receiving addresses (evm = ETH/BSC/Polygon, tron = TRC-20).
  getAnchorEvent: () => rpcGetFrom<{ enabled: boolean; evm: string; tron: string; wcProjectId: string }>(anchorBase(), "/anchors/event"),
  setAnchorEvent: (patch: { enabled?: boolean; evm?: string; tron?: string; wcProjectId?: string }) => rpcPostTo<{ enabled: boolean; evm: string; tron: string; wcProjectId: string }>(anchorBase(), "/anchors/event", { ...patch, ...stewardAuth() }),
  // Anchor contributions: contributor reports a USDT payment (public); steward reviews the queue. Both go to
  // the shared gateway so contributions converge in one place; the steward read carries a signed challenge
  // in the query so the gateway authorizes it without the founder key on the server.
  recordAnchorContribution: (c: { zirAddress: string; network: string; amountUsdt: number; txHash: string; classCode: string; quantity: number }) => rpcPostTo<{ ok: boolean }>(anchorBase(), "/anchors/contribution", c),
  getAnchorContributions: () => {
    const a = stewardAuth();
    const qs = new URLSearchParams();
    if (a.stewardPubKey && a.stewardChallenge && a.stewardSig) { qs.set("stewardPubKey", a.stewardPubKey); qs.set("stewardChallenge", a.stewardChallenge); qs.set("stewardSig", a.stewardSig); }
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return rpcGetFrom<{ zirAddress: string; network: string; amountUsdt: number; txHash: string; classCode: string; quantity: number; ts: number; status: "pending" | "confirmed" | "failed"; confirmations: number; sender: string; reason?: string }[]>(anchorBase(), `/anchors/contributions${suffix}`);
  },
  anchorSeats: () => rpcGet<AnchorSeatSummary>("/anchors/seats"),
  anchorListings: () => rpcGet<Anchor[]>("/anchors/listings"),
  myAnchors: (owner: string) => rpcGet<Anchor[]>(`/anchors/mine?owner=${encodeURIComponent(owner)}`),
  submitAnchorClaim: (tx: SignedTx) => rpcPost<{ accepted: boolean; reason?: string }>("/anchors/claim", { tx }),
  submitAnchorTransfer: (tx: SignedTx) => rpcPost<{ accepted: boolean; reason?: string }>("/anchors/transfer", { tx }),
  submitAnchorList: (tx: SignedTx) => rpcPost<{ accepted: boolean; reason?: string }>("/anchors/list", { tx }),
  submitAnchorDelist: (tx: SignedTx) => rpcPost<{ accepted: boolean; reason?: string }>("/anchors/delist", { tx }),
  submitAnchorActivate: (tx: SignedTx) => rpcPost<{ accepted: boolean; reason?: string }>("/anchors/activate", { tx }),
  // owner-authorized position transfer: a SINGLE or BATCH of positions moved in one signed tx
  submitAnchorPositionTransfer: (tx: SignedTx) => rpcPost<{ accepted: boolean; reason?: string }>("/anchors/position-transfer", { tx }),
  // owner opens/closes one or more positions for user contributions
  submitAnchorSetContributions: (tx: SignedTx) => rpcPost<{ accepted: boolean; reason?: string }>("/anchors/set-contributions", { tx }),

  // steward (founder) transfers positions it owns out: single (seatId) or batch (seatIds) in one op
  anchorTransferPositions: (seatIds: string[], to: string) => rpcPost<AnchorPositionTransferResult>("/anchors/transfer-positions", { seatIds, to }),

  // steward: (re)seed the network + 512 anchor Resonators and re-key any whose position changed owner
  seedStewardResonators: () => rpcPost<{ networkResonators: number; anchorResonators: number; error?: string }>("/founder/seed-resonators", {}),
  // steward: settle a funded query's multi-LLM coordination payout across the models that answered
  settleQueryCoordination: (queryId: string, budgetZir: number) =>
    rpcPost<{ ok: boolean; reason?: string; payouts?: { address: string; amountUZIR: number }[]; networkUZIR?: number; resonatorPoolUZIR?: number; burnUZIR?: number; confidenceScore?: number }>("/query/settle", { queryId, budgetUZIR: Math.round(budgetZir * 1_000_000) }),

  // The node's own mining-wallet key (loopback-only on the node). The local Console adopts it as the
  // active wallet so mining earnings land in the wallet the user sees. The key is held in memory for the
  // session only, never persisted in the browser.
  walletExport: () => rpcGet<{ address: string; privateKey: string; publicKey: string; balanceUZIR: number }>("/wallet/export"),
  // Import a wallet as the node's identity (loopback-only). The node mines into it after a restart.
  walletImport: (privateKey: string) => rpcPost<{ ok: boolean; address?: string; reason?: string }>("/wallet/import", { privateKey }),

  net: () => rpcGet<NetInfo>("/net"),
  addPeer: (multiaddr: string) => rpcPost<{ ok: boolean; reason?: string }>("/peers/add", { multiaddr }),

  // launch-authority assigned heavy-storage peers
  storagePeers: () => rpcGet<{ peers: string[]; isFounder: boolean }>("/founder/storage-peers"),
  setStoragePeers: (peers: string[]) => rpcPost<{ ok: boolean; reason?: string; peers?: string[] }>("/founder/storage-peers", { peers }),
  founderBackups: () => rpcGet<{ addresses: string[]; isFounder: boolean }>("/founder/backups"),
  setFounderBackups: (addresses: string[]) => rpcPost<{ ok: boolean; reason?: string; addresses?: string[] }>("/founder/backups", { addresses }),
  bootstrapCandidates: (opts: { publicHost?: string; publicHostType?: string; publicP2pPort?: number; checkReachability?: boolean; scanLocalMesh?: boolean; inferPublicHost?: boolean; meshRpcPorts?: number[]; meshP2pPorts?: number[] }) =>
    rpcGet<{ isFounder: boolean; candidates: BootstrapSeedCandidate[]; publicHost?: string; publicHostType?: string; publicHostSource?: "operator" | "detected" | "none"; publicHostError?: string }>(`/founder/bootstrap-candidates?publicHost=${encodeURIComponent(opts.publicHost ?? "")}&publicHostType=${encodeURIComponent(opts.publicHostType ?? "ip4")}&publicP2pPort=${encodeURIComponent(String(opts.publicP2pPort ?? 9645))}&checkReachability=${opts.checkReachability ? "1" : "0"}&scanLocalMesh=${opts.scanLocalMesh ? "1" : "0"}&inferPublicHost=${opts.inferPublicHost ? "1" : "0"}&meshRpcPorts=${encodeURIComponent((opts.meshRpcPorts ?? [8645, 8745, 8845, 8945]).join(","))}&meshP2pPorts=${encodeURIComponent((opts.meshP2pPorts ?? [9645, 9745, 9845, 9945]).join(","))}`),

  // wipe the local ledger + history and restart fresh from genesis (desktop respawns the node)
  reset: () => rpcPost<{ ok: boolean }>("/admin/reset", {}),

  supply: () => rpcGet<SupplyInfo>("/supply"),
};
