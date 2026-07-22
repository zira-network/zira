// apps/console/src/app/Dashboard.tsx
// 2.9.0 (3B): a single real-time overview of THIS node — health, network, your machine, mining, and rewards.
// All hardware/telemetry is read from the local node's /status (loopback on desktop), shown LOCALLY by default
// (G7 telemetry privacy): nothing here is sent anywhere. Network figures come from the shared gateway /stats,
// the same public data the Explorer reads.
import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";
import { Card, Badge, Meter, PageHeader, LoadingState, useSlowHint, usePoll } from "../components/ui";
import { NodeApi, type StatusInfo, type ExtendedStats } from "../lib/nodeApi";
import { useZira } from "../store/useZira";
import { formatNum, formatZir, shortAddress } from "../lib/format";
import { ResonanceField } from "../components/ResonanceField";

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "teal" | "indigo" | "warn" }) {
  const color = tone === "teal" ? "text-[var(--teal)]" : tone === "warn" ? "text-[var(--warn)]" : tone === "indigo" ? "text-[var(--indigo)]" : "text-text";
  // min-w-0 lets the tile shrink inside its grid track (grid children default to min-width:auto and would
  // otherwise be pushed wide by a long unbroken value); break-words + leading-tight + responsive sizing let
  // long ZIR numbers and hardware names wrap and fit rather than clip. The label always shows in full.
  return (
    <div className="min-w-0 rounded-lg border border-hairline bg-base/70 p-3">
      <div className="text-[11px] uppercase tracking-wide text-faint">{label}</div>
      <div className={`mono mt-1 break-words text-[1rem] font-semibold leading-tight sm:text-lg ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 break-words text-[11px] text-faint">{sub}</div>}
    </div>
  );
}

// A dashboard section is an at-a-glance SUMMARY; the detail lives on the page it links to (so the Dashboard
// never duplicates Explorer/Mine/Wallet, it delegates to them). `to`/`toLabel` render that quiet deep link.
function Section({ title, badge, to, toLabel, children }: { title: string; badge?: string; to?: string; toLabel?: string; children: React.ReactNode }) {
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <div className="flex items-center gap-2">
          {badge && <Badge tone="indigo">{badge}</Badge>}
          {to && <Link to={to} className="inline-flex items-center gap-0.5 text-[11px] text-[var(--teal)] hover:underline">{toLabel ?? "Open"} <ArrowUpRight size={12} /></Link>}
        </div>
      </div>
      {children}
    </Card>
  );
}

const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(bytes >= 1024 ** 3 ? 2 : 1);

export function Dashboard() {
  const { mode } = useZira();
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [stats, setStats] = useState<ExtendedStats | null>(null);
  const [err, setErr] = useState("");
  const slow = useSlowHint(status === null);

  usePoll(() => {
    // Local node view (own hardware/mining, loopback) + the shared network view. Either can fail independently.
    NodeApi.status().then(setStatus).catch((e) => setErr(e instanceof Error ? e.message : "node unreachable"));
    NodeApi.networkStats().then(setStats).catch(() => NodeApi.stats().then(setStats).catch(() => { /* network read optional */ }));
  }, 5000, []);

  if (status === null && stats === null && !err) {
    return <div className="mx-auto max-w-6xl p-5"><PageHeader title="Dashboard" description="A live view of your node and the network." /><LoadingState slow={slow} /></div>;
  }

  const hw = status?.hardware ?? null;
  const mining = status?.mining ?? null;
  const lag = stats && stats.currentEpoch !== undefined && stats.finalizedEpoch >= 0 ? Math.max(0, stats.currentEpoch - stats.finalizedEpoch) : -1;
  const synced = lag >= 0 && lag <= 2;
  const storageUsed = mining ? Number(mining.storageUsedBytes || 0) : 0;
  const storageCap = mining ? Number(mining.storageCapBytes || 0) : 0;

  // The field's energy is real: it brightens with providers answering + agreements landing, and it is "live"
  // only when this node is synced and actually part of the work (mining/serving) or the network is active.
  const providers = stats?.providersOnline ?? 0;
  const locks = stats?.locksPerMinute ?? 0;
  const intensity = Math.max(0, Math.min(1, providers / 8 * 0.6 + Math.min(locks, 12) / 12 * 0.4));
  const fieldLive = (synced || lag < 0) && (providers > 0 || !!mining?.enabled);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-5">
      <PageHeader
        title="Dashboard"
        badge={<Badge tone={fieldLive ? "teal" : "neutral"}>{fieldLive ? "live" : "quiet"}</Badge>}
        description="Your place in the resonance field. Hardware and mining figures are read locally and shown only to you."
      />

      {/* HERO: the living field, your balance at its core, its energy driven by real network activity */}
      <Card className="overflow-hidden !p-0">
        <div className="brand-rule" />
        <div className="grid items-center gap-4 p-5 md:grid-cols-[minmax(0,1fr)_320px]">
          <div className="order-2 min-w-0 md:order-1">
            <div className="text-[11px] uppercase tracking-[0.14em] text-faint">Your balance</div>
            <div className="mono mt-1 break-words text-3xl font-semibold leading-none tracking-tight text-text sm:text-4xl">{status ? formatZir(status.balanceUZIR) : "-"} <span className="text-lg text-faint">ZIR</span></div>
            {status && <div className="mono mt-1.5 break-all text-[11px] text-faint">{shortAddress(status.address)}</div>}
            <div className="mt-4 grid grid-cols-3 gap-2">
              <Stat label="Earned today" value={status ? formatZir(status.providerStatus?.earnedTodayUZIR ?? 0) : "-"} tone="teal" sub="ZIR" />
              <Stat label="Answered" value={mining ? String(mining.answered ?? 0) : "-"} sub="queries" />
              <Stat label="Sync" value={lag < 0 ? "..." : synced ? "Synced" : `${lag} back`} tone={synced ? "teal" : "warn"} sub={stats ? `epoch ${stats.finalizedEpoch}` : undefined} />
            </div>
            <Link to="/wallet" className="mt-3 inline-flex items-center gap-0.5 text-[11px] text-[var(--teal)] hover:underline">Open wallet <ArrowUpRight size={12} /></Link>
          </div>
          <div className="order-1 flex flex-col items-center md:order-2">
            <ResonanceField size={300} intensity={intensity} live={fieldLive} />
            <div className="mt-3 text-center">
              <div className="mono text-lg font-semibold leading-none text-text">{stats ? formatNum(stats.activeNodes, 0) : "-"}</div>
              <div className="mt-1 text-[11px] uppercase tracking-[0.16em] text-faint">nodes resonating</div>
            </div>
          </div>
        </div>
      </Card>

      {/* Network */}
      <Section title="Network" badge="shared gateway" to="/explorer" toLabel="Explorer">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Active nodes" value={stats ? String(stats.activeNodes) : "-"} />
          <Stat label="Providers online" value={stats ? String(stats.providersOnline) : "-"} tone={stats && stats.providersOnline > 0 ? "teal" : undefined} sub="answering now" />
          <Stat label="Locks / min" value={stats ? String(stats.locksPerMinute) : "-"} sub="field agreements" />
          <Stat label="Avg ZTI" value={stats ? formatNum(stats.avgZti, 2) : "-"} sub="network trust" />
        </div>
      </Section>

      {/* Your machine (hardware) */}
      <Section title="Your machine" badge={mode === "node" ? "this device" : "local node"} to="/mine" toLabel="Mine">
        {hw ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="GPU" value={hw.gpuName ? hw.gpuName : "none"} tone={hw.gpuName ? "teal" : undefined} sub={hw.gpuVramMb ? `${(hw.gpuVramMb / 1024).toFixed(1)} GB VRAM` : "CPU only"} />
            <Stat label="CPU" value={hw.cpuName ? hw.cpuName : (hw.arch ?? "-")} sub={`${hw.cpuCores} cores`} />
            <Stat label="Memory" value={`${(hw.ramMb / 1024).toFixed(0)} GB`} sub="RAM" />
            <Stat label="Tier" value={hw.capabilityTier ?? "-"} tone="indigo" sub="capability" />
          </div>
        ) : (
          <div className="text-sm text-faint">Hardware details are available on your own node. {mode !== "node" ? "Connect the desktop app to see this machine." : "Run a hardware scan in Settings."}</div>
        )}
      </Section>

      {/* Mining */}
      <Section title="Mining" badge={mining?.enabled ? "on" : "off"} to="/mine" toLabel="Manage">
        {mining ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Status" value={mining.enabled ? "Mining" : "Idle"} tone={mining.enabled ? "teal" : undefined} sub={mining.serving ? "serving the field" : "liveness only"} />
              <Stat label="Engine" value={mining.engineAvailable ? "ready" : "unavailable"} tone={mining.engineAvailable ? "teal" : "warn"} sub={mining.loadedModel ? mining.loadedModel : "no model loaded"} />
              <Stat label="Storage" value={`${gib(storageUsed)} GB`} sub={storageCap ? `of ${gib(storageCap)} GB cap` : "off"} />
              <Stat label="Answered" value={String(mining.answered ?? 0)} sub="queries served" />
            </div>
            {storageCap > 0 && <div className="mt-3"><Meter value={storageCap > 0 ? storageUsed / storageCap : 0} /></div>}
          </>
        ) : (
          <div className="text-sm text-faint">Mining status is available on your own node.</div>
        )}
      </Section>

      {err && !status && <div className="text-xs text-[var(--danger)]">Could not reach your node: {err}. Network figures shown from the gateway.</div>}
    </div>
  );
}
