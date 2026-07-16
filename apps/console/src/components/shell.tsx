// apps/console/src/components/shell.tsx
// The app shell: left Sidebar, TopBar with live chips, and the content area.
// The sidebar collapses to a thin icon rail on desktop (state persisted in useUi), and appears as a
// slide-over drawer on mobile. The main content reflows automatically because the rail/drawer is a
// flex sibling: a narrower aside leaves more room for the content column.
import { type ReactNode, useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import {
  MessageSquare, Wallet as WalletIcon, Bot, CircuitBoard, Network, Hexagon,
  BookOpen, Settings as SettingsIcon, Crown, Radio, Wifi, WifiOff, Zap,
  Moon, Sun, Plus, PanelLeftClose, PanelLeftOpen, Menu, X,
} from "lucide-react";
import { ZiraMark } from "./brand";
import { Badge, Meter, useToast } from "./ui";
import { NodeApi, type EventsStatus } from "../lib/nodeApi";
import { NotificationCenter } from "./NotificationCenter";
import { cn } from "../lib/cn";
import { useZira } from "../store/useZira";
import { useUi } from "../store/useUi";
import type { NetworkStats } from "@zira/protocol";
import { formatZir } from "../lib/format";
import { phaseLabel, featureEnabled } from "../lib/phase";
import { isDesktop } from "../lib/platform";
import { APP_VERSION } from "../lib/version";
import { formatNodeVersion } from "../lib/version-compat";
import type { ConnectionQuality } from "../lib/connection";

type NavItem = {
  to: string;
  label: string;
  icon: typeof MessageSquare;
  end?: boolean;
  feature?: Parameters<typeof featureEnabled>[1] | null;
  desktopOnly: boolean;
  disabled?: boolean;
};

type NavSection = { heading: string; items: NavItem[] };

// Nav grouped into calm sections for clearer organization. All routes preserved.
const NAV_SECTIONS: NavSection[] = [
  {
    heading: "Use",
    items: [
      { to: "/", label: "Console", icon: MessageSquare, end: true, desktopOnly: false },
      { to: "/resonators", label: "Resonators", icon: Bot, feature: "resonators" as const, desktopOnly: false },
      { to: "/marketplace", label: "Discover", icon: CircuitBoard, feature: "marketplace" as const, desktopOnly: false },
    ],
  },
  {
    heading: "Earn",
    items: [
      { to: "/mine", label: "Mine", icon: Zap, feature: null, desktopOnly: true },
      { to: "/wallet", label: "Wallet", icon: WalletIcon, feature: null, desktopOnly: false },
    ],
  },
  {
    heading: "Network",
    items: [
      { to: "/explorer", label: "Explorer", icon: Network, feature: null, desktopOnly: false },
      { to: "/anchors", label: "Anchors", icon: Hexagon, feature: null, desktopOnly: false },
    ],
  },
  {
    heading: "Account",
    items: [
      { to: "/learn", label: "Learn", icon: BookOpen, feature: null, desktopOnly: false },
      { to: "/settings", label: "Settings", icon: SettingsIcon, feature: null, desktopOnly: false },
    ],
  },
];

function NavRow({ item, soon, collapsed, onNavigate }: { item: NavItem; soon: boolean; collapsed?: boolean; onNavigate?: () => void }) {
  if (item.disabled) {
    return (
      <div aria-disabled="true" title={collapsed ? `${item.label} (coming soon)` : undefined}
        className={cn("flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2 text-sm text-faint opacity-70", collapsed && "justify-center px-0")}>
        <item.icon size={17} />
        {!collapsed && <span className="flex-1">{item.label}</span>}
        {!collapsed && <Badge tone="neutral" className="text-[10px]">coming soon</Badge>}
      </div>
    );
  }
  return (
    <NavLink to={item.to} end={item.end} onClick={onNavigate}
      title={collapsed ? item.label : undefined}
      aria-label={collapsed ? item.label : undefined}
      className={({ isActive }) => cn(
        "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
        collapsed && "justify-center px-0",
        isActive ? "bg-elevated font-medium text-text" : "text-muted hover:text-text hover:bg-elevated/60")}>
      {({ isActive }) => (
        <>
          <item.icon size={17} className={cn("shrink-0 transition-colors", isActive ? "text-[var(--accent)]" : "text-faint group-hover:text-muted")} />
          {!collapsed && <span className="flex-1">{item.label}</span>}
          {!collapsed && soon && <Badge tone="neutral" className="text-[10px]">soon</Badge>}
        </>
      )}
    </NavLink>
  );
}

// The shared navigation body, rendered both in the desktop aside and the mobile drawer.
function NavBody({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const { phase, isFounder, isStewardWallet } = useZira();
  const showSteward = isFounder || isStewardWallet;
  return (
    <nav className={cn("flex flex-1 flex-col gap-5 overflow-y-auto overflow-x-hidden py-2", collapsed ? "px-2" : "px-3")}>
      {NAV_SECTIONS.map((section) => {
        const visible = section.items.filter((item) => !(item.desktopOnly && !isDesktop()));
        if (visible.length === 0) return null;
        const withFounder = section.heading === "Account" && showSteward;
        return (
          <div key={section.heading} className="flex flex-col gap-0.5">
            {collapsed
              ? <div className="mx-auto my-1 h-px w-5 bg-hairline" aria-hidden />
              : <div className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-faint">{section.heading}</div>}
            {visible.map((item) => {
              const soon = !!item.disabled || (item.feature ? !featureEnabled(phase, item.feature) : false);
              return <NavRow key={item.to} item={item} soon={soon} collapsed={collapsed} onNavigate={onNavigate} />;
            })}
            {withFounder && (
              <NavLink to="/founder" onClick={onNavigate} title={collapsed ? "Steward" : undefined} aria-label={collapsed ? "Steward" : undefined}
                className={({ isActive }) => cn(
                  "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                  collapsed && "justify-center px-0",
                  isActive ? "bg-elevated font-medium text-text" : "text-muted hover:text-text hover:bg-elevated/60")}>
                <Crown size={17} className="shrink-0 text-[var(--warn)]" />
                {!collapsed && <span className="flex-1">Steward</span>}
                {!collapsed && <Badge tone="warn" className="text-[10px]">steward</Badge>}
              </NavLink>
            )}
          </div>
        );
      })}
    </nav>
  );
}

// Desktop sidebar: a full 64-wide panel that collapses to a 16-wide icon rail. The toggle lives at the
// top; collapsed state is persisted in useUi and the main content reflows because this is a flex sibling.
function Sidebar() {
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  return (
    <aside
      aria-label="Primary"
      className={cn(
        "hidden shrink-0 flex-col border-r border-hairline bg-surface transition-[width] duration-200 ease-[var(--ease)] md:flex",
        collapsed ? "w-16" : "w-64",
      )}
    >
      <div className={cn("flex items-center py-5", collapsed ? "flex-col gap-3 px-2" : "gap-2.5 px-5")}>
        {!collapsed && (
          <div className="flex flex-1 items-center gap-2.5">
            <ZiraMark size={26} />
            <div>
              <span className="text-base font-semibold tracking-tight text-text">ZIRA</span>
              <div className="text-[10px] uppercase tracking-[0.2em] text-faint">the AI network</div>
            </div>
          </div>
        )}
        {collapsed && <ZiraMark size={24} />}
        <button
          onClick={toggleSidebar}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand navigation" : "Collapse navigation"}
          title={collapsed ? "Expand navigation" : "Collapse navigation"}
          className="rounded-md p-1.5 text-faint transition-colors hover:bg-elevated hover:text-text"
        >
          {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </button>
      </div>
      <NavBody collapsed={collapsed} />
      {!collapsed && <SidebarFooter />}
    </aside>
  );
}

// The sidebar footer. Shows the Console build (APP_VERSION) and, unobtrusively, the connected node's
// reported build version for API version negotiation. The node version reads "unknown" against older
// nodes that do not yet report one on /rpc/stats; that is expected and never an error.
function SidebarFooter() {
  const nodeVersion = useZira((s) => s.nodeVersion);
  return (
    <div className="border-t border-hairline px-5 py-4 text-[11px] leading-relaxed text-faint">
      Run by its users. Your keys, your node, your AI.
      {(() => {
        const nodeVer = formatNodeVersion(nodeVersion);
        // The node reports a bare "2.6.4" while APP_VERSION carries a "v" prefix ("v2.6.4"), so compare with
        // the prefix normalised or an IDENTICAL build reads as a false drift ("ZIRA v2.6.4 · node 2.6.4").
        // Only a genuine, known version difference appends the node build; "unknown" (older nodes that do not
        // report a version yet) is expected and stays hidden rather than shown as a drift.
        const appVer = APP_VERSION.replace(/^v/i, "");
        const mismatch = nodeVer !== "unknown" && nodeVer.replace(/^v/i, "") !== appVer;
        return <div className="mt-1.5 mono opacity-70">ZIRA {APP_VERSION}{mismatch ? ` · node ${nodeVer}` : ""}</div>;
      })()}
    </div>
  );
}

// Mobile drawer: a slide-over of the same navigation, opened by the menu button in the TopBar. Closes
// on backdrop click, on Escape, or after a navigation.
function MobileNav() {
  const open = useUi((s) => s.mobileNavOpen);
  const setOpen = useUi((s) => s.setMobileNavOpen);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex md:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[2px] fade-in-up" onClick={() => setOpen(false)} />
      <aside className="relative flex h-full w-64 max-w-[80vw] flex-col border-r border-hairline bg-surface shadow-[var(--shadow-float)]">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <ZiraMark size={26} />
          <div className="flex-1">
            <span className="text-base font-semibold tracking-tight text-text">ZIRA</span>
            <div className="text-[10px] uppercase tracking-[0.2em] text-faint">the AI network</div>
          </div>
          <button onClick={() => setOpen(false)} aria-label="Close navigation" className="rounded-md p-1.5 text-faint transition-colors hover:bg-elevated hover:text-text"><X size={18} /></button>
        </div>
        <NavBody collapsed={false} onNavigate={() => setOpen(false)} />
        <SidebarFooter />
      </aside>
    </div>
  );
}

// The "+" near ZIR: appears only while the founder has a community airdrop active and the events
// reserve is funded. One click claims free ZIR to your wallet. It is never a purchase. Auto-hides
// when events are off or the reserve runs low (the node reports visible=false).
function EventsPlus() {
  const { address } = useZira();
  const toast = useToast();
  const [status, setStatus] = useState<EventsStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = () => { NodeApi.eventsStatus().then((s) => { if (alive) setStatus(s); }).catch(() => {}); };
    load();
    const iv = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(iv); };
  }, []);
  if (!status?.visible || !address) return null;
  async function claim() {
    if (!address) return;
    setBusy(true);
    try {
      const r = await NodeApi.eventsClaim(address);
      if (r.ok) toast.push(`Claimed ${formatZir(r.amountUZIR ?? 0)} ZIR from the community airdrop.`);
      else toast.push(r.reason ?? "Claim is not available right now.", "warn");
      NodeApi.eventsStatus().then(setStatus).catch(() => {});
    } catch (e) { toast.push(e instanceof Error ? e.message : "claim failed", "danger"); }
    finally { setBusy(false); }
  }
  return (
    <button onClick={claim} disabled={busy}
      title={`Claim ${formatZir(status.claimUZIR)} ZIR from the open community airdrop. Free, never a purchase.`}
      className="inline-flex items-center gap-1 rounded-full border border-[color-mix(in_srgb,var(--accent)_28%,transparent)] bg-[var(--accent-soft)] px-2.5 py-1 text-xs font-semibold text-[var(--accent)] transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_20%,transparent)] disabled:opacity-50">
      <Plus size={12} /> ZIR
    </button>
  );
}

