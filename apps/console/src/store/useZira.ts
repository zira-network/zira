// apps/console/src/store/useZira.ts
// Zustand store wrapping the client, the identity, and a light polling loop. It also tracks the
// Tier 1/Tier 2 node status (hardware, provider config + live provider status), per-domain ZTI,
// and a local notification feed derived by diffing the polled state.
import { create } from "zustand";
import type { ZiraClient, NetworkStats, Lock, SignedTx, NetworkId, NetworkPhase, Domain, HardwareProfile, NodeConfig, ProviderConfig } from "@zira/protocol";
import { DEFAULT_NODE_CONFIG, DEFAULT_PROVIDER_CONFIG, MAINNET_ANCHOR_STEWARD, MAINNET_NETWORK_RESONATOR_OWNER } from "@zira/protocol";
import { createClient, getClientMode, isLocalNode, type ClientMode } from "../client/createClient";
import { NodeApi, type StatusInfo, type ProviderStatus, type MiningStatus, type MiningPatch, type LocalLaunchMinerSummary } from "../lib/nodeApi";
import { Wallet } from "../lib/keys";
import { hasNodeFeature } from "../lib/version-compat";
import { probeStats, qualityFor, fetchNetworkView, type ConnectionQuality } from "../lib/connection";

export type NotificationKind =
  | "payment_received" | "task_assigned" | "task_delivered" | "task_completed"
  | "task_expired" | "task_disputed" | "provider_online" | "provider_offline"
  | "zti_milestone" | "lock_contributed";

// `href` is an in-app route (e.g. "/wallet", "/resonators/:id") the notification points at. When present
// the NotificationCenter navigates there on click; when absent the notification is non-navigating and its
// body is shown inline instead, so a click always lands somewhere or expands to its own detail.
export interface AppNotification { id: string; kind: NotificationKind; title: string; body?: string; ts: number; read: boolean; href?: string }

// Well-known mainnet steward wallets. The 30% anchor-reserve wallet owns all 512 anchor positions at
// genesis; the founder wallet owns the seeded network Resonators. Detecting the active wallet against
// these lets the Console surface the steward controls even when the running node does not hold the
// steward key (the node may run a different identity), in which case actions are shown read-only with
// an inline note. The detection is wallet-address-only; it does not grant any server permission.
export type StewardKind = "none" | "anchor-reserve" | "founder";
const STEWARD_WALLETS: Record<string, Exclude<StewardKind, "none">> = {
  [MAINNET_ANCHOR_STEWARD]: "anchor-reserve",
  [MAINNET_NETWORK_RESONATOR_OWNER]: "founder",
};
export function detectStewardKind(address: string | null | undefined): StewardKind {
  if (!address) return "none";
  return STEWARD_WALLETS[address] ?? "none";
}

const NOTIF_KEY = "zira.notifications.v1";
const NOTIF_CAP = 200;

