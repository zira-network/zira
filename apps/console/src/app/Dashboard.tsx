// apps/console/src/app/Dashboard.tsx
// A real-time observability dashboard: "what is happening on THIS machine in relation to the ZIRA network."
// Inverted pyramid: the apex is a compact NODE HEALTH + EARNINGS unit (health is the primary lens), then a
// row of aggregate KPI tiles (hardware, node-health detail, rewards, bandwidth), then one expanded detail
// panel (progressive disclosure). All figures are read live from the local node (loopback) + the shared
// gateway /stats; nothing is fabricated. Metrics the node does not expose yet show an honest streaming or
// collecting state and light up automatically when the data arrives. No node code or RPC is changed here.
import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Activity, Cpu, Coins, ArrowDownUp } from "lucide-react";
import { Card, Badge, PageHeader, LoadingState, useSlowHint, usePoll } from "../components/ui";
import {
  LiveNumber, DeltaBadge, TrendLine, StatusPill, HealthDot, Freshness, DataQuality, MiniBar,
  type Sem, type Quality,
} from "../components/liveviz";
import { NodeApi, type StatusInfo, type ExtendedStats, type NetInfo, type MiningStatus, type ProviderStatus } from "../lib/nodeApi";
import type { HardwareProfile } from "@zira/protocol";
import { useZira } from "../store/useZira";
import { formatNum, formatZir } from "../lib/format";

const POLL_MS = 3000;
const CAP = 60; // rolling window: 60 samples at 3s ~= 3 minutes
const MIN_POINTS = 6; // below this a trend/baseline is still "collecting"

// Fields a second track is adding to the node status. Consumed defensively: present -> live, absent -> honest
// streaming placeholder. No `any`: we widen the known shapes with optional fields and read via optional chaining.
type LiveHardware = HardwareProfile & { gpuUtil?: number; cpuUtil?: number; ramUsedFrac?: number };
type Bandwidth = { rxBytesPerSec?: number; txBytesPerSec?: number; capKbps?: number; autoKbps?: boolean };
type LiveMining = MiningStatus & { bandwidth?: Bandwidth };
type LiveProviderStatus = ProviderStatus & { fieldUZIR?: number; coordinationUZIR?: number; storageUZIR?: number };

type KpiKey = "hardware" | "health" | "rewards" | "bandwidth";

interface Series {
  t: number[];
  earnedToday: number[]; // ZIR
  rate: number[]; // ZIR/hr, instantaneous per sample
  peers: number[];
  providers: number[];
  syncLag: number[];
  gpuUtil: number[]; // 0..1, only pushed when present
  cpuUtil: number[];
  ramFrac: number[];
  rxBps: number[];
  txBps: number[];
}
const EMPTY_SERIES: Series = { t: [], earnedToday: [], rate: [], peers: [], providers: [], syncLag: [], gpuUtil: [], cpuUtil: [], ramFrac: [], rxBps: [], txBps: [] };

function pushCap(arr: number[], v: number): number[] {
  const n = arr.length >= CAP ? arr.slice(arr.length - CAP + 1) : arr.slice();
  n.push(v);
  return n;
}
function last(arr: number[]): number | undefined { return arr.length ? arr[arr.length - 1] : undefined; }
function avg(arr: number[]): number | null {
  if (!arr.length) return null;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}
// A moving-average baseline over the most recent n points (defaults to the whole window).
function movingAvg(arr: number[], n = arr.length): number | null {
  if (arr.length < 2) return null;
  return avg(arr.slice(Math.max(0, arr.length - n)));
}

