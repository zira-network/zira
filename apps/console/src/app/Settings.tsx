// apps/console/src/app/Settings.tsx
// Connection and the honesty panel, steward provider mode, Wallet, Network, dev Phase, ZRC-1 and streams.
import { useEffect, useState, type ReactNode } from "react";
import { Radio, Wifi, Cpu, Coins, Copy, Check, ShieldCheck, Info, Network as NetIcon, Keyboard, Activity, Palette, RotateCcw } from "lucide-react";
import { DOMAINS, NETWORKS, type Domain } from "@zira/protocol";
import { Card, Button, Input, Select, Badge, Tabs, Field, Modal, PageHeader, LoadingState, ErrorState, useToast, usePoll } from "../components/ui";
import { cn } from "../lib/cn";
import { useZira } from "../store/useZira";
import { useUi, type Theme, type Density, type FontSize } from "../store/useUi";
import { useUnlock } from "../store/useUnlock";
import { getApiBase, setApiBase, getClientMode, setClientMode, type ClientMode } from "../client/createClient";
import { testEndpoint } from "../provider/inference";
import { ProviderMode, type ProviderStats } from "../provider/ProviderMode";
import { Wallet } from "../lib/keys";
import { formatZir, timeAgo } from "../lib/format";
import { NodeApi, type NetInfo } from "../lib/nodeApi";
import { shortcutDocs } from "../lib/shortcuts";
import { formatNodeVersion } from "../lib/version-compat";
import { desktopResetAndRelaunch, isDesktop } from "../lib/platform";

let providerInstance: ProviderMode | null = null;

// ---- Local helpers (kept in this file per the section boundary; not added to the shared ui.tsx) ----

// A consistent stat tile: a faint uppercase caption over a mono value. Replaces the three near-duplicate
// metric-tile markups that PeersCard / NodeInfoCard / the Provider session card each hand-rolled.
function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "teal" | "text" }) {
  return (
    <div className="rounded-lg border border-hairline bg-base p-2">
      <div className={cn("mono text-lg font-semibold", tone === "teal" ? "text-[var(--teal)]" : "text-text")}>{value}</div>
      <div className="text-[11px] text-faint">{label}</div>
    </div>
  );
}

// A subtle in-card section subhead, used to give the page structured grouping without a shared SectionHeader.
function SubHead({ children }: { children: ReactNode }) {
  return <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-faint">{children}</div>;
}

function isValidUrl(s: string): boolean {
  try { new URL(s); return true; } catch { return false; }
}

function isDnsSeedAddress(addr: string): boolean {
  return /\/dns[46]\//.test(addr) && addr.includes("/tcp/") && addr.includes("/p2p/");
}
function isPrivateOrLanAddress(addr: string): boolean {
  return /\/ip4\/(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|0\.0\.0\.0)/.test(addr)
    || /\/(ip6|dns[46])\/localhost\//.test(addr);
}
function isPublicTcpAddress(addr: string): boolean {
  return addr.includes("/tcp/") && addr.includes("/p2p/") && !addr.includes("/ws") && !isPrivateOrLanAddress(addr);
}