function loadNotifications(): AppNotification[] {
  try {
    const raw = JSON.parse(localStorage.getItem(NOTIF_KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    // Drop malformed or legacy-schema entries (no id or no title). Otherwise the unread badge could count
    // a notification that renders blank, so the bell shows "9+" while the open panel looks empty.
    return raw.filter((n): n is AppNotification => !!n && typeof n.id === "string" && typeof n.title === "string" && n.title.trim().length > 0);
  } catch { return []; }
}
function saveNotifications(n: AppNotification[]): void {
  try { localStorage.setItem(NOTIF_KEY, JSON.stringify(n.slice(0, NOTIF_CAP))); } catch { /* ignore */ }
}

interface ZiraState {
  client: ZiraClient | null;
  mode: "node" | null;
  base: string;

  address: string | null;
  hasWallet: boolean;
  unlocked: boolean;
  balanceUZIR: number;
  // True when we are on a LOCAL node whose applied state trails the network: the network-consensus gateway
  // has emitted more (its epoch is ahead) and reports a settled balance the local node has not caught up to.
  // When set, balanceUZIR/history are shown from the authoritative network view and the UI shows a subtle
  // "your node is catching up" note, so a lagging home node never reads as lost earnings. Display-only.
  nodeBehind: boolean;
  // Node-custody wallet: on a local node (desktop app, or a browser pointed at a node on this machine)
  // the active wallet IS the node's own identity, i.e. the wallet it mines into. The key stays on the
  // node; the Console shows its address/balance and spends via the loopback-gated /wallet/send RPC. On
  // web/mobile against a remote gateway this is false and the self-custodial browser wallet is used.
  nodeWallet: boolean;

  stats: NetworkStats | null;
  locks: Lock[];
  events: SignedTx[];
  // Steward Anchor Event toggle (spec §2.1): when disabled, the anchor contribute section is hidden
  // everywhere. evm/tron are the steward-set USDT receiving addresses shown at contribution time.
  anchorEvent: { enabled: boolean; evm: string; tron: string; wcProjectId: string };

  network: NetworkId;
  phase: NetworkPhase;
  // API version negotiation: the node's reported build version (from /rpc/stats), or null when the node
  // is older and does not report one yet. Version-sensitive features gate on nodeAtLeast() and degrade
  // gracefully when this is null/older rather than crashing or looping failed fetches.
  nodeVersion: string | null;
  // Connection quality: the last measured round-trip latency to /rpc/stats and a coarse bucket for the
  // indicator. latencyMs is null when the node is unreachable (quality === "offline").
  latencyMs: number | null;
  connQuality: ConnectionQuality;
  isFounder: boolean;    // true when the wallet/node belongs to the active founder set
  // true when the loaded/active wallet IS a well-known steward wallet (anchor-reserve or founder),
  // regardless of whether the running node currently holds that steward key.
  isStewardWallet: boolean;
  stewardKind: StewardKind;
  // true when steward ACTIONS are gated server-side: the active wallet is a steward wallet but the node
  // is not running with that steward key, so signed steward routes would 403. The panel stays visible
  // (read-only) with an inline note when this is true.
  stewardActionsGated: boolean;
  providerOn: boolean;

  // Tier 1 / Tier 2 node status (node mode only)
  hardware: HardwareProfile | null;
  nodeConfig: NodeConfig;
  providerConfig: ProviderConfig;
  providerStatus: ProviderStatus;
  mining: MiningStatus | null;
  localLaunchMiners: LocalLaunchMinerSummary[];
  ztiByDomain: Partial<Record<Domain, number>>;
  zti: number;
  // The node's OWN mining wallet (its identity), the address that actually earns from mining/serving on
  // this machine. Separate from the user's spendable Console `address`. The Mine tab shows these so a
  // miner sees real earnings even when their personal wallet is a different (empty) address.
  minerAddress: string | null;
  minerBalanceUZIR: number;

  // local notifications feed
  notifications: AppNotification[];

  ready: boolean;
  polling: boolean;

  init: () => Promise<void>;
  reconnect: () => Promise<void>;
  refreshIdentity: () => Promise<void>;
  refresh: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  // One timed probe of /rpc/stats: updates latencyMs, connQuality, and nodeVersion. Called on the poll
  // loop and on visibility return.
  probeConnection: () => Promise<void>;
  // API version negotiation gate. Returns true when the connected node's version is >= semver. Returns
  // false for an unknown/older node so version-sensitive features stay hidden/disabled instead of failing.
  nodeAtLeast: (semver: string) => boolean;
  setProviderConfig: (cfg: Partial<ProviderConfig>) => void;
  toggleProvider: (enabled: boolean) => Promise<void>;
  setMining: (patch: MiningPatch) => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
  setUnlocked: (v: boolean) => void;
  setProviderOn: (v: boolean) => void;
  pushNotification: (n: Omit<AppNotification, "id" | "ts" | "read">) => void;
  markNotificationRead: (id: string) => void;
  markAllNotificationsRead: () => void;
  clearNotifications: () => void;
}

let pollTimer: ReturnType<typeof setInterval> | null = null;
let visibilityHooked = false;
const ZTI_MILESTONES = [0.5, 0.7, 0.9];

// Throttle + cache for the local-node balance reconciliation (refresh()). The poll runs every 6s but we
// only cross-check the network-consensus gateway every NET_VIEW_TTL_MS, reusing the last view in between,
// so a fleet of desktop nodes does not hammer the public gateway. The cache is keyed by address; a wallet
// switch invalidates it.
const NET_VIEW_TTL_MS = 20_000;
let netViewAt = 0;
let netViewAddr = "";
let netView: { balanceUZIR: number; emittedUZIR: number } | null = null;

export const useZira = create<ZiraState>((set, get) => ({
  client: null,
  mode: null,
  base: "",
  address: null,
  hasWallet: false,
  nodeWallet: false,
  unlocked: false,
  balanceUZIR: 0,
  nodeBehind: false,
  minerAddress: null,
  minerBalanceUZIR: 0,
  stats: null,
  locks: [],
  events: [],
  anchorEvent: { enabled: false, evm: "", tron: "", wcProjectId: "" },
  network: "mainnet",
  phase: "live",
  nodeVersion: null,
  latencyMs: null,
  connQuality: "offline",
  isFounder: false,
  isStewardWallet: false,
  stewardKind: "none",
  stewardActionsGated: false,
  providerOn: false,
  hardware: null,
  nodeConfig: { ...DEFAULT_NODE_CONFIG },
  providerConfig: { ...DEFAULT_PROVIDER_CONFIG },
  providerStatus: { active: false, endpoint: DEFAULT_PROVIDER_CONFIG.endpoint, reachable: false, queriesAnswered: 0, earnedTodayUZIR: 0 },
  mining: null,
  localLaunchMiners: [],
  ztiByDomain: {},
  zti: 0,
  notifications: loadNotifications(),
  ready: false,
  polling: false,

  init: async () => {
    // Local node (desktop app or a browser pointed at a node on this machine): the wallet IS the node's
    // own mining identity. Adopt its address from the loopback-gated /wallet RPC so mining earnings show
    // in the wallet, with the key never leaving the node. Falls back to the self-custodial browser wallet
    // if the node is unreachable or this is a remote gateway (web/mobile).
    if (isLocalNode()) {
      const info = await createClient();
      set({ client: info.client, mode: info.mode, base: info.base });
      try {
        const w = await NodeApi.walletExport();
        if (w?.address && w.privateKey) {
          Wallet.adoptInMemory(w.privateKey); // in memory only, never persisted in the browser
          set({ address: w.address, hasWallet: true, unlocked: true, nodeWallet: true, balanceUZIR: w.balanceUZIR ?? 0 });
          await get().refresh();
          await get().refreshStatus();
          await get().probeConnection();
          set({ ready: true });
          get().startPolling();
          return;
        }
      } catch { /* node not reachable yet; fall through to the browser wallet path */ }
    }
    const hasWallet = await Wallet.exists();
    const address = await Wallet.address();
    const info = await createClient(address ?? undefined);
    set({ client: info.client, mode: info.mode, base: info.base, hasWallet, address, unlocked: Wallet.isUnlocked(), nodeWallet: false });
    await get().refresh();
    await get().refreshStatus();
    await get().probeConnection();
    set({ ready: true });
    get().startPolling();
  },

  reconnect: async () => {
    const address = get().address ?? (await Wallet.address());
    const info = await createClient(address ?? undefined);
    set({ client: info.client, mode: info.mode, base: info.base });
    await get().refresh();
    await get().refreshStatus();
  },

  refreshIdentity: async () => {
    if (isLocalNode()) {
      try {
        const w = await NodeApi.walletExport();
        if (w?.address && w.privateKey) { Wallet.adoptInMemory(w.privateKey); set({ address: w.address, hasWallet: true, unlocked: true, nodeWallet: true, balanceUZIR: w.balanceUZIR ?? 0 }); await get().refresh(); return; }
      } catch { /* fall through to browser wallet */ }
    }
    const hasWallet = await Wallet.exists();
    const address = await Wallet.address();
    set({ hasWallet, address, unlocked: Wallet.isUnlocked(), nodeWallet: false });
    await get().refresh();
  },

  refresh: async () => {
    const { client, address, balanceUZIR: prevBalance } = get();
    if (!client) return;
    try {
      const [stats, locks, events] = await Promise.all([
        client.getStats(),
        client.getRecentLocks(20),
        client.getRecentEvents(40),
      ]);
      const founderAddress = (stats as NetworkStats & { founderAddress?: string }).founderAddress;
      const founderAddresses = (stats as NetworkStats & { founderAddresses?: string[] }).founderAddresses ?? (founderAddress ? [founderAddress] : []);
      const isFounder = Boolean(address && founderAddresses.includes(address));
      const stewardKind = detectStewardKind(address);
      const isStewardWallet = stewardKind !== "none";
      const patch: Partial<ZiraState> = {
        stats, locks, events, network: stats.network, phase: stats.phase,
        isFounder, stewardKind, isStewardWallet,
        // Actions are gated when the wallet is a steward wallet but the node does not treat it as an
        // active founder (refreshStatus refines this with the node's canSteward signal).
        stewardActionsGated: isStewardWallet && !isFounder,
      };
      if (address) {
        const local = await client.getBalanceUZIR(address);
        let next = local;
        let nodeBehind = false;
        // Authoritative reconciliation for LOCAL nodes: a churny home miner keeps finalizing but can miss a
        // gossiped payout tx, so its own balanceOf(self) trails the mesh and the wallet looked empty even
        // though every master credited it. Cross-check the network-consensus gateway (best-effort, read-only)
        // and, when its epoch is genuinely ahead (strictly higher emittedUZIR, the monotonic pure-epoch
        // counter), show its settled balance. On a tie the LOCAL value wins, so a just-sent local debit the
        // gateway has not gossiped yet is never masked. Never blocks the poll: on any gateway error we keep
        // the local value. The local node keeps self-healing in the background (divergence/catch-up watchdogs).
        if (isLocalNode()) {
          const now = Date.now();
          if (netViewAddr !== address) { netView = null; netViewAddr = address; netViewAt = 0; }
          if (now - netViewAt > NET_VIEW_TTL_MS) {
            const fresh = await fetchNetworkView(address).catch(() => null);
            if (fresh?.ok) { netView = { balanceUZIR: fresh.balanceUZIR, emittedUZIR: fresh.emittedUZIR }; netViewAt = now; }
          }
          const localEmitted = Number((stats as NetworkStats).emittedUZIR ?? 0);
          // Only adopt the gateway's figure when it is BOTH globally ahead (higher emittedUZIR) AND reports a
          // strictly HIGHER balance for THIS address. Global emission alone is not per-address freshness: a
          // read gateway is almost always globally ahead yet may not have applied this address's latest payout
          // (or may not know the address at all, returning 0). Requiring a higher balance means we only ever
          // top a lagging local node UP toward the network view, never flip it DOWN to a stale/zero value, and
          // a just-sent local debit the gateway has not gossiped yet still wins (local is the lower figure).
          if (netView && netView.emittedUZIR > localEmitted && netView.balanceUZIR > next) {
            next = netView.balanceUZIR;
            nodeBehind = true;
          }
        }
        patch.balanceUZIR = next;
        patch.nodeBehind = nodeBehind;
        // payment notification on a credit (skip the very first poll where prevBalance is 0/unset)
        if (prevBalance > 0 && next > prevBalance) {
          get().pushNotification({ kind: "payment_received", title: "Payment received", body: `+${((next - prevBalance) / 1_000_000).toFixed(2)} ZIR`, href: "/wallet" });
        }
      }
      // Anchor event status gates the contribute section on EVERY client (web/auto users on the gateway
      // included), so it is fetched here in refresh() rather than the node-only refreshStatus.
      try { patch.anchorEvent = await NodeApi.getAnchorEvent(); } catch { /* anchor event status optional */ }
      set(patch);
    } catch {
      // keep last good values
    }
  },

  refreshStatus: async () => {
    if (getClientMode() !== "node") return;
    try {
      const [st, localLaunchMiners]: [StatusInfo, LocalLaunchMinerSummary[]] = await Promise.all([
        NodeApi.status(),
        NodeApi.localLaunchMiners().catch(() => [] as LocalLaunchMinerSummary[]),
      ]);
      const prev = get();
      // provider reachability transitions
      if (prev.providerConfig.enabled && st.providerStatus.active) {
        if (st.providerStatus.reachable && !prev.providerStatus.reachable) get().pushNotification({ kind: "provider_online", title: "Provider online", body: st.providerStatus.endpoint, href: "/mine" });
        if (!st.providerStatus.reachable && prev.providerStatus.reachable) get().pushNotification({ kind: "provider_offline", title: "Provider offline", body: st.providerStatus.endpoint, href: "/mine" });
      }
      const founders = st.founderAddresses ?? [];
      const stewardKind = detectStewardKind(prev.address);
      const isStewardWallet = stewardKind !== "none";
      // The node treats THIS connection as a founder/steward operator only when st.isFounder is true
      // (the node identity is in the active founder set) or the active wallet is in the founder list.
      const nodeTreatsAsFounder = st.isFounder || Boolean(prev.address && founders.includes(prev.address));
      const patch: Partial<ZiraState> = {
        hardware: st.hardware, nodeConfig: st.nodeConfig, providerConfig: st.providerConfig,
        providerStatus: st.providerStatus, providerOn: st.providerStatus.active,
        isFounder: nodeTreatsAsFounder,
        stewardKind, isStewardWallet,
        // Steward controls show whenever the active wallet is a founder OR a well-known steward wallet.
        // Actions require the node to run with the steward key; if it does not (st.isFounder false),
        // the panel stays visible read-only and shows the inline "run your node with the steward key" note.
        stewardActionsGated: isStewardWallet && !nodeTreatsAsFounder,
        mining: st.mining, localLaunchMiners,
        // The node's own mining wallet + its live balance (the address that earns on this machine).
        minerAddress: st.address ?? null,
        minerBalanceUZIR: typeof st.balanceUZIR === "number" ? st.balanceUZIR : prev.minerBalanceUZIR,
      };
      // Node-custody wallet: on a local node, keep the active wallet pinned to the node's mining identity
      // (covers the case where the node was not reachable at init and only came up now). Adopt the key in
      // memory once so signed actions work. IMPORTANT: only flip to nodeWallet once the key is actually
      // adopted (unlocked), otherwise a transient /wallet/export failure would leave a node-wallet card
      // with no unlock path and a send that can never sign. If the adopt fails we leave the wallet state
      // untouched and simply retry on the next poll.
      if (isLocalNode() && st.address && !Wallet.isUnlocked()) {
        try { const w = await NodeApi.walletExport(); if (w?.privateKey) Wallet.adoptInMemory(w.privateKey); } catch { /* retry next poll */ }
      }
      if (isLocalNode() && st.address && Wallet.isUnlocked()) {
        patch.address = st.address;
        patch.hasWallet = true;
        patch.unlocked = true;
        patch.nodeWallet = true;
        // Don't let a poll drop a positive balance to exactly 0: a local node still catching up reports
        // balanceOf(self)=0 until it applies the epoch that paid it, then jumps to the real value. Treat
        // 0-after-positive as a sync artifact and keep the last good value; the settled /balance read in
        // refresh() remains authoritative for real decreases. Also skip entirely when refresh() has flagged
        // the node as behind the mesh: there the authoritative network-consensus balance already won, and
        // this local self-read would clobber it back to the stale value.
        if (!prev.nodeBehind && typeof st.balanceUZIR === "number" && !(st.balanceUZIR === 0 && (prev.balanceUZIR ?? 0) > 0)) patch.balanceUZIR = st.balanceUZIR;
      }
      if (st.address) {
        try {
          const z = await NodeApi.zti(st.address);
          patch.zti = z.zti;
          patch.ztiByDomain = z.ztiByDomain;
          for (const m of ZTI_MILESTONES) {
            if ((prev.zti < m && z.zti >= m)) get().pushNotification({ kind: "zti_milestone", title: `ZTI milestone ${m.toFixed(2)}`, body: "Your overall trust crossed a threshold.", href: "/resonators" });
          }
        } catch { /* zti optional */ }
      }
      set(patch);
    } catch { /* node status optional (the node may be unreachable) */ }
  },

  probeConnection: async () => {
    const probe = await probeStats();
    if (!probe.ok) { set({ latencyMs: null, connQuality: "offline" }); return; }
    const patch: Partial<ZiraState> = { latencyMs: probe.latencyMs, connQuality: qualityFor(probe.latencyMs) };
    // The version is sticky: once a node reports it, keep the last known value even if a later probe omits
    // it, so a transient empty body never flips a known node back to "unknown".
    if (probe.version) patch.nodeVersion = probe.version;
    set(patch);
  },

  nodeAtLeast: (semver) => hasNodeFeature(get().nodeVersion, semver),

  setProviderConfig: (cfg) => set((s) => ({ providerConfig: { ...s.providerConfig, ...cfg } })),

  toggleProvider: async (enabled) => {
    const cfg = get().providerConfig;
    const st = await NodeApi.setStatus({ providerConfig: { ...cfg, enabled } });
    set({ providerConfig: st.providerConfig, providerStatus: st.providerStatus, providerOn: st.providerStatus.active });
  },

  setMining: async (patch) => {
    const st = await NodeApi.setMining(patch);
    set({ mining: st.mining });
    if (patch.enabled === true) get().pushNotification({ kind: "provider_online", title: "Mining on", body: "Lending compute to run the field's model.", href: "/mine" });
  },

  startPolling: () => {
    if (pollTimer) return;
    // Poll only when needed: skip ticks while the tab is hidden so a backgrounded Console stops
    // hitting the node, and refresh once immediately when it becomes visible again.
    pollTimer = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void get().refresh();
      void get().refreshStatus();
      void get().probeConnection();
    }, 6000);
    if (typeof document !== "undefined" && !visibilityHooked) {
      visibilityHooked = true;
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden && pollTimer) { void get().refresh(); void get().refreshStatus(); void get().probeConnection(); }
      });
    }
    set({ polling: true });
  },
  stopPolling: () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    set({ polling: false });
  },

  setUnlocked: (v) => set({ unlocked: v }),
  setProviderOn: (v) => set({ providerOn: v }),

  pushNotification: (n) => {
    const note: AppNotification = { ...n, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ts: Date.now(), read: false };
    set((s) => {
      const next = [note, ...s.notifications].slice(0, NOTIF_CAP);
      saveNotifications(next);
      return { notifications: next };
    });
  },
  markNotificationRead: (id) => set((s) => {
    const next = s.notifications.map((x) => (x.id === id ? { ...x, read: true } : x));
    saveNotifications(next);
    return { notifications: next };
  }),
  markAllNotificationsRead: () => set((s) => {
    const next = s.notifications.map((x) => ({ ...x, read: true }));
    saveNotifications(next);
    return { notifications: next };
  }),
  clearNotifications: () => { saveNotifications([]); set({ notifications: [] }); },
}));

export function currentClientMode(): ClientMode {
  return getClientMode();
}