const fmt1 = (v: number) => formatNum(v, 1);
const fmtPct = (v: number) => `${Math.round(v * 100)}`;
function bps(v: number): string {
  if (v >= 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB/s`;
  if (v >= 1024) return `${(v / 1024).toFixed(0)} KB/s`;
  return `${Math.round(v)} B/s`;
}

// ---- a small drill-down KPI tile: LiveNumber + DeltaBadge + a mini TrendLine ----
function KpiTile({ id, icon, label, value, unit, tone, delta, baseline, goodDirection, series, quality, selected, onSelect, footer }: {
  id: KpiKey;
  icon: React.ReactNode;
  label: string;
  value: number | string;
  unit?: string;
  tone: Sem;
  delta?: number | null;
  baseline?: number | null;
  goodDirection?: "up" | "down" | "neutral";
  series: number[];
  quality: Quality;
  selected: boolean;
  onSelect: (id: KpiKey) => void;
  footer?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(id)}
      aria-pressed={selected}
      className={`min-w-0 rounded-xl border p-3 text-left transition-colors ${selected ? "border-[var(--accent)] bg-[var(--accent-soft)]" : "border-hairline bg-base/60 hover:border-[var(--border-strong)]"}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-faint">
          <span className="text-muted">{icon}</span>{label}
        </div>
        <DataQuality quality={quality} />
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-lg font-semibold leading-none text-text sm:text-xl">
          {typeof value === "number" ? <LiveNumber value={value} unit={unit} flashTone={tone} /> : <LiveNumber value={value} flashTone={tone} />}
        </span>
      </div>
      <div className="mt-1 h-4">
        {delta !== undefined && quality !== "collecting" && quality !== "streaming" && (
          <DeltaBadge value={delta ?? 0} baseline={baseline} goodDirection={goodDirection} />
        )}
        {(quality === "collecting" || quality === "streaming") && (
          <span className="text-[11px] text-faint">{quality === "collecting" ? "collecting history" : "awaiting node data"}</span>
        )}
      </div>
      <div className="mt-1.5">
        <TrendLine data={series} baseline={baseline ?? undefined} height={30} tone={tone} fill />
      </div>
      {footer && <div className="mt-1.5 text-[11px] text-faint">{footer}</div>}
    </button>
  );
}