// Connection-quality indicator: a small dot + latency label driven by the timed /rpc/stats probe in the
// store. green < 150ms, amber < 600ms, red otherwise, and "offline" when the node is unreachable.
function ConnectionDot({ quality, latencyMs }: { quality: ConnectionQuality; latencyMs: number | null }) {
  const color = quality === "good" ? "var(--teal)" : quality === "fair" ? "var(--warn)" : quality === "poor" ? "var(--danger)" : "var(--text-faint)";
  const label = quality === "offline" ? "offline" : `${latencyMs} ms`;
  const title = quality === "offline"
    ? "Node unreachable. Retrying on the poll loop."
    : `Round-trip to the node: ${latencyMs} ms (${quality === "good" ? "good" : quality === "fair" ? "fair" : "poor"} connection).`;
  return (
    <span title={title} aria-label={`Connection ${quality}${quality === "offline" ? "" : `, ${latencyMs} milliseconds`}`}
      className="hidden items-center gap-1.5 rounded-full border border-hairline bg-elevated px-2 py-0.5 text-[11px] text-muted sm:inline-flex">
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} aria-hidden />
      <span className="mono">{label}</span>
    </span>
  );
}

type NodeStats = NetworkStats & { peers?: number; finalizedEpoch?: number; currentEpoch?: number };