// Reset ZIRA: a clearly-discoverable danger card shown at the bottom of every Settings tab. Wipes the
// node ledger, the wallet, and all local app data; on desktop it also clears the model cache and relaunches.
function ResetZiraCard() {
  const toast = useToast();
  const [wipeOpen, setWipeOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [backedUp, setBackedUp] = useState(false);
  const [wiping, setWiping] = useState(false);
  const canWipe = confirmText.trim().toUpperCase() === "DELETE" && backedUp && !wiping;
  function closeWipe() { setWipeOpen(false); setConfirmText(""); setBackedUp(false); }

  async function startFresh() {
    if (!canWipe) return;
    setWiping(true);
    try { await NodeApi.reset(); } catch { /* node already restarting or unreachable */ }
    try { await Wallet.destroy(); } catch { /* */ }
    try {
      localStorage.clear();
      sessionStorage.clear();
      if ("caches" in window) { const keys = await caches.keys(); await Promise.all(keys.map((k) => caches.delete(k))); }
      const dbs = await (indexedDB as unknown as { databases?: () => Promise<{ name?: string }[]> }).databases?.();
      if (dbs) for (const d of dbs) if (d.name) indexedDB.deleteDatabase(d.name);
    } catch { /* */ }
    const relaunch = desktopResetAndRelaunch();
    if (relaunch) { toast.push("Wiped everything. Restarting ZIRA fresh…"); try { await relaunch; } catch { /* app is exiting */ } return; }
    toast.push("Wiped. Restarting fresh from genesis.");
    setTimeout(() => location.reload(), 2000);
  }

  return (
    <Card className="border-[color-mix(in_srgb,var(--danger)_30%,transparent)]">
      <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold text-[var(--danger)]"><RotateCcw size={15} /> Reset ZIRA</h3>
      <p className="mb-2 text-xs text-muted">One click wipes everything and rebuilds from genesis: your wallet, settings, and chats on this device, and your node's whole ledger{isDesktop() ? ", plus the downloaded model cache. The app restarts itself clean (the model re-downloads on next use)." : " (all past transactions)."} Back up your private key first if you want to keep it.</p>
      <Button variant="danger" onClick={() => setWipeOpen(true)}>Reset ZIRA and start fresh</Button>
      <Modal open={wipeOpen} onClose={closeWipe} title="Reset ZIRA and start fresh">
        <div className="space-y-4">
          <p className="text-sm text-muted">This is irreversible. It destroys your wallet, settings, and chats on this device{isDesktop() ? ", clears the downloaded model," : ","} and resets your node's entire ledger back to genesis.</p>
          <Field label='Type DELETE to confirm'>
            <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="DELETE" />
          </Field>
          <label className="flex items-start gap-2 text-sm text-muted">
            <input type="checkbox" checked={backedUp} onChange={(e) => setBackedUp(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" />
            <span>I have backed up my private key (or I accept losing this wallet).</span>
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={closeWipe}>Cancel</Button>
            <Button variant="danger" onClick={startFresh} disabled={!canWipe}>{wiping ? "Wiping…" : "Reset everything"}</Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

export function SettingsPage() {
  const [tab, setTab] = useState("connection");
  const isFounder = useZira((s) => s.isFounder);
  useEffect(() => {
    if (!isFounder && tab === "provider") setTab("connection");
  }, [isFounder, tab]);
  const tabs = [
    { id: "connection", label: "Connection" },
    { id: "appearance", label: "Appearance" },
    ...(isFounder ? [{ id: "provider", label: "Steward provider" }] : []),
    { id: "wallet", label: "Wallet" },
    { id: "network", label: "Network" },
    { id: "about", label: "About" },
    { id: "economy", label: "ZRC & Streams" },
  ];
  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <PageHeader
        title="Settings"
        description="Control your node, hardware, appearance, and wallet. Plus an honest read on how decentralized this is today."
      />
      <Tabs
        active={tab} onChange={setTab}
        tabs={tabs}
      />
      {tab === "connection" && <Connection />}
      {tab === "appearance" && <Appearance />}
      {tab === "provider" && <Provider />}
      {tab === "wallet" && <WalletTab />}
      {tab === "network" && <NetworkTab />}
      {tab === "about" && <About />}
      {tab === "economy" && <Economy />}
      <ResetZiraCard />
    </div>
  );
}

// A compact segmented control used by the Appearance section. role=radiogroup + aria-checked make it
// accessible; the selected segment carries the primary Button's elevation so it reads as part of the system.
function Segmented({ value, options, onChange }: { value: string; options: { v: string; label: string }[]; onChange: (v: string) => void }) {
  return (
    <div role="radiogroup" className="flex gap-1 rounded-lg border border-hairline bg-base/70 p-0.5">
      {options.map((o) => {
        const on = value === o.v;
        return (
          <button key={o.v} role="radio" aria-checked={on} onClick={() => onChange(o.v)}
            className={cn("flex-1 rounded-lg px-3 py-1.5 text-sm transition-colors", on ? "bg-[var(--accent)] text-[var(--accent-contrast)] shadow-[var(--shadow-1)]" : "text-muted hover:text-text")}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// Appearance (spec §5): the three flexibility axes, applied app-wide via the UI store (theme switches the
// full color set; font size and density rescale the whole interface). Saved on this device.
function Appearance() {
  const { theme, density, fontSize, simpleMode, setTheme, setDensity, setFontSize, setSimpleMode } = useUi();
  // Documented defaults from useUi.ts: dark / standard / medium / simple-on.
  const isDefault = theme === "dark" && density === "standard" && fontSize === "m" && simpleMode;
  function reset() {
    setTheme("dark"); setDensity("standard"); setFontSize("m"); setSimpleMode(true);
  }
  const row = "grid items-center gap-2 sm:grid-cols-[120px_minmax(0,1fr)]";
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><Palette size={16} /> Appearance</h3>
        <Button variant="ghost" onClick={reset} disabled={isDefault} className="text-xs"><RotateCcw size={13} /> Reset to defaults</Button>
      </div>
      <div className="space-y-5">
        <div className="space-y-3">
          <SubHead>Display</SubHead>
          <div className={row}>
            <span className="text-xs font-medium text-muted">Theme</span>
            <Segmented value={theme} onChange={(v) => setTheme(v as Theme)} options={[{ v: "light", label: "Light" }, { v: "dark", label: "Dark" }]} />
          </div>
          <div className={row}>
            <span className="text-xs font-medium text-muted">Font size</span>
            <Segmented value={fontSize} onChange={(v) => setFontSize(v as FontSize)} options={[{ v: "s", label: "Small" }, { v: "m", label: "Medium" }, { v: "l", label: "Large" }]} />
          </div>
        </div>
        <div className="space-y-3">
          <SubHead>Reading</SubHead>
          <div className={row}>
            <span className="text-xs font-medium text-muted">Density</span>
            <Segmented value={density} onChange={(v) => setDensity(v as Density)} options={[{ v: "standard", label: "Standard" }, { v: "compact", label: "Compact" }]} />
          </div>
          <div className={row}>
            <span className="text-xs font-medium text-muted">Language</span>
            <Segmented value={simpleMode ? "simple" : "full"} onChange={(v) => setSimpleMode(v === "simple")} options={[{ v: "simple", label: "Simple" }, { v: "full", label: "Detailed" }]} />
          </div>
        </div>
        <div>
          <SubHead>Preview</SubHead>
          <div className="rounded-lg border border-hairline bg-base p-4">
            <div className="mb-1 flex items-center gap-2">
              <h4 className="text-base font-semibold text-text">Sample heading</h4>
              <Badge tone="teal">live</Badge>
            </div>
            <p className="text-sm text-muted">This text reflects your theme, density, and font size. <span className="mono">1,234.56 ZIR</span></p>
            <div className="mt-3 flex gap-2">
              <Button variant="primary" className="text-xs">Primary</Button>
              <Button variant="secondary" className="text-xs">Secondary</Button>
            </div>
          </div>
        </div>
      </div>
      <p className="mt-3 text-xs text-faint">Applied instantly and saved on this device. Theme switches the full color set; font size and density rescale the whole interface. Simple uses plain, everyday wording; Detailed shows the full technical terms.</p>
    </Card>
  );
}

function PeersCard() {
  const toast = useToast();
  const [net, setNet] = useState<NetInfo | null>(null);
  const [addr, setAddr] = useState("");
  const [busy, setBusy] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // usePoll skips ticks while the tab is hidden and refires on focus, so a backgrounded Console does not
  // keep hammering the node. The catch surfaces a real error instead of silently swallowing it.
  function load() {
    NodeApi.net()
      .then((n) => { setNet(n); setErr(null); })
      .catch((e) => setErr(e instanceof Error ? e.message : "Could not read the peer mesh."))
      .finally(() => setLoaded(true));
  }
  usePoll(load, 5000);
  const publicNodeAddr = net?.addrs.find(isPublicTcpAddress) ?? "";
  const dnsSeedAddr = net?.addrs.find((a) => isDnsSeedAddress(a) && !a.includes("/ws")) ?? "";
  const localNodeAddr = net?.addrs.find((a) => a.includes("/p2p/") && !a.includes("/ws")) ?? "";
  const nodeAddr = publicNodeAddr || localNodeAddr || "";
  const shareAddr = dnsSeedAddr || publicNodeAddr;
  const hiddenLocalAddrs = net?.addrs.filter((a) => a.includes("/p2p/") && isPrivateOrLanAddress(a)).length ?? 0;

  const conns = net?.connections ?? [];
  const inbound = conns.filter((c) => c.direction === "inbound").length;
  const outbound = conns.filter((c) => c.direction === "outbound").length;
  const peerCount = net?.peers ?? 0;
  const reach = publicNodeAddr
    ? { label: "Publicly reachable", tone: "teal" as const }
    : peerCount > 0 ? { label: "Connected via mesh", tone: "teal" as const }
    : { label: "Connecting…", tone: "neutral" as const };
  const shortId = (s: string) => (s.length > 17 ? `${s.slice(0, 9)}…${s.slice(-6)}` : s);
  const copy = (s: string, label: string) => { navigator.clipboard?.writeText(s); toast.push(`${label} copied`); };

  async function add() {
    if (!addr.trim()) return;
    setBusy(true);
    try {
      const r = await NodeApi.addPeer(addr.trim());
      toast.push(r.ok ? "Connected. Your node will now sync with that peer." : "Could not connect: " + (r.reason ?? ""), r.ok ? "teal" : "danger");
      if (r.ok) setAddr("");
    } catch (e) { toast.push(e instanceof Error ? e.message : "failed", "danger"); }
    finally { setBusy(false); }
  }

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><NetIcon size={16} /> Network peers</h3>
        {net && <Badge tone={reach.tone}>{reach.label}</Badge>}
      </div>

      {!loaded ? (
        <LoadingState label="Reading peer mesh..." />
      ) : err && !net ? (
        <ErrorState message={err} onRetry={load} />
      ) : (
      <>
      {err && <div className="mb-3"><ErrorState message={err} onRetry={load} /></div>}
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Connected" value={peerCount} />
        <Stat label="In / Out" value={<>{inbound}<span className="text-faint"> / </span>{outbound}</>} />
        <Stat label="Saved" value={net?.savedPeers.length ?? 0} />
      </div>

      <div className="mt-3">
        <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-faint">Live connections</div>
        {conns.length === 0 ? (
          <p className="rounded-lg border border-hairline bg-base p-3 text-xs text-faint">No live peer connections yet. Automatic discovery is dialing the signed bootstrap registry and DNS seeds; this resolves on its own.</p>
        ) : (
          <div className="max-h-56 space-y-1 overflow-auto pr-1">
            {conns.map((c) => (
              <div key={c.peerId} className="flex items-center justify-between gap-2 rounded-lg border border-hairline bg-base px-2.5 py-1.5">
                <div className="min-w-0">
                  <button onClick={() => copy(c.peerId, "Peer ID")} className="mono block truncate text-xs text-text hover:underline" title={c.peerId}>{shortId(c.peerId)}</button>
                  <div className="mono truncate text-[10px] text-faint" title={c.addr}>{c.addr || "—"}</div>
                </div>
                <Badge tone={c.direction === "inbound" ? "teal" : "neutral"}>{c.direction === "inbound" ? "in" : c.direction === "outbound" ? "out" : c.direction}</Badge>
              </div>
            ))}
          </div>
        )}
      </div>

      {net && (
        <div className="mt-3 space-y-2 rounded-lg border border-hairline bg-base/60 p-3">
          <div>
            <div className="mb-0.5 flex items-center justify-between gap-2 text-[11px] text-faint"><span>This node peer ID</span><button onClick={() => copy(net.peerId, "Peer ID")}><Copy size={12} className="text-muted hover:text-text" /></button></div>
            <div className="mono break-all text-xs text-text">{net.peerId}</div>
          </div>
          {nodeAddr && (
            <div>
              <div className="mb-0.5 flex items-center justify-between gap-2 text-[11px] text-faint"><span>{publicNodeAddr ? "Public node address" : "Local node address"}</span><button onClick={() => copy(nodeAddr, "Node address")}><Copy size={12} className="text-muted hover:text-text" /></button></div>
              <div className="mono break-all text-xs text-text">{nodeAddr}</div>
            </div>
          )}
          {shareAddr && (
            <div>
              <div className="mb-0.5 flex items-center justify-between gap-2 text-[11px] text-faint"><span>{dnsSeedAddr ? "DNS seed address" : "Mapped public seed"}</span><button onClick={() => copy(shareAddr, "Address")}><Copy size={12} className="text-muted hover:text-text" /></button></div>
              <div className="mono break-all text-xs text-text">{shareAddr}</div>
            </div>
          )}
          {!publicNodeAddr && <p className="text-[11px] text-faint">Remote users sync from the signed public bootstrap registry, so a public address is optional.{hiddenLocalAddrs > 0 ? ` ${hiddenLocalAddrs} local/raw-IP address${hiddenLocalAddrs === 1 ? "" : "es"} hidden.` : ""}</p>}
        </div>
      )}
      </>
      )}

      <button onClick={() => setShowAdvanced((v) => !v)} className="mt-3 text-[11px] text-muted hover:text-text">{showAdvanced ? "Hide" : "Show"} advanced connection tools</button>
      {showAdvanced && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-muted">Automatic discovery is on by default. Your node loads the signed bootstrap registry, dials healthy DNS seeds, and caches working peers across restarts. Paste a peer multiaddr only for recovery or private-network testing.</p>
          <div className="flex gap-2">
            <Input placeholder="/dns4/host/tcp/9645/p2p/<peerId>" value={addr} onChange={(e) => setAddr(e.target.value)} className="mono text-xs" />
            <Button variant="primary" onClick={add} disabled={busy || !addr.trim()}>Connect</Button>
          </div>
          {net && net.savedPeers.length > 0 && <div className="text-[11px] text-faint">{net.savedPeers.length} saved bootstrap/discovered peer{net.savedPeers.length === 1 ? "" : "s"} will be retried on restart.</div>}
        </div>
      )}
    </Card>
  );
}

function HardwareSummary() {
  const mining = useZira((s) => s.mining);
  const mode = useZira((s) => s.mode);
  if (mode !== "node") return null;
  const hw: "field" | "own" | "off" = mining?.enabled ? "field" : mining?.ownTaskInference ? "own" : "off";
  const label = hw === "field" ? "Mine for the network" : hw === "own" ? "My tasks only" : "Off";
  const detail = hw === "field"
    ? "Answering other people's questions for the network. Earns ZIR when the work is paid."
    : hw === "own"
      ? "Runs your own Console and Resonator tasks on this machine. It never answers for the network and earns no ZIR."
      : "Not running on this machine. Field mode still works over the network. Local mode is unavailable.";
  return (
    <Card>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2"><Cpu size={16} /> Your hardware</h3>
        <Badge tone={hw === "field" ? "indigo" : hw === "own" ? "teal" : "neutral"}>{label}</Badge>
      </div>
      <p className="text-xs text-muted">{detail}</p>
      <p className="mt-2 text-[11px] text-faint">Mining and using your hardware for your own tasks are separate. Change this on the Mine page; you can run your own tasks without ever mining.</p>
    </Card>
  );
}

// Node build version (for API version negotiation) and live connection quality. The node version reads
// "unknown" against older nodes that do not yet report one on /rpc/stats; the Console treats that as the
// floor and keeps any version-sensitive feature disabled rather than firing requests an old node cannot
// answer.
function NodeInfoCard() {
  const { nodeVersion, connQuality, latencyMs } = useZira();
  const qualityLabel = connQuality === "good" ? "good" : connQuality === "fair" ? "fair" : connQuality === "poor" ? "poor" : "offline";
  const tone = connQuality === "good" ? "teal" : connQuality === "fair" ? "warn" : connQuality === "poor" ? "danger" : "neutral";
  return (
    <Card>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2"><Activity size={16} /> Node and connection</h3>
        <Badge tone={tone}>{connQuality === "offline" ? "offline" : `${latencyMs} ms · ${qualityLabel}`}</Badge>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-lg border border-hairline bg-base p-2"><div className="mono break-all text-sm text-text">{formatNodeVersion(nodeVersion)}</div><div className="text-[11px] text-faint">Node build</div></div>
        <Stat label="Round-trip latency" value={latencyMs == null ? "—" : `${latencyMs} ms`} />
      </div>
      <p className="mt-2 text-[11px] text-faint">The node build is read from the node itself, so the Console can light up newer features only when the node supports them and stay quietly compatible with older nodes. Latency is measured round-trip on each refresh.</p>
    </Card>
  );
}

// A compact reference of the keyboard shortcuts, including the command palette.
function ShortcutsCard() {
  const docs = shortcutDocs();
  return (
    <Card>
      <div className="mb-2 flex items-center gap-2"><Keyboard size={16} /><h3 className="text-sm font-semibold">Keyboard shortcuts</h3></div>
      <p className="mb-3 text-xs text-muted">Move faster with the keyboard. The command palette jumps to any page or runs a key action.</p>
      <div className="divide-y divide-hairline border-t border-hairline">
        {docs.map((d) => (
          <div key={d.label} className="flex items-center justify-between gap-3 py-2 text-xs">
            <span className="text-muted">{d.label}</span>
            <span className="flex shrink-0 gap-1">
              {d.keys.split(" ").map((k) => (
                <kbd key={k} className="mono rounded border border-hairline bg-base px-1.5 py-0.5 text-[11px] text-text">{k}</kbd>
              ))}
            </span>
          </div>
        ))}
      </div>
    </Card>
  );
}

type TestResult = { ok: boolean; status?: number; error?: string; at: number };

function Connection() {
  const { mode, base, reconnect } = useZira();
  const toast = useToast();
  const [apiBase, setBase] = useState(getApiBase());
  const [clientMode, setMode] = useState<ClientMode>(getClientMode());
  const [testing, setTesting] = useState(false);
  // A durable last-test result so the user has a standing signal of reachability, not a vanishing toast.
  const [lastTest, setLastTest] = useState<TestResult | null>(null);

  async function runTest(showToast: boolean) {
    setTesting(true);
    try {
      const res = await fetch(apiBase.replace(/\/$/, "") + "/rpc/stats");
      setLastTest({ ok: res.ok, status: res.status, at: Date.now() });
      if (showToast) toast.push(res.ok ? "Node reachable." : "Reached, but returned " + res.status, res.ok ? "teal" : "warn");
    } catch (e) {
      const error = e instanceof Error ? e.message : "error";
      setLastTest({ ok: false, error, at: Date.now() });
      if (showToast) toast.push("Not reachable: " + error, "danger");
    } finally { setTesting(false); }
  }
  // Auto-run one quiet probe on mount so the user sees current reachability without clicking Test.
  useEffect(() => { void runTest(false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  async function save() {
    setApiBase(apiBase); setClientMode(clientMode);
    await reconnect();
    toast.push("Saved and reconnected.");
  }

  const testBadge = lastTest && (
    lastTest.ok
      ? <Badge tone="teal"><Check size={11} /> Reachable</Badge>
      : lastTest.status != null
        ? <Badge tone="warn">HTTP {lastTest.status}</Badge>
        : <Badge tone="danger">Unreachable</Badge>
  );

  return (
    <div className="space-y-4">
      <Card>
        <h3 className="mb-2 text-sm font-semibold">Your ZIRA Core node</h3>
        <Field label="Node address" hint="Defaults to the same origin, the node that serves this Console.">
          <div className="flex gap-2">
            <Input value={apiBase} onChange={(e) => setBase(e.target.value)} className="mono" placeholder="http://127.0.0.1:8645" />
            <Button variant="secondary" onClick={() => runTest(true)} disabled={testing}><Wifi size={14} /> Test</Button>
          </div>
        </Field>
        {lastTest && (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-faint">
            {testBadge}
            <span>tested {timeAgo(lastTest.at)}{lastTest.error ? ` · ${lastTest.error}` : ""}</span>
          </div>
        )}
        <div className="mt-3 flex items-center gap-2">
          <Select value={clientMode} onChange={(e) => setMode(e.target.value as ClientMode)} className="w-auto">
            <option value="auto">Auto (connect to a node)</option>
            <option value="node">Connect to a node</option>
          </Select>
          <Button variant="primary" onClick={save}>Save</Button>
          <Badge tone={mode === "node" ? "teal" : "warn"}>{mode === "node" ? "On a peer node" : "Connecting"}</Badge>
        </div>
        <div className="mt-1 text-[11px] text-faint mono">{base}</div>
        <p className="mt-2 text-[11px] text-faint">Run your own node for full trustlessness, or connect to a public peer. The node syncs the ledger from the peer to peer network.</p>
      </Card>

      {mode === "node" && <NodeInfoCard />}
      {mode === "node" && <HardwareSummary />}
      {mode === "node" && <PeersCard />}
    </div>
  );
}

// The "About" tab: the keyboard-shortcut reference and the honest decentralization panel. These were
// previously stacked under Connection, overloading that tab; here each tab has one coherent job.
function About() {
  return (
    <div className="space-y-4">
      <ShortcutsCard />
      <Card>
        <div className="mb-3 flex items-center gap-2"><ShieldCheck size={16} /><h3 className="text-sm font-semibold">How decentralized this is, honestly</h3></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-[color-mix(in_srgb,var(--teal)_30%,transparent)] bg-[color-mix(in_srgb,var(--teal)_8%,transparent)] p-3">
            <div className="mb-1.5 flex items-center gap-2"><ShieldCheck size={13} className="text-[var(--teal)]" /><span className="text-xs font-semibold text-[var(--teal)]">Decentralized</span></div>
            <ul className="list-disc space-y-1.5 pl-4 text-xs leading-relaxed text-muted">
              <li>No company and no server in the middle. The ledger lives on peer to peer nodes.</li>
              <li>Your keys and wallet are yours, in this browser. Every transaction is signed by you.</li>
              <li>Every node validates every rule, so no peer can forge a balance or mint over the cap.</li>
              <li>The AI runs on participants' own machines. Answers are signed and checkable.</li>
            </ul>
          </div>
          <div className="rounded-lg border border-[color-mix(in_srgb,var(--warn)_30%,transparent)] bg-[color-mix(in_srgb,var(--warn)_8%,transparent)] p-3">
            <div className="mb-1.5 flex items-center gap-2"><Info size={13} className="text-[var(--warn)]" /><span className="text-xs font-semibold text-[var(--warn)]">The honest caveat</span></div>
            <ul className="list-disc space-y-1.5 pl-4 text-xs leading-relaxed text-muted">
              <li>Early on, finality leans on a small set of trusted bootstrap signers.</li>
              <li>As more operators earn trust (ZTI), checkpoint finality decentralizes to them.</li>
              <li>Run your own node to verify the chain yourself rather than trusting one peer.</li>
            </ul>
          </div>
        </div>
        <p className="mt-2 text-xs text-faint">Consensus is Proof of Resonance: master nodes co-sign state checkpoints, final at 0.67 of master trust. See Learn for the full path to decentralizing the bootstrap.</p>
      </Card>
      <Card>
        <div className="mb-3 flex items-center gap-2"><Info size={16} /><h3 className="text-sm font-semibold">Community &amp; links</h3></div>
        <div className="flex flex-wrap gap-2">
          <a href="https://zira.network" target="_blank" rel="noopener noreferrer" className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs text-muted transition hover:border-[var(--teal)] hover:text-text">Website</a>
          <a href="https://discord.gg/y4Vj3qA7h7" target="_blank" rel="noopener noreferrer" className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs text-muted transition hover:border-[var(--teal)] hover:text-text">Discord</a>
          <a href="https://github.com/zira-network/zira" target="_blank" rel="noopener noreferrer" className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs text-muted transition hover:border-[var(--teal)] hover:text-text">GitHub</a>
          <a href="https://x.com/zira_network" target="_blank" rel="noopener noreferrer" className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs text-muted transition hover:border-[var(--teal)] hover:text-text">X</a>
          <a href="https://t.me/ziranetwork" target="_blank" rel="noopener noreferrer" className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs text-muted transition hover:border-[var(--teal)] hover:text-text">Telegram</a>
        </div>
      </Card>
    </div>
  );
}

function Provider() {
  const { client } = useZira();
  const setProviderOn = useZira((s) => s.setProviderOn);
  const providerStatus = useZira((s) => s.providerStatus);
  const request = useUnlock((s) => s.request);
  const toast = useToast();
  const [endpoint, setEndpoint] = useState(localStorage.getItem("zira.provider.endpoint") || "http://localhost:11434/v1");
  const [model, setModel] = useState(localStorage.getItem("zira.provider.model") || "qwen2.5-coder:14b");
  const [label, setLabel] = useState(localStorage.getItem("zira.provider.label") || "my-provider");
  const [domains, setDomains] = useState<Domain[]>(JSON.parse(localStorage.getItem("zira.provider.domains") || '["general","code"]'));
  const [stats, setStats] = useState<ProviderStats>({ running: false, earnedThisSessionUZIR: 0, queriesAnswered: 0 });
  const [testing, setTesting] = useState(false);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (providerInstance) return providerInstance.onChange(setStats);
  }, []);

  // Inline validation so the steward never advertises a broken endpoint/empty config to the field.
  const endpointValid = endpoint.trim().length > 0 && isValidUrl(endpoint.trim());
  const modelValid = model.trim().length > 0;
  const domainsValid = domains.length > 0;
  const configValid = endpointValid && modelValid && domainsValid;

  function persist() {
    localStorage.setItem("zira.provider.endpoint", endpoint);
    localStorage.setItem("zira.provider.model", model);
    localStorage.setItem("zira.provider.label", label);
    localStorage.setItem("zira.provider.domains", JSON.stringify(domains));
  }

  async function test() {
    setTesting(true);
    const res = await testEndpoint(endpoint, model);
    toast.push(res.ok ? "Model responded: " + res.message : "Failed: " + res.message, res.ok ? "teal" : "danger");
    setTesting(false);
    return res.ok;
  }

  async function toggle() {
    if (!client) return;
    if (providerInstance?.isRunning()) {
      providerInstance.stop();
      setProviderOn(false);
      toast.push("Provider mode off");
      return;
    }
    if (!configValid) { toast.push("Fix the endpoint, model, and domains before serving.", "warn"); return; }
    setStarting(true);
    try {
      // Verify the endpoint can actually answer before advertising a label/domains for it.
      const reachable = await test();
      if (!reachable) { toast.push("Endpoint did not respond. Not starting.", "danger"); return; }
      const ok = await request();
      if (!ok) { toast.push("Unlock your wallet to serve as a provider.", "warn"); return; }
      persist();
      providerInstance = new ProviderMode(client, { endpoint, model, apiKey: undefined, domains, label });
      providerInstance.onChange(setStats);
      await providerInstance.start();
      setProviderOn(true);
      toast.push("Provider mode on. You're answering for the network now.");
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "could not start", "danger");
    } finally {
      setStarting(false);
    }
  }

  function toggleDomain(d: Domain) {
    setDomains((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]);
  }

  return (
    <div className="space-y-4">
      <Card>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold flex items-center gap-2"><Cpu size={16} /> Steward provider mode</h3>
          <Badge tone={stats.running ? "indigo" : "neutral"}>{stats.running ? "earning" : "off"}</Badge>
        </div>
        <p className="mb-3 text-xs text-muted">Steward-only. Use this when the launch node should coordinate with a hosted model. Regular miners only need the Mine switch.</p>
        <div className="space-y-3">
          <Field label="Endpoint" hint={endpoint.trim() && !endpointValid ? "Enter a full URL, e.g. http://localhost:11434/v1" : "OpenAI-compatible chat endpoint."}>
            <div className="flex gap-2">
              <Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} className="mono" placeholder="http://localhost:11434/v1" />
              <Button variant="secondary" onClick={test} disabled={testing || !endpointValid || !modelValid}>Test</Button>
            </div>
          </Field>
          <Field label="Model" hint={!modelValid ? "A model id is required." : undefined}>
            <Input value={model} onChange={(e) => setModel(e.target.value)} className="mono" placeholder="Model" />
          </Field>
          <Field label="Public label">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Public label" />
          </Field>
          <Field label="Domains to serve" hint={!domainsValid ? "Select at least one domain." : undefined}>
            <div className="flex flex-wrap gap-1">
              {DOMAINS.map((d) => {
                const on = domains.includes(d);
                return (
                  <button key={d} onClick={() => toggleDomain(d)}
                    className={cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
                      on ? "border-[color-mix(in_srgb,var(--accent)_28%,transparent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-hairline text-muted hover:text-text")}>
                    {on && <Check size={11} />}{d}
                  </button>
                );
              })}
            </div>
          </Field>
        </div>
        <Button variant={stats.running ? "danger" : "primary"} className="mt-3 w-full" onClick={toggle} disabled={starting || (!stats.running && !configValid)}>
          <Radio size={15} /> {stats.running ? "Stop serving" : starting ? "Starting…" : "Start serving and earn"}
        </Button>
      </Card>

      <Card>
        <h3 className="mb-2 flex items-center justify-between text-sm font-semibold">
          Productivity
          <Badge tone={providerStatus.reachable ? "teal" : "neutral"}>{providerStatus.reachable ? "reachable" : "idle"}</Badge>
        </h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Earned today" value={`${formatZir(providerStatus.earnedTodayUZIR)} ZIR`} tone="teal" />
          <Stat label="Queries today" value={providerStatus.queriesAnswered} />
          <Stat label="Earned this session" value={`${formatZir(stats.earnedThisSessionUZIR)} ZIR`} tone="teal" />
          <Stat label="Session queries" value={stats.queriesAnswered} />
        </div>
        <p className="mt-2 text-[11px] text-faint">Today totals come from the node and survive a restart; session totals reset when serving stops.</p>
        {stats.lastError && <p className="mt-2 text-xs text-[var(--warn)]">{stats.lastError}</p>}
      </Card>
    </div>
  );
}

function WalletTab() {
  const { address, unlocked } = useZira();
  const setUnlocked = useZira((s) => s.setUnlocked);
  const request = useUnlock((s) => s.request);
  const toast = useToast();
  return (
    <div className="space-y-4">
      <Card>
        <h3 className="mb-2 text-sm font-semibold">Wallet</h3>
        <div className="mono mb-2 break-all text-xs">{address ?? "no wallet"}</div>
        <div className="flex gap-2">
          {unlocked
            ? <Button variant="secondary" onClick={() => { Wallet.lock(); setUnlocked(false); toast.push("Locked"); }}>Lock</Button>
            : <Button variant="secondary" onClick={async () => { if (await request()) { setUnlocked(true); toast.push("Unlocked"); } }}>Unlock</Button>}
        </div>
        <p className="mt-2 text-xs text-faint">Backup and export are on the Wallet page, behind a clear warning. Keys never leave this device. Reset ZIRA is at the bottom of Settings.</p>
      </Card>
    </div>
  );
}

function NetworkTab() {
  const { network } = useZira();
  return (
    <Card>
      <h3 className="mb-2 text-sm font-semibold">Network</h3>
      <p className="mb-3 text-xs text-muted">This node is running the network shown below. You can&apos;t switch networks here. It is fixed in the node&apos;s config.</p>
      <div className="space-y-2">
        {Object.values(NETWORKS).map((n) => {
          const active = n.id === network;
          return (
            <div key={n.id} className={cn("flex items-center justify-between gap-2 rounded-lg border p-2.5", active ? "border-[color-mix(in_srgb,var(--accent)_28%,transparent)] bg-[var(--accent-soft)]" : "border-hairline opacity-70")}>
              <span className="text-sm text-text">{n.human}</span>
              <span className="flex items-center gap-1.5">
                {active && <Badge tone="teal">this node</Badge>}
                <Badge tone={n.zirLive ? "indigo" : "neutral"}>{n.zirLive ? "live ZIR" : "test, no value"}</Badge>
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] text-faint">To change network, edit the operator's node config (<span className="mono">network</span> in the node config file) and restart the node. Test ZIR has no value; only mainnet ZIR is the live asset.</p>
    </Card>
  );
}

function Economy() {
  return (
    <div className="space-y-4">
      <Card>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-sm font-semibold flex items-center gap-2"><Coins size={16} /> ZRC and value streams</h3>
          <Badge tone="indigo">coming soon</Badge>
        </div>
        <p className="text-sm text-muted">
          Two pieces are on the way for a later release. They are designed and reserved here so you know what is coming.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-hairline bg-base p-3">
            <div className="text-sm font-medium">ZRC Resonance Objects</div>
            <p className="mt-1 text-xs text-muted">Instruments that price themselves from the live field instead of storing a balance. Wrap compute, energy, carbon, data, or currencies into something that reads its own value and pays out when it settles.</p>
          </div>
          <div className="rounded-lg border border-hairline bg-base p-3">
            <div className="text-sm font-medium">Continuous value streams</div>
            <p className="mt-1 text-xs text-muted">Money that flows alongside verified work, a little every second, and pauses on its own when the agreed conditions stop being met. No invoices, no chasing.</p>
          </div>
        </div>
        <p className="mt-3 text-[11px] text-faint">Today you can already send ZIR, ask the network, build Resonators, and mine. ZRC and streams arrive in a future update.</p>
      </Card>
    </div>
  );
}