export function Dashboard() {
  const { mode } = useZira();
  const [status, setStatus] = useState<StatusInfo | null>(null);
  const [stats, setStats] = useState<ExtendedStats | null>(null);
  const [net, setNet] = useState<NetInfo | null>(null);
  const [series, setSeries] = useState<Series>(EMPTY_SERIES);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);
  const [selected, setSelected] = useState<KpiKey>("health");
  const [err, setErr] = useState("");
  const slow = useSlowHint(status === null && stats === null);

  usePoll(() => {
    void (async () => {
      const [stRes, nsRes, netRes] = await Promise.allSettled([
        NodeApi.status(),
        NodeApi.networkStats().catch(() => NodeApi.stats()),
        NodeApi.net(),
      ]);
      const st = stRes.status === "fulfilled" ? stRes.value : null;
      const ns = nsRes.status === "fulfilled" ? nsRes.value : null;
      const ni = netRes.status === "fulfilled" ? netRes.value : null;
      if (st) { setStatus(st); setErr(""); } else if (stRes.status === "rejected") {
        setErr(stRes.reason instanceof Error ? stRes.reason.message : "node unreachable");
      }
      if (ns) setStats(ns);
      if (ni) setNet(ni);

      // Accumulate the rolling series from whatever we got (node does not store history).
      const mining = (st?.mining ?? null) as LiveMining | null;
      const hw = (st?.hardware ?? null) as LiveHardware | null;
      const pstat = (st?.providerStatus ?? null) as LiveProviderStatus | null;
      const peers = ni?.peers ?? ns?.peers ?? undefined;
      const providers = ns?.providersOnline ?? undefined;
      const lag = ns && ns.currentEpoch !== undefined && ns.finalizedEpoch >= 0 ? Math.max(0, ns.currentEpoch - ns.finalizedEpoch) : undefined;
      const earnedTodayZir = pstat ? pstat.earnedTodayUZIR / 1_000_000 : undefined;
      const gpuUtil = typeof hw?.gpuUtil === "number" ? hw.gpuUtil : undefined;
      const cpuUtil = typeof hw?.cpuUtil === "number" ? hw.cpuUtil : undefined;
      const ramFrac = typeof hw?.ramUsedFrac === "number" ? hw.ramUsedFrac : undefined;
      const rx = typeof mining?.bandwidth?.rxBytesPerSec === "number" ? mining.bandwidth.rxBytesPerSec : undefined;
      const tx = typeof mining?.bandwidth?.txBytesPerSec === "number" ? mining.bandwidth.txBytesPerSec : undefined;

      const now = Date.now();
      setSeries((prev) => {
        const next: Series = { ...prev };
        // Derive an instantaneous ZIR/hr rate from consecutive earned-today samples.
        if (earnedTodayZir !== undefined) {
          const lastT = last(prev.t);
          const lastE = last(prev.earnedToday);
          let rate = last(prev.rate) ?? 0;
          if (lastT !== undefined && lastE !== undefined) {
            const dtHr = (now - lastT) / 3_600_000;
            const dE = earnedTodayZir - lastE;
            if (dtHr > 0 && dE >= 0) rate = dE / dtHr; // guard the midnight reset (negative delta)
          }
          next.t = pushCap(prev.t, now);
          next.earnedToday = pushCap(prev.earnedToday, earnedTodayZir);
          next.rate = pushCap(prev.rate, rate);
        }
        if (peers !== undefined) next.peers = pushCap(prev.peers, peers);
        if (providers !== undefined) next.providers = pushCap(prev.providers, providers);
        if (lag !== undefined) next.syncLag = pushCap(prev.syncLag, lag);
        if (gpuUtil !== undefined) next.gpuUtil = pushCap(prev.gpuUtil, gpuUtil);
        if (cpuUtil !== undefined) next.cpuUtil = pushCap(prev.cpuUtil, cpuUtil);
        if (ramFrac !== undefined) next.ramFrac = pushCap(prev.ramFrac, ramFrac);
        if (rx !== undefined) next.rxBps = pushCap(prev.rxBps, rx);
        if (tx !== undefined) next.txBps = pushCap(prev.txBps, tx);
        return next;
      });
      setRefreshedAt(now);
    })();
  }, POLL_MS, []);

  if (status === null && stats === null && !err) {
    return (
      <div className="mx-auto max-w-6xl p-5">
        <PageHeader title="Dashboard" description="A live view of your node and the network." />
        <LoadingState slow={slow} />
      </div>
    );
  }

  // ---- derive current values ----
  const mining = (status?.mining ?? null) as LiveMining | null;
  const hw = (status?.hardware ?? null) as LiveHardware | null;
  const pstat = (status?.providerStatus ?? null) as LiveProviderStatus | null;

  const peers = net?.peers ?? stats?.peers ?? 0;
  const providers = stats?.providersOnline ?? 0;
  const lag = stats && stats.currentEpoch !== undefined && stats.finalizedEpoch >= 0 ? Math.max(0, stats.currentEpoch - stats.finalizedEpoch) : -1;
  const nodeReachable = status !== null;

  // Composite node health: the primary lens. Driven by reachability, sync lag, and peer/provider presence.
  let health: Sem = "idle";
  let healthLabel = "Connecting";
  let healthSub = "";
  if (!nodeReachable && err) { health = "critical"; healthLabel = "Node offline"; healthSub = "no local node"; }
  else if (nodeReachable) {
    if (lag < 0) { health = "info"; healthLabel = "Syncing"; healthSub = "reading epoch"; }
    else if (peers === 0) { health = "critical"; healthLabel = "No peers"; healthSub = "isolated"; }
    else if (lag > 6) { health = "critical"; healthLabel = "Out of sync"; healthSub = `${lag} epochs back`; }
    else if (lag > 2 || providers === 0) { health = "warn"; healthLabel = "Degraded"; healthSub = providers === 0 ? "no providers" : `${lag} epochs back`; }
    else { health = "good"; healthLabel = "Healthy"; healthSub = "synced"; }
  }

  // ---- earnings ----
  const earnedTodayZir = pstat ? pstat.earnedTodayUZIR / 1_000_000 : 0;
  const rateNow = last(series.rate) ?? 0;
  const rateBaseline = movingAvg(series.rate);
  const rateCollecting = series.rate.length < MIN_POINTS;
  const hasBySource = pstat !== undefined && pstat !== null && (pstat.fieldUZIR !== undefined || pstat.coordinationUZIR !== undefined || pstat.storageUZIR !== undefined);
  const answered = mining?.answered ?? pstat?.queriesAnswered ?? 0;
  const miningOff = mining !== null && !mining.enabled;

  // ---- hardware allocation ----
  const gpuUtil = last(series.gpuUtil);
  const cpuUtil = last(series.cpuUtil);
  const ramFrac = last(series.ramFrac);
  const hwLiveAny = gpuUtil !== undefined || cpuUtil !== undefined || ramFrac !== undefined;
  const hwPrimaryUtil = gpuUtil ?? cpuUtil ?? ramFrac; // headline: prefer GPU, else CPU, else RAM
  const hwPrimarySeries = series.gpuUtil.length ? series.gpuUtil : series.cpuUtil.length ? series.cpuUtil : series.ramFrac;
  const hwQuality: Quality = !nodeReachable ? "offline" : hwLiveAny ? (hwPrimarySeries.length < MIN_POINTS ? "collecting" : "confirmed") : "streaming";

  // ---- bandwidth ----
  const rx = last(series.rxBps);
  const tx = last(series.txBps);
  const bw = mining?.bandwidth;
  const bwLive = rx !== undefined || tx !== undefined;
  const bwQuality: Quality = !nodeReachable ? "offline" : bwLive ? (series.txBps.length < MIN_POINTS ? "collecting" : "confirmed") : "streaming";
  const capKbps = typeof bw?.capKbps === "number" ? bw.capKbps : undefined;

  // ---- node-health detail KPI ----
  const peersBaseline = movingAvg(series.peers);
  const healthQuality: Quality = !nodeReachable ? "offline" : series.peers.length < MIN_POINTS ? "collecting" : "confirmed";

  // ---- rewards KPI ----
  const rewardsQuality: Quality = !nodeReachable ? "offline" : rateCollecting ? "collecting" : "streaming";

  const fieldLive = nodeReachable && (health === "good" || health === "warn") && (providers > 0 || !!mining?.enabled);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-3 p-4">
      {/* compact header + live freshness stamp */}
      <div className="flex items-end justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span aria-hidden className="h-5 w-[3px] shrink-0 rounded-full" style={{ background: "linear-gradient(180deg, var(--brand-teal), var(--brand-indigo))" }} />
          <h2 className="text-xl font-semibold tracking-tight text-text">Dashboard</h2>
          <Badge tone={fieldLive ? "teal" : "neutral"}>{fieldLive ? "live" : "quiet"}</Badge>
        </div>
        <Freshness at={refreshedAt} staleMs={POLL_MS * 3} />
      </div>

      {/* APEX: compact NODE HEALTH + EARNINGS. Health is the primary lens; earnings ride alongside. */}
      <Card className="!p-0">
        <div className="brand-rule" />
        <div className="grid gap-0 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          {/* Node health */}
          <div className="border-hairline p-4 md:border-r">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-faint"><Activity size={13} /> Node health</div>
              <DataQuality quality={nodeReachable ? "confirmed" : "offline"} />
            </div>
            <div className="flex items-center gap-3">
              <StatusPill status={health} label={healthLabel} sub={healthSub} big />
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              <SignalCell label="Peers" value={net || stats ? String(peers) : "-"} status={peers > 0 ? "good" : "critical"} />
              <SignalCell label="Providers" value={stats ? String(providers) : "-"} status={providers > 0 ? "good" : "warn"} sub="answering" />
              <SignalCell label="Sync" value={lag < 0 ? "..." : lag <= 2 ? "in sync" : `${lag} back`} status={lag < 0 ? "idle" : lag <= 2 ? "good" : lag > 6 ? "critical" : "warn"} sub={stats ? `epoch ${stats.finalizedEpoch}` : undefined} />
            </div>
            {!nodeReachable && err && (
              <div className="mt-3 text-[11px] text-faint">Your node is not reachable. {mode !== "node" ? "Open the desktop app to observe this machine." : "The node may be starting or syncing; this keeps retrying."} Network figures below come from the shared gateway.</div>
            )}
          </div>
          {/* Earnings */}
          <div className="p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-faint"><Coins size={13} /> Earnings</div>
              <DataQuality quality={nodeReachable ? "streaming" : "offline"} note="Live estimate from the local node, not a settled figure." />
            </div>
            <div className="flex items-end justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-2xl font-semibold leading-none text-text">
                    <LiveNumber value={rateNow} format={fmt1} flashTone="good" />
                  </span>
                  <span className="text-[11px] text-faint">ZIR/hr</span>
                </div>
                <div className="mt-1 h-4">
                  {rateCollecting ? (
                    <span className="text-[11px] text-faint">collecting history</span>
                  ) : (
                    <DeltaBadge value={rateNow} baseline={rateBaseline} goodDirection="up" suffix="vs recent avg" />
                  )}
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-[11px] uppercase tracking-wide text-faint">Earned today</div>
                <div className="text-lg font-semibold leading-tight text-[var(--teal)]">
                  <LiveNumber value={earnedTodayZir} format={(v) => formatZir(Math.round(v * 1_000_000))} flashTone="good" /> <span className="text-[11px] font-normal text-faint">ZIR</span>
                </div>
                <div className="mono mt-0.5 text-[11px] text-faint">{answered} answered</div>
              </div>
            </div>
            <div className="mt-2">
              <TrendLine data={series.rate} baseline={rateBaseline} height={28} tone="good" fill />
            </div>
            {miningOff && <div className="mt-1.5 text-[11px] text-faint">Mining is off. <Link to="/mine" className="text-[var(--teal)] hover:underline">Turn it on</Link> to lend compute and earn.</div>}
          </div>
        </div>
      </Card>

      {/* TIER 2: aggregate KPI tiles (click to drill down) */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiTile
          id="hardware"
          icon={<Cpu size={13} />}
          label="Hardware use"
          value={hwPrimaryUtil !== undefined ? fmtPct(hwPrimaryUtil) : "--"}
          unit={hwPrimaryUtil !== undefined ? "%" : undefined}
          tone={hwPrimaryUtil !== undefined && hwPrimaryUtil > 0.9 ? "warn" : "info"}
          delta={hwPrimaryUtil !== undefined ? hwPrimaryUtil * 100 : null}
          baseline={movingAvg(hwPrimarySeries.map((v) => v * 100))}
          goodDirection="neutral"
          series={hwPrimarySeries.map((v) => v * 100)}
          quality={hwQuality}
          selected={selected === "hardware"}
          onSelect={setSelected}
          footer={hw ? `${gpuUtil !== undefined ? "GPU" : cpuUtil !== undefined ? "CPU" : ramFrac !== undefined ? "RAM" : hw.gpuName ? "GPU" : "CPU"} - ${hw.gpuName ?? hw.cpuName ?? hw.arch ?? "device"}` : "hardware on your node"}
        />
        <KpiTile
          id="health"
          icon={<Activity size={13} />}
          label="Peers"
          value={peers}
          tone={peers > 0 ? "good" : "critical"}
          delta={peers}
          baseline={peersBaseline}
          goodDirection="up"
          series={series.peers}
          quality={healthQuality}
          selected={selected === "health"}
          onSelect={setSelected}
          footer={`${providers} providers - ${lag < 0 ? "sync ..." : lag <= 2 ? "in sync" : `${lag} back`}`}
        />
        <KpiTile
          id="rewards"
          icon={<Coins size={13} />}
          label="Reward rate"
          value={rateNow}
          unit="ZIR/hr"
          tone="good"
          delta={rateNow}
          baseline={rateBaseline}
          goodDirection="up"
          series={series.rate}
          quality={rewardsQuality}
          selected={selected === "rewards"}
          onSelect={setSelected}
          footer={hasBySource ? "by source below" : "source split streaming"}
        />
        <KpiTile
          id="bandwidth"
          icon={<ArrowDownUp size={13} />}
          label="Bandwidth out"
          value={tx !== undefined ? bps(tx) : "--"}
          tone="info"
          delta={tx !== undefined ? tx : null}
          baseline={movingAvg(series.txBps)}
          goodDirection="neutral"
          series={series.txBps}
          quality={bwQuality}
          selected={selected === "bandwidth"}
          onSelect={setSelected}
          footer={rx !== undefined ? `in ${bps(rx)}` : capKbps ? `cap ${capKbps} kbps` : "node metric coming"}
        />
      </div>

      {/* TIER 3: expanded detail for the selected KPI (progressive disclosure) */}
      <Card>
        {selected === "hardware" && (
          <DetailPanel title="Hardware allocation" to="/mine" toLabel="Mine">
            {hwLiveAny ? (
              <>
                <TrendLine data={hwPrimarySeries.map((v) => v * 100)} baseline={movingAvg(hwPrimarySeries.map((v) => v * 100))} height={120} tone="info" fill showBaseline />
                <div className="mt-3 grid grid-cols-3 gap-3">
                  <UtilBar label="GPU" frac={gpuUtil} name={hw?.gpuName ?? "none"} />
                  <UtilBar label="CPU" frac={cpuUtil} name={hw?.cpuName ?? hw?.arch ?? "-"} />
                  <UtilBar label="RAM" frac={ramFrac} name={hw ? `${(hw.ramMb / 1024).toFixed(0)} GB` : "-"} />
                </div>
              </>
            ) : (
              <StreamingNote
                title="Live hardware utilization is streaming"
                body="Your node reports device names and capability tier now; live GPU/CPU/RAM utilization lights up here as soon as the node exposes it."
              >
                {hw && (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <SmallStat label="GPU" value={hw.gpuName ?? "none"} sub={hw.gpuVramMb ? `${(hw.gpuVramMb / 1024).toFixed(1)} GB VRAM` : "CPU only"} />
                    <SmallStat label="CPU" value={hw.cpuName ?? hw.arch ?? "-"} sub={`${hw.cpuCores} cores`} />
                    <SmallStat label="Memory" value={`${(hw.ramMb / 1024).toFixed(0)} GB`} sub="RAM" />
                    <SmallStat label="Tier" value={hw.capabilityTier ?? "-"} sub="capability" />
                  </div>
                )}
              </StreamingNote>
            )}
          </DetailPanel>
        )}

        {selected === "health" && (
          <DetailPanel title="Node health over time" to="/explorer" toLabel="Explorer">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_240px]">
              <div>
                <div className="mb-1 text-[11px] uppercase tracking-wide text-faint">Peers connected</div>
                <TrendLine data={series.peers} baseline={peersBaseline} height={110} tone={peers > 0 ? "good" : "critical"} fill showBaseline />
              </div>
              <div className="grid grid-cols-1 gap-3">
                <SmallStat label="Peers" value={String(peers)} sub={peersBaseline !== null ? `avg ${peersBaseline.toFixed(1)}` : "collecting"} />
                <SmallStat label="Providers online" value={String(providers)} sub="answering now" />
                <SmallStat label="Sync lag" value={lag < 0 ? "..." : `${lag} epochs`} sub={stats ? `finalized ${stats.finalizedEpoch} / current ${stats.currentEpoch ?? "-"}` : undefined} />
              </div>
            </div>
          </DetailPanel>
        )}

        {selected === "rewards" && (
          <DetailPanel title="Rewards" to="/wallet" toLabel="Wallet">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_240px]">
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[11px] uppercase tracking-wide text-faint">Reward rate (ZIR/hr)</span>
                  <DataQuality quality={rewardsQuality} note="Live estimate derived from earned-today deltas." />
                </div>
                <TrendLine data={series.rate} baseline={rateBaseline} height={110} tone="good" fill showBaseline />
              </div>
              <div className="grid grid-cols-1 gap-3">
                <SmallStat label="Earned today" value={`${formatZir(pstat ? pstat.earnedTodayUZIR : 0)} ZIR`} sub="live estimate" />
                <div>
                  <div className="mb-1.5 text-[11px] uppercase tracking-wide text-faint">By source</div>
                  {hasBySource ? (
                    <div className="flex flex-col gap-2">
                      <MiniBar label="Field" tone="good" value={pstat?.fieldUZIR ?? 0} total={pstat ? pstat.earnedTodayUZIR || 1 : 1} unit={`${formatZir(pstat?.fieldUZIR ?? 0)}`} />
                      <MiniBar label="Coordination" tone="info" value={pstat?.coordinationUZIR ?? 0} total={pstat ? pstat.earnedTodayUZIR || 1 : 1} unit={`${formatZir(pstat?.coordinationUZIR ?? 0)}`} />
                      <MiniBar label="Storage" tone="warn" value={pstat?.storageUZIR ?? 0} total={pstat ? pstat.earnedTodayUZIR || 1 : 1} unit={`${formatZir(pstat?.storageUZIR ?? 0)}`} />
                    </div>
                  ) : (
                    <div className="text-[11px] text-faint">The reward-by-source split (field / coordination / storage) streams in once the node exposes it.</div>
                  )}
                </div>
              </div>
            </div>
          </DetailPanel>
        )}

        {selected === "bandwidth" && (
          <DetailPanel title="Bandwidth" to="/mine" toLabel="Mine">
            {bwLive ? (
              <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_240px]">
                <div>
                  <div className="mb-1 text-[11px] uppercase tracking-wide text-faint">Out / in over time</div>
                  <TrendLine data={series.txBps} baseline={movingAvg(series.txBps)} height={110} tone="info" fill showBaseline />
                </div>
                <div className="grid grid-cols-1 gap-3">
                  <SmallStat label="Out" value={tx !== undefined ? bps(tx) : "-"} sub={movingAvg(series.txBps) !== null ? `avg ${bps(movingAvg(series.txBps) ?? 0)}` : "collecting"} />
                  <SmallStat label="In" value={rx !== undefined ? bps(rx) : "-"} />
                  <SmallStat label="Cap" value={capKbps ? `${capKbps} kbps` : bw?.autoKbps ? "auto" : "-"} sub={bw?.autoKbps ? "auto-managed" : undefined} />
                </div>
              </div>
            ) : (
              <StreamingNote
                title="Bandwidth metrics are coming"
                body="Live upload/download throughput and the bandwidth cap will appear here once the node exposes them. Nothing is estimated until then."
              />
            )}
          </DetailPanel>
        )}
      </Card>
    </div>
  );
}