// The network/gateway connection state. It reads from BOTH the latest stats AND the live connection
// probe (connQuality) so it never gets stuck on "Connecting": once the probe reports the node is
// unreachable, this shows a clear "Unreachable" state with the gateway target, rather than spinning on
// "Connecting" forever. When connected it shows connecting -> syncing -> connected with peers and epoch.
function NetworkBadge({ stats, mode, quality, base }: { stats: NodeStats | null; mode: string | null; quality: ConnectionQuality; base: string }) {
  if (mode !== "node") {
    return <Badge tone="warn"><WifiOff size={12} /> Offline</Badge>;
  }
  // The probe says the gateway is not answering. Show a clear unreachable state, not an endless spinner.
  if (quality === "offline" && !stats) {
    const host = (() => { try { return new URL(base).host; } catch { return base; } })();
    return <Badge tone="danger" className="hidden sm:inline-flex" >
      <WifiOff size={12} /> Can't reach gateway ({host})
    </Badge>;
  }
  // Probe is fine but no stats yet: a genuine, transient connecting state.
  if (!stats) return <Badge tone="neutral"><Radio size={12} /> Connecting</Badge>;
  const peers = stats.peers ?? stats.activeNodes ?? 0;
  const finalized = stats.finalizedEpoch ?? 0;
  const current = stats.currentEpoch ?? finalized;
  // A healthy follower/gateway adopts the finality leader's checkpoints a small window behind the head, so a
  // gap of a few dozen epochs is NORMAL and connected — not "syncing". Only a node genuinely far behind (a
  // fresh join still catching up, hundreds of epochs back) should read as syncing. ~90 epochs ≈ 7.5 min.
  const syncing = current - finalized > 90;
  const degraded = peers < 3;
  // If stats are present but the latest probe says offline, the gateway just dropped: show reconnecting.
  if (quality === "offline") {
    return <Badge tone="warn" className="hidden sm:inline-flex"><Radio size={12} /> Reconnecting</Badge>;
  }
  const tone = syncing || degraded ? "warn" : "teal";
  const label = syncing ? "Syncing" : degraded ? "Degraded" : "Connected";
  return (
    <Badge tone={tone} className="hidden sm:inline-flex">
      {tone === "teal" ? <Wifi size={12} /> : <Radio size={12} />}
      {label}: {peers} peers, epoch {finalized.toLocaleString()}
    </Badge>
  );
}