// ---- small building blocks ----
function SignalCell({ label, value, status, sub }: { label: string; value: string; status: Sem; sub?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-hairline bg-base/60 p-2">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-faint"><HealthDot status={status} size={6} /> {label}</div>
      <div className="mono mt-0.5 truncate text-sm font-semibold text-text"><LiveNumber value={value} /></div>
      {sub && <div className="truncate text-[10px] text-faint">{sub}</div>}
    </div>
  );
}

function SmallStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-hairline bg-base/60 p-2.5">
      <div className="text-[10px] uppercase tracking-wide text-faint">{label}</div>
      <div className="mono mt-0.5 break-words text-sm font-semibold leading-tight text-text">{value}</div>
      {sub && <div className="mt-0.5 break-words text-[10px] text-faint">{sub}</div>}
    </div>
  );
}

function UtilBar({ label, frac, name }: { label: string; frac: number | undefined; name: string }) {
  const pct = frac !== undefined ? Math.round(frac * 100) : null;
  const tone: Sem = frac !== undefined && frac > 0.9 ? "warn" : "good";
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="text-muted">{label}</span>
        <span className="mono text-text">{pct !== null ? `${pct}%` : "streaming"}</span>
      </div>
      <MiniBar label="" value={frac ?? 0} total={1} tone={tone} />
      <div className="mt-1 truncate text-[10px] text-faint">{name}</div>
    </div>
  );
}

function DetailPanel({ title, to, toLabel, children }: { title: string; to?: string; toLabel?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        {to && <Link to={to} className="inline-flex items-center gap-0.5 text-[11px] text-[var(--teal)] hover:underline">{toLabel ?? "Open"} <ArrowUpRight size={12} /></Link>}
      </div>
      {children}
    </div>
  );
}

function StreamingNote({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <DataQuality quality="streaming" />
        <span className="text-sm font-medium text-text">{title}</span>
      </div>
      <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-muted">{body}</p>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}