function TopBar({ title }: { title: string }) {
  const { mode, balanceUZIR, stats, phase, providerOn, address, zti, isStewardWallet, stewardKind, connQuality, latencyMs, base } = useZira();
  const setMobileNavOpen = useUi((s) => s.setMobileNavOpen);
  // Theme is owned by the Appearance store (Settings -> Appearance), which applies data-theme and persists
  // it. The top-bar button is just a quick toggle into that same single source of truth.
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const userZti = zti || stats?.avgZti || 0;
  return (
    <header className="sticky top-0 z-20 flex items-center justify-between gap-3 border-b border-hairline bg-[color-mix(in_srgb,var(--bg-base)_82%,transparent)] px-5 py-3 backdrop-blur-xl">
      <div className="flex min-w-0 items-center gap-2">
        <button onClick={() => setMobileNavOpen(true)} aria-label="Open navigation"
          className="rounded-md p-1.5 text-muted transition-colors hover:bg-elevated hover:text-text md:hidden"><Menu size={18} /></button>
        <h1 className="app-title truncate text-base font-semibold tracking-tight text-text">{title}</h1>
      </div>
      <div className="flex items-center gap-2">
        {isStewardWallet && (
          <NavLink to="/founder" title={stewardKind === "anchor-reserve" ? "Anchor-reserve steward wallet" : "Founder steward wallet"}>
            <Badge tone="warn" className="hidden sm:inline-flex"><Crown size={12} /> Steward</Badge>
          </NavLink>
        )}
        {address && (
          // While the node has not finalized anything yet (fresh start / catching up), a "0 ZIR" badge
          // reads as "my funds are gone". Say what is actually happening instead.
          balanceUZIR === 0 && stats && (stats as { finalizedEpoch?: number }).finalizedEpoch !== undefined && ((stats as { finalizedEpoch?: number }).finalizedEpoch ?? -1) < 0
            ? <Badge tone="warn" className="hidden sm:inline-flex">Syncing…</Badge>
            : <Badge tone="teal" className="mono hidden sm:inline-flex">{formatZir(balanceUZIR)} ZIR</Badge>
        )}
        <EventsPlus />
        <div className="hidden w-20 lg:block"><Meter value={userZti} /></div>
        <ConnectionDot quality={connQuality} latencyMs={latencyMs} />
        <NetworkBadge stats={stats as NodeStats | null} mode={mode} quality={connQuality} base={base} />
        {providerOn && <Badge tone="indigo"><Radio size={12} /> Providing</Badge>}
        <Badge tone="neutral">{phaseLabel(phase)}</Badge>
        <button
          className="rounded-full border border-hairline p-1.5 text-muted transition-colors hover:bg-elevated hover:text-text"
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        >
          {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
        </button>
        <NotificationCenter />
      </div>
    </header>
  );
}

const TITLES: Record<string, string> = {
  "/": "Console", "/wallet": "Wallet", "/resonators": "Resonators", "/marketplace": "Discover",
  "/explorer": "Explorer", "/anchors": "Anchors", "/learn": "Learn", "/settings": "Settings",
  "/founder": "Steward", "/styleguide": "Styleguide",
};

export function AppFrame({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const base = "/" + (loc.pathname.split("/")[1] ?? "");
  const title = TITLES[loc.pathname] ?? TITLES[base] ?? "ZIRA";
  return (
    <div className="flex h-full">
      <Sidebar />
      <MobileNav />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title={title} />
        <main className="page-shell min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
