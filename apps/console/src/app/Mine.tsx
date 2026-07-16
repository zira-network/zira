// apps/console/src/app/Mine.tsx
// Participation, split cleanly by role:
//   Section A: NODE, always on while ZIRA runs. Consensus + observation. No GPU, no model.
//   Section B: MINING, one switch. Lend your machine to coordinate the field. If a native engine or
//               endpoint is available it can also answer with models; storage remains separate.
//   Steward: MODELS, active launch authority adds models to the field by GGUF link, and publishes
//             advisory recommendations. The field distributes the bytes peer to peer to every node.
import { useEffect, useState, useMemo, type ReactNode } from "react";
import { Cpu, Radio, ShieldCheck, Server, CheckCircle2, Sparkles, Boxes, Link2, TrendingUp, Users, HelpCircle, Wallet as WalletIcon, History as HistoryIcon } from "lucide-react";
import { Card, Button, Input, Badge, useToast, EmptyState, Field, usePoll, PageHeader, Meter, Spinner, ErrorState } from "../components/ui";
import { HardwarePanel } from "../components/HardwarePanel";
import { HexField } from "../components/brand";
import { NodeApi, type ModelRecommendation, type FieldModel, type MiningStatus, type Pricing } from "../lib/nodeApi";
import { canonical, DOMAIN_META, PROTOCOL, type Domain, type HardwareProfile, type SignedTx, type Lock } from "@zira/protocol";
import { formatZir, timeAgo } from "../lib/format";
import { cn } from "../lib/cn";
import { useZira } from "../store/useZira";
import { loadReconciledHistory } from "../lib/history";
import { useUnlock } from "../store/useUnlock";
import { Wallet } from "../lib/keys";
import { isDesktop } from "../lib/platform";

function formatBytes(n: number): string {
  if (!n || n < 1) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"]; const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function Toggle({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button onClick={onClick} disabled={disabled} role="switch" aria-checked={on} title={on ? "On" : "Off"}
      className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors disabled:opacity-40 ${on ? "border-transparent bg-[var(--accent)]" : "border-hairline-strong bg-elevated"}`}>
      <span className={`absolute top-0.5 h-4 w-4 rounded-full shadow-[var(--shadow-1)] transition-all ${on ? "left-[18px] bg-[var(--accent-contrast)]" : "left-0.5 bg-[var(--text-faint)]"}`} />
    </button>
  );
}

// A shared metric tile so balance/earnings/peers numbers read as a consistent, scannable dashboard
// rather than ad-hoc inline label:value spans. Value renders in mono; an optional tone tints it.
type StatTone = "default" | "teal" | "indigo" | "warn";
function Stat({ label, value, tone = "default", hint }: { label: ReactNode; value: ReactNode; tone?: StatTone; hint?: ReactNode }) {
  const toneCls = tone === "teal" ? "text-[var(--teal)]" : tone === "indigo" ? "text-[var(--indigo)]" : tone === "warn" ? "text-[var(--warn)]" : "text-text";
  return (
    <div className="rounded-lg border border-hairline bg-surface/70 p-2.5">
      <div className="flex items-center gap-1 text-[11px] uppercase tracking-wide text-faint">{label}</div>
      <div className={`mono mt-0.5 text-lg leading-tight ${toneCls}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-faint">{hint}</div>}
    </div>
  );
}

// A lightweight tier divider so the long card stack reads as a structured information architecture
// (Your participation / Node / Mining details / Steward) instead of a flat settings dump.
function TierHeader({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="flex items-center gap-3 pt-1">
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-faint">{label}</div>
      {hint && <div className="text-[11px] text-faint">{hint}</div>}
      <div className="h-px flex-1 bg-hairline" />
    </div>
  );
}

// The hardware control for the field. Two choices: "field" lends this machine to the field's
// coordination and earns; "off" does not. Using your OWN hardware for your OWN tasks is not here;
// it lives in the Console (Local mode), so this page is only about contributing to the field.
function HardwareModeControl({ mode, busy, hardwareName, usingEndpoint, endpointModel, fieldDetail, onPick }: {
  mode: "field" | "off";
  busy: boolean;
  hardwareName: string;
  usingEndpoint: boolean;
  endpointModel?: string;
  fieldDetail: string;
  onPick: (next: "field" | "off") => void;
}) {
  const options: { id: "field" | "off"; title: string; detail: string; icon: typeof Radio }[] = [
    { id: "field", title: "Mine for the network", detail: "Put this machine to work for the network. No model or storage needed; other contributors answer alongside you. You earn ZIR when that work is paid, and your own questions are free while you contribute.", icon: Radio },
    { id: "off", title: "Off", detail: "Do not lend this machine to the field. Field mode still works over the network, and you can still use your own hardware for your own tasks from the Console.", icon: ShieldCheck },
  ];
  return (
    <div className="mt-3 space-y-2">
      <div role="radiogroup" aria-label="Hardware use" className="grid gap-2 sm:grid-cols-2">
        {options.map((o) => {
          const active = mode === o.id;
          const Icon = o.icon;
          return (
            <button key={o.id} role="radio" aria-checked={active} disabled={busy} onClick={() => { if (!active) onPick(o.id); }}
              className={`flex flex-col gap-1 rounded-xl border p-3 text-left transition-colors disabled:opacity-50 ${active ? "border-[var(--teal)] bg-[color-mix(in_srgb,var(--teal)_10%,transparent)]" : "border-hairline bg-surface/60 hover:border-hairline-strong"}`}>
              <div className="flex items-center gap-2 text-sm font-medium text-text">
                <Icon size={15} className={active ? "text-[var(--teal)]" : "text-muted"} />
                {o.title}
                {active && <span className="ml-auto inline-block h-1.5 w-1.5 rounded-full bg-[var(--teal)]" />}
              </div>
              <div className="text-[11px] leading-relaxed text-faint">{o.detail}</div>
            </button>
          );
        })}
      </div>
      <div className="rounded-lg border border-hairline bg-base px-3 py-2 text-[11px] text-faint">
        {mode === "field" && <span>{usingEndpoint ? `Serving the field model (${endpointModel || "loading"})` : `${hardwareName} serving as ${fieldDetail}`}.</span>}
        {mode === "off" && <span>Not lending this machine to the field. Field mode still works over the network, and Local mode in the Console can use this machine for your own tasks.</span>}
      </div>
    </div>
  );
}

function DomainChips({ selected, onToggle }: { selected: Domain[]; onToggle: (d: Domain) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {(Object.keys(DOMAIN_META) as Domain[]).map((d) => {
        const active = selected.includes(d);
        return (
          <button key={d} onClick={() => onToggle(d)}
            className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${active ? "border-[var(--teal)] text-[var(--teal)] bg-[color-mix(in_srgb,var(--teal)_12%,transparent)]" : "border-hairline text-muted hover:text-text"}`}>
            {DOMAIN_META[d].label}
          </button>
        );
      })}
    </div>
  );
}

function miningIntelligenceScore(args: { mining: MiningStatus | null | undefined; hardware: HardwareProfile | null; models: FieldModel[]; peers: number; usingEndpoint: boolean }): number {
  const { mining, hardware, models, peers, usingEndpoint } = args;
  if (!mining?.enabled) return 0;
  const tier = hardware?.capabilityTier ?? "relay";
  const base = tier === "gpu-heavy" ? 70 : tier === "gpu-strong" ? 62 : tier === "gpu-basic" ? 48 : tier === "cpu" ? 32 : 16;
  const modelReady = models.some((m) => m.ready);
  let score = base;
  if (modelReady) score += 10;
  if (mining.answerLabel === "field-coordinator") score += 8;
  if (mining.storageEnabled) score += 4;
  if (mining.localTaskPermission) score += 8;
  if (usingEndpoint || mining.engineAvailable) score += 10;
  if (mining.serving) score += 10;
  if (peers >= 2) score += 6;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function miningContributionLabel(args: { mining: MiningStatus | null | undefined; usingEndpoint: boolean; fieldReady: boolean }): string {
  const { mining, usingEndpoint, fieldReady } = args;
  if (!mining?.enabled) return "standby";
  if (mining.serving && mining.answerLabel === "field-coordinator") return "coordinating";
  if (mining.serving) return "answering";
  if (mining.localTaskPermission) return "workspace tasks";
  if (usingEndpoint) return "model starting";
  if (!fieldReady) return "coordinating";
  if (!mining.engineAvailable) return "field relay";
  return "loading model";
}

function hardwareTitle(hardware: HardwareProfile | null): string {
  if (!hardware) return "Scanning this machine";
  if (hardware.gpuName) return hardware.gpuName;
  return hardware.cpuName ?? `${hardware.platform}/${hardware.arch ?? "unknown"}`;
}

function earningLane(args: { mining: MiningStatus | null | undefined; usingEndpoint: boolean; coordinationOnly: boolean; fieldReady: boolean }): { title: string; detail: string; tone: "teal" | "indigo" | "warn" | "neutral" } {
  const { mining, usingEndpoint, coordinationOnly, fieldReady } = args;
  if (!mining?.enabled) return { title: "Mining off", detail: "Turn mining on to relay queries, coordinate models, and prepare earning paths.", tone: "neutral" };
  if (usingEndpoint) return { title: "Answer mining", detail: "Highest earning path: this node is serving the field's distributed model on your hardware and answering paid queries for coordination pay.", tone: "teal" };
  if (mining.loadedModel) return { title: "Answer mining", detail: "Highest earning path: this machine is running the field's distributed model for signed field answers.", tone: "teal" };
  if (coordinationOnly) return { title: "Coordination mining", detail: "Active now: signed query relay, model-field verification, autonomous Resonator coordination, workspace routing, observations, and field-status answers. Turn on Storage to serve the field model and earn answer rewards.", tone: "indigo" };
  if (mining.localTaskPermission) return { title: "Workspace task permission", detail: "This node allows the field to route private build, file, planning, or debugging tasks here when you allow it. This permission does not mean downloading or running a local model by itself.", tone: "indigo" };
  if (fieldReady) return { title: "Model ready, receiving", detail: "The field model is distributed. Turn on Storage to receive and serve it on this machine and move into full answer mining.", tone: "warn" };
  return { title: "Coordinating field", detail: "Mining is enabled for relay, observations, and coordination. Local model bytes are optional unless this node will do full model inference.", tone: "indigo" };
}

// One source of truth for the node's participation state, so the hero badge, hardware badge, mining
// details badge, and earnings badge never disagree in the same render. Earning requires both serving
// AND the field being above the convergence line (>=3 contributors); below it the node only builds ZTI.
type ParticipationKey = "off" | "below-convergence" | "coordinating" | "answering" | "endpoint-answering" | "native-answering";
interface ParticipationState { key: ParticipationKey; label: string; tone: "teal" | "indigo" | "warn" | "neutral"; detail: string }
function participationState(args: {
  mining: MiningStatus | null | undefined;
  usingEndpoint: boolean;
  coordinationOnly: boolean;
  earningUnlocked: boolean;
}): ParticipationState {
  const { mining, usingEndpoint, coordinationOnly, earningUnlocked } = args;
  if (!mining?.enabled) return { key: "off", label: "Off", tone: "neutral", detail: "Not lending this machine to the field." };
  if (!earningUnlocked) return { key: "below-convergence", label: "Building trust", tone: "warn", detail: "Below the convergence line. Serving builds ZTI, but paid work unlocks once the field has 3+ converged contributors." };
  if (usingEndpoint) return { key: "endpoint-answering", label: "Answering", tone: "teal", detail: "Serving the field's distributed model on your hardware and answering paid queries." };
  if (mining.loadedModel) return { key: "native-answering", label: "Answering", tone: "teal", detail: "Answering paid queries with the field's distributed model on this machine." };
  if (coordinationOnly) return { key: "coordinating", label: "Coordinating", tone: "indigo", detail: "Coordinating the field heartbeat. Capable serving miners produce the paid answers." };
  if (mining.serving) return { key: "answering", label: "Answering", tone: "teal", detail: "Serving the field with answers." };
  return { key: "coordinating", label: "Coordinating", tone: "indigo", detail: "Coordinating the field heartbeat." };
}

// The live, demand-driven price floats around a base. Show how far above the floor we are right now.
function priceMultiple(pricing: Pricing | null): number {
  if (!pricing || PROTOCOL.QUERY_PRICE_UZIR <= 0) return 1;
  return pricing.queryUZIR / PROTOCOL.QUERY_PRICE_UZIR;
}
function demandPressure(pricing: Pricing | null): number {
  if (!pricing) return 0;
  return pricing.openQueries / Math.max(1, pricing.providersOnline);
}
function demandLabel(pricing: Pricing | null): { text: string; tone: "teal" | "indigo" | "warn" | "neutral" } {
  if (!pricing) return { text: "reading field", tone: "neutral" };
  const m = priceMultiple(pricing);
  if (m >= 2.5) return { text: "high demand", tone: "teal" };
  if (m >= 1.25) return { text: "rising demand", tone: "indigo" };
  if (m <= 0.75) return { text: "ample supply", tone: "neutral" };
  return { text: "balanced", tone: "indigo" };
}

// Live demand panel: the demand-driven economics, refreshed every few seconds. Distinguishes a real
// fetch failure (ErrorState + retry) from a genuinely quiet market, and shows a spinner on first load
// instead of hard-coded zeros so an unreachable /pricing never looks like a dead-quiet field.
function DemandPanel({ pricing, error, loading, onRetry }: { pricing: Pricing | null; error: string | null; loading: boolean; onRetry: () => void }) {
  const mult = priceMultiple(pricing);
  const label = demandLabel(pricing);
  // Map the 0.5x..4x band onto a 0..1 value for the shared Meter so the floor sits low and demand fills it.
  const band = Math.max(0, Math.min(1, (mult - 0.5) / (4 - 0.5)));
  return (
    <Card>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2"><TrendingUp size={18} className="text-[var(--teal)]" /><h2 className="text-lg font-semibold">Live demand</h2></div>
        {!error && <Badge tone={label.tone}><span className="inline-block h-1.5 w-1.5 rounded-full bg-current" /> {label.text}</Badge>}
      </div>
      <p className="mt-1 text-sm text-muted">The price to answer a question floats with demand: open questions divided by providers online. More demand, fewer providers, higher price per answer.</p>

      {error ? (
        <div className="mt-3"><ErrorState message={error} onRetry={onRetry} /></div>
      ) : !pricing && loading ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-faint"><Spinner size={16} /> Reading the field price...</div>
      ) : (
        <>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="text-xs text-faint">Current answer price</div>
              <div className="mono text-3xl gradient-text leading-tight">{pricing ? formatZir(pricing.queryUZIR) : "..."}<span className="ml-1 text-base text-faint">ZIR</span></div>
              <div className="mt-0.5 text-[11px] text-faint">{pricing ? `${mult.toFixed(2)}x the floor price` : "reading the field"}</div>
            </div>
            <div className="grid grid-cols-2 gap-3 text-center">
              <div><div className="flex items-center justify-center gap-1 text-xs text-faint"><HelpCircle size={12} /> Open questions</div><div className="mono text-lg">{pricing?.openQueries ?? 0}</div></div>
              <div><div className="flex items-center justify-center gap-1 text-xs text-faint"><Users size={12} /> Providers online</div><div className="mono text-lg">{pricing?.providersOnline ?? 0}</div></div>
            </div>
          </div>

          <div className="mt-3">
            <div className="mb-1 flex justify-between text-[11px] text-faint"><span>0.5x floor</span><span>4x peak</span></div>
            <Meter value={band} />
            <p className="mt-2 text-[11px] text-faint">Price rises as open questions outpace providers online, and settles toward the floor when supply is ample. Every node computes the same fair number from the same field state.</p>
          </div>
        </>
      )}
    </Card>
  );
}

// The 3-contributor convergence gate, the single fact that determines whether mining pays. A node
// earns only when >=3 contributors converge on the field heartbeat; below the line it builds ZTI only.
// Also surfaces real field-health numbers already in the store (providers online, locks/min) and the
// "answers come from capable miners, not this CPU" point for coordination-only nodes.
function ConvergencePanel({ converged, convergenceMin, earningUnlocked, locksPerMinute, providersOnline, coordinationOnly, miningOn }: {
  converged: number; convergenceMin: number; earningUnlocked: boolean; locksPerMinute: number; providersOnline: number; coordinationOnly: boolean; miningOn: boolean;
}) {
  return (
    <Card>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2"><Users size={18} className="text-[var(--teal)]" /><h2 className="text-lg font-semibold">Field convergence</h2></div>
        <Badge tone={earningUnlocked ? "teal" : "warn"}>
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${earningUnlocked ? "animate-pulse" : ""} bg-current`} /> {earningUnlocked ? "earning live" : "below convergence"}
        </Badge>
      </div>
      <p className="mt-1 text-sm text-muted">A node earns paid ZIR only when the field has at least {convergenceMin} contributors converged on the heartbeat. Below that line, serving still builds ZTI but does not pay.</p>

      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between text-xs">
          <span className="text-faint">Contributors converged</span>
          <span className="mono text-text">{converged}/{convergenceMin}</span>
        </div>
        <Meter value={converged / convergenceMin} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <Stat label="Providers online" value={providersOnline} tone={providersOnline >= convergenceMin ? "teal" : "default"} />
        <Stat label="Locks / min" value={locksPerMinute} hint="work sealed" />
        <Stat label="Earning gate" value={earningUnlocked ? "open" : "closed"} tone={earningUnlocked ? "teal" : "warn"} />
      </div>

      {miningOn && coordinationOnly && (
        <div className="mt-3 rounded-lg border border-[color-mix(in_srgb,var(--indigo)_26%,var(--border))] bg-[color-mix(in_srgb,var(--indigo)_7%,transparent)] p-3 text-[11px] text-muted">
          This node coordinates the heartbeat; paid answers are produced by capable serving miners on the field, not on this machine's CPU. You still earn for the coordination work when the field is above the convergence line.
        </div>
      )}
    </Card>
  );
}

// Earnings panel: paid ZIR (demand) vs ZTI (earned trust from all accurate serving). The status badge
// reads from the single participation state so it never contradicts the other badges on the page.
function EarningsPanel({ answered, earnedTodayUZIR, balanceUZIR, zti, minerAddress }: { answered: number; earnedTodayUZIR: number; balanceUZIR: number; zti: number; minerAddress?: string | null }) {
  return (
    <Card>
      <div className="flex items-center gap-2"><WalletIcon size={18} className="text-[var(--teal)]" /><h2 className="text-lg font-semibold">Your earnings</h2></div>
      <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label="Answered" value={answered} />
        <Stat label="Earned (24h)" value={formatZir(earnedTodayUZIR)} tone="teal" />
        <Stat label="Balance (ZIR)" value={formatZir(balanceUZIR)} tone="teal" />
        <Stat label="Trust (ZTI)" value={zti.toFixed(2)} tone="indigo" />
      </div>
      {minerAddress && (
        <div className="mt-2 text-[11px] text-faint">This node earns into your wallet <span className="mono text-muted">{minerAddress.slice(0, 10)}…{minerAddress.slice(-6)}</span>. Emission, coordination payouts, and tips all land here.</div>
      )}
      <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2">
        <div className="rounded-lg border border-[color-mix(in_srgb,var(--teal)_24%,var(--border))] bg-[color-mix(in_srgb,var(--teal)_7%,transparent)] p-2.5">
          <div className="font-medium text-[var(--teal)]">Paid ZIR</div>
          <div className="mt-0.5 text-faint">Earned when your served work is paid: tips on answers and clients hiring, priced by live demand above.</div>
        </div>
        <div className="rounded-lg border border-[color-mix(in_srgb,var(--indigo)_24%,var(--border))] bg-[color-mix(in_srgb,var(--indigo)_7%,transparent)] p-2.5">
          <div className="font-medium text-[var(--indigo)]">ZTI from coordination</div>
          <div className="mt-0.5 text-faint">Free questions and zero-budget Resonator coordination do not pay ZIR. They build earned trust, so you rank higher and win more paid work over time.</div>
        </div>
      </div>
    </Card>
  );
}

// Answering visibility: the highest earning path. Shows whether this node answers with a model, how many
// answers it has contributed, and the honest hardware-to-earnings link. Answering pays coordination on TOP of
// the storage baseline, weighted by trust (ZTI) and agreement, and a stronger machine answers more and better.
function AnsweringPanel({ usingEndpoint, endpointModel, hasNativeModel, answered, hardwareName, earnedAnsweringUZIR }: {
  usingEndpoint: boolean; endpointModel?: string; hasNativeModel: boolean; answered: number; hardwareName: string; earnedAnsweringUZIR?: number;
}) {
  const answering = usingEndpoint || hasNativeModel;
  return (
    <Card>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2"><Sparkles size={18} className="text-[var(--teal)]" /><h2 className="text-lg font-semibold">Answering</h2></div>
        <Badge tone={answering ? "teal" : "neutral"}>{answering ? "active" : "not set up"}</Badge>
      </div>
      <p className="mt-1 text-sm text-muted">
        Answering the field's questions is the highest earning path. On top of the storage baseline you earn coordination pay for each answer that converges, weighted by your trust (ZTI) and how closely your answer agrees with the field. A divergent answer earns little; an accurate one earns more.
      </p>
      {answering ? (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2.5">
            <Stat label="Answers contributed" value={answered} tone="teal" />
            <Stat label="Earned answering" value={`${formatZir(earnedAnsweringUZIR ?? 0)} ZIR`} tone="teal" />
            <Stat label="Answering with" value={usingEndpoint ? (endpointModel || "field model") : "field model"} />
          </div>
          <p className="mt-3 rounded-lg border border-[color-mix(in_srgb,var(--teal)_24%,var(--border))] bg-[color-mix(in_srgb,var(--teal)_7%,transparent)] p-2.5 text-[11px] text-muted">
            <span className="font-medium text-[var(--teal)]">Stronger hardware earns more here.</span> A more capable machine runs a larger, better model and answers faster, so it wins more queries and produces higher-agreement answers, each worth a bigger slice. Running on {hardwareName}.
          </p>
        </>
      ) : (
        <p className="mt-3 rounded-lg border border-hairline bg-base p-2.5 text-[11px] text-muted">
          Turn on <span className="font-medium text-text">Storage</span> to receive the field's distributed model. Your node then answers on your own hardware automatically, with no external model needed. Coordination settles once at least two capable miners answer, so this earning path grows as more miners join the field.
        </p>
      )}
    </Card>
  );
}

// Short, honest explainer. Three bullets, no hype.
// Battery auto-pause (spec §3.4): pause mining when running on battery below a chosen threshold. Uses the
// Battery Status API, available in the Chromium/Electron desktop app (it is the one that actually mines);
// where the API is absent (no battery, or an unsupported browser) the control simply has no effect.
function BatteryPause({ miningEnabled, onPause }: { miningEnabled: boolean; onPause: () => void }) {
  const [on, setOn] = useState(() => { try { return localStorage.getItem("zira.mine.batteryPause") === "1"; } catch { return false; } });
  const [threshold, setThreshold] = useState(() => { try { return Number(localStorage.getItem("zira.mine.batteryThreshold")) || 20; } catch { return 20; } });
  const [level, setLevel] = useState<number | null>(null);
  const [charging, setCharging] = useState<boolean | null>(null);
  const save = (nextOn: boolean, nextThreshold: number) => {
    try { localStorage.setItem("zira.mine.batteryPause", nextOn ? "1" : "0"); localStorage.setItem("zira.mine.batteryThreshold", String(nextThreshold)); } catch { /* ignore */ }
  };
  useEffect(() => {
    if (!on) return;
    const getBattery = (navigator as unknown as { getBattery?: () => Promise<{ level: number; charging: boolean }> }).getBattery;
    if (!getBattery) return;
    let live = true;
    const tick = async () => {
      try {
        const b = await getBattery.call(navigator);
        if (!live) return;
        setLevel(b.level); setCharging(b.charging);
        if (miningEnabled && !b.charging && b.level * 100 < threshold) onPause();
      } catch { /* battery read failed; ignore */ }
    };
    void tick();
    const timer = setInterval(tick, 60_000);
    return () => { live = false; clearInterval(timer); };
  }, [on, threshold, miningEnabled, onPause]);
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <div><div className="text-sm font-medium text-text">Battery auto-pause</div><div className="text-xs text-faint">Pause mining when on battery below a threshold.{level !== null ? ` Battery ${(level * 100).toFixed(0)}%${charging ? " (charging)" : ""}.` : ""}</div></div>
        <Toggle on={on} onClick={() => { const v = !on; setOn(v); save(v, threshold); }} />
      </div>
      {on && (
        <div className="mt-3 flex items-center gap-2">
          <span className="text-xs text-faint">Pause below</span>
          <Input className="mono w-20" value={String(threshold)} onChange={(e) => { const v = Math.max(5, Math.min(95, Number(e.target.value) || 20)); setThreshold(v); save(on, v); }} />
          <span className="text-xs text-faint">% battery</span>
        </div>
      )}
    </Card>
  );
}

// Live field activity (spec §3.2): the terms/topics the field is converging on right now, from the Locks
// the store already refreshes. Auto-updates with the store poll; confidence shown as 1 - cv (tighter
// convergence = higher confidence). This is the activity the node helps seal as it serves.
function LiveActivity({ locks }: { locks: Lock[] }) {
  const sorted = [...locks].sort((a, b) => b.sealedAt - a.sealedAt);
  const recent = sorted.slice(0, 8);
  // Heartbeat freshness: if the newest seal is older than ~3 min the field is stale, so we drop the
  // pulsing "live" affordance for an honest "idle" instead of animating on a stalled node.
  const newest = sorted[0];
  const fresh = !!newest && Date.now() - newest.sealedAt < 3 * 60 * 1000;
  return (
    <Card>
      <div className="mb-2 flex items-center gap-2">
        <Radio size={16} className="text-[var(--teal)]" /><h3 className="text-sm font-semibold">Live field activity</h3>
        <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-faint">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${fresh ? "animate-pulse bg-[var(--teal)]" : "bg-[var(--text-faint)]"}`} /> {fresh ? "live" : newest ? "idle" : "waiting"}
        </span>
      </div>
      {newest && <div className="mb-2 text-[11px] text-faint">Last sealed {timeAgo(newest.sealedAt)}</div>}
      {recent.length === 0
        ? <p className="text-xs text-faint">Waiting for the field to seal activity. Topics the network converges on appear here as they happen.</p>
        : (
          <div className="divide-y divide-hairline">
            {recent.map((l) => {
              const conf = Math.max(0, Math.min(1, 1 - l.cv));
              return (
                <div key={l.id} className="flex items-center justify-between gap-2 py-1.5 text-xs">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5"><Badge tone="indigo" className="text-[10px]">{DOMAIN_META[l.domain]?.label ?? l.domain}</Badge><span className="truncate text-text">{l.subject}</span></div>
                    <div className="text-faint">{l.observationCount} observers · {timeAgo(l.sealedAt)}</div>
                  </div>
                  <span className="mono shrink-0 text-[var(--teal)]">{(conf * 100).toFixed(0)}%</span>
                </div>
              );
            })}
          </div>
        )}
      <p className="mt-2 text-[11px] text-faint">Terms and topics the field is converging on right now. Your node helps seal these as it serves.</p>
    </Card>
  );
}

// Period earnings history (spec §3.3): totals + events over 1H/24H/7D/30D, computed client-side from the
// address's signed tx history (coordination payouts, emission rewards, grants received). No backend change
// needed; the ledger already records every earning as a signed, public transaction.
const HISTORY_PERIODS = [
  { key: "1H", label: "1H", ms: 60 * 60 * 1000 },
  { key: "24H", label: "24H", ms: 24 * 60 * 60 * 1000 },
  { key: "7D", label: "7D", ms: 7 * 24 * 60 * 60 * 1000 },
  { key: "30D", label: "30D", ms: 30 * 24 * 60 * 60 * 1000 },
] as const;

function EarningsHistory({ address }: { address: string | null }) {
  const { client } = useZira();
  const nodeBehind = useZira((s) => s.nodeBehind);
  const [history, setHistory] = useState<SignedTx[]>([]);
  const [period, setPeriod] = useState<(typeof HISTORY_PERIODS)[number]["key"]>("24H");
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    if (client && address) {
      setLoading(true); setError(null);
      // Reconcile against the network gateway when the local node is behind, so a lagging home miner's
      // earnings history is never under-reported here (the tab where a miner most wants to see it).
      loadReconciledHistory(client, address, 500, nodeBehind)
        .then((h) => { if (live) { setHistory(h); setError(null); } })
        .catch((e) => { if (live) setError(e instanceof Error ? e.message : "Could not load earnings history."); })
        .finally(() => { if (live) setLoading(false); });
    }
    return () => { live = false; };
  }, [client, address, reload, nodeBehind]);

  const active = HISTORY_PERIODS.find((p) => p.key === period)!;
  const earned = useMemo(() => {
    const now = Date.now();
    return history
      .filter((tx) => (tx.to === address || tx.kind === "reward" || tx.kind === "reserve_grant")
        && tx.kind !== "bond_burn" && (tx.amountUZIR ?? 0) > 0
        && typeof tx.timestamp === "number" && now - tx.timestamp <= active.ms)
      .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  }, [history, address, active]);
  const total = earned.reduce((s, tx) => s + (tx.amountUZIR ?? 0), 0);
  const label = (tx: SignedTx) => tx.kind === "reward" ? "Emission reward" : tx.kind === "reserve_grant" ? "Reserve grant" : "Coordination payout";

  return (
    <Card>
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2"><HistoryIcon size={16} className="text-[var(--teal)]" /><h3 className="text-sm font-semibold">Earnings history</h3></div>
        <div className="flex gap-1 rounded-lg border border-hairline bg-base/70 p-0.5">
          {HISTORY_PERIODS.map((p) => (
            <button key={p.key} onClick={() => setPeriod(p.key)}
              className={cn("rounded px-2 py-0.5 text-xs transition-colors", period === p.key ? "bg-[var(--accent)] text-[var(--accent-contrast)]" : "text-muted hover:text-text")}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {error ? (
        <ErrorState message={error} onRetry={() => setReload((n) => n + 1)} />
      ) : loading && history.length === 0 ? (
        <div className="flex items-center gap-2 py-2 text-sm text-faint"><Spinner size={16} /> Loading earnings history...</div>
      ) : (
        <>
      <div className="grid grid-cols-2 gap-2.5">
        <Stat label={`ZIR earned · ${active.label}`} value={formatZir(total)} tone="teal" />
        <Stat label={`Earning events · ${active.label}`} value={earned.length} />
      </div>
      {earned.length === 0
        ? <p className="mt-2 text-xs text-faint">No paid earnings in this window yet. Coordination payouts and emission rewards appear here as the field settles your work.</p>
        : (
          <>
            <button onClick={() => setExpanded((v) => !v)} className="mt-2 text-xs text-[var(--teal)] hover:underline">{expanded ? "Hide" : "Show"} {earned.length} event{earned.length === 1 ? "" : "s"}</button>
            {expanded && (
              <div className="mt-2 divide-y divide-hairline">
                {earned.slice(0, 60).map((tx, i) => (
                  <div key={tx.id ?? i} className="flex items-center justify-between py-1.5 text-xs">
                    <div><span className="text-text">{label(tx)}</span><div className="text-faint">{tx.timestamp ? timeAgo(tx.timestamp) : ""}{tx.memo ? " · " + tx.memo.slice(0, 36) : ""}</div></div>
                    <span className="mono text-[var(--teal)]">+{formatZir(tx.amountUZIR ?? 0)}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
        </>
      )}
    </Card>
  );
}

function HowYouEarn() {
  return (
    <Card>
      <div className="flex items-center gap-2"><HelpCircle size={18} className="text-[var(--teal)]" /><h2 className="text-lg font-semibold">How you earn</h2></div>
      <ul className="mt-2 space-y-2 text-sm text-muted">
        <li className="flex gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--teal)]" /><span>Turning on mining makes this node serve the field. It answers questions and coordinates work for other Resonators.</span></li>
        <li className="flex gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--teal)]" /><span>You earn ZIR when served work is paid. Askers tip for answers and clients pay to hire, both priced by live demand. Higher demand means a higher price per answer.</span></li>
        <li className="flex gap-2"><span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--indigo)]" /><span>An idle field with no paid demand earns little ZIR. Accurate serving still builds ZTI, the long game that wins you more paid work later.</span></li>
      </ul>
    </Card>
  );
}

export function Mine() {
  const toast = useToast();
  const { mode, isFounder, stats, balanceUZIR, hardware, nodeConfig, providerStatus, mining, localLaunchMiners, zti, address, locks, client,
    minerAddress, minerBalanceUZIR, nodeBehind, setMining, refreshStatus } = useZira();
  // Earnings shown here are read from the ledger (the authoritative source the wallet and Earnings history
  // use), not from provider inference counters, a coordination node earns emission/coordination payouts
  // that never touch the inference counter, so those must come from the signed ledger to be truthful.
  const [earned24hUZIR, setEarned24hUZIR] = useState(0);
  useEffect(() => {
    if (!client || !address) { setEarned24hUZIR(0); return; }
    let live = true;
    const pull = () => {
      loadReconciledHistory(client, address, 200, nodeBehind)
        .then((h) => {
          if (!live) return;
          const now = Date.now();
          const total = h.filter((tx) => (tx.to === address || tx.kind === "reward" || tx.kind === "reserve_grant")
            && tx.kind !== "bond_burn" && (tx.amountUZIR ?? 0) > 0
            && typeof tx.timestamp === "number" && now - tx.timestamp <= 24 * 60 * 60 * 1000)
            .reduce((s, tx) => s + (tx.amountUZIR ?? 0), 0);
          setEarned24hUZIR(total);
        })
        .catch(() => { /* keep last value */ });
    };
    pull();
    // Refresh on a slow, fixed cadence instead of on every balance tick, so a steadily-earning miner does
    // not re-pull the full history several times a second.
    const t = setInterval(pull, 30_000);
    return () => { live = false; clearInterval(t); };
  }, [client, address, nodeBehind]);
  // Lifetime ZIR this address earned by ANSWERING the field (coordination payouts), derived on-chain by the
  // node the same way as the Explorer answerer leaderboard. Slow cadence: it changes only when a query settles.
  const [earnedAnsweringUZIR, setEarnedAnsweringUZIR] = useState(0);
  useEffect(() => {
    if (mode !== "node" || !address) { setEarnedAnsweringUZIR(0); return; }
    let live = true;
    const pull = () => { NodeApi.answererEarnings(address).then((r) => { if (live) setEarnedAnsweringUZIR(r.earnedUZIR ?? 0); }).catch(() => { /* keep last */ }); };
    pull();
    const t = setInterval(pull, 30_000);
    return () => { live = false; clearInterval(t); };
  }, [mode, address]);
  const [busy, setBusy] = useState(false);
  const [hardwareBusy, setHardwareBusy] = useState(false);
  const [storageLimit, setStorageLimit] = useState("1");
  const [gpuLayers, setGpuLayers] = useState("0");
  const [threads, setThreads] = useState("4");
  const [autoHardwareScan, setAutoHardwareScan] = useState(false);
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [pricingLoading, setPricingLoading] = useState(true);
  const [pricingReload, setPricingReload] = useState(0);
  const [showIdleMiners, setShowIdleMiners] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  // Live demand-driven price. Refresh on a short cadence so the demand panel reflects the field.
  // Track error/loading so an unreachable /pricing surfaces a retry instead of looking like zero demand.
  usePoll(() => {
    NodeApi.pricing()
      .then((p) => { setPricing(p); setPricingError(null); })
      .catch((e) => setPricingError(e instanceof Error ? e.message : "Could not read live pricing from the node."))
      .finally(() => setPricingLoading(false));
  }, 5000, [pricingReload]);

  useEffect(() => { void refreshStatus(); }, [refreshStatus]);
  useEffect(() => {
    // Prefer the authoritative byte cap; fall back to the legacy GB field. Show it as whole GB in the input.
    const capGb = mining?.storageCapBytes ? Math.max(1, Math.round(mining.storageCapBytes / 1024 ** 3)) : mining?.storageLimitGb;
    if (capGb) setStorageLimit(String(capGb));
  }, [mining?.storageCapBytes, mining?.storageLimitGb]);
  useEffect(() => {
    if (mining) {
      setGpuLayers(String(mining.gpuLayers ?? hardware?.recommendedGpuLayers ?? 0));
      setThreads(String(mining.threads ?? hardware?.recommendedThreads ?? 4));
    }
  }, [mining?.gpuLayers, mining?.threads, hardware?.recommendedGpuLayers, hardware?.recommendedThreads]);
  useEffect(() => {
    if (mode === "node" && !hardware && !autoHardwareScan) {
      setAutoHardwareScan(true);
      setHardwareBusy(true);
      NodeApi.refreshHardware()
        .then(() => refreshStatus())
        .catch(() => {})
        .finally(() => setHardwareBusy(false));
    }
  }, [mode, hardware, autoHardwareScan, refreshStatus]);

  if (!isDesktop()) {
    return (
      <div className="p-6">
        <EmptyState title="Mining is desktop only" hint="Android can use Wallet, Console, Explorer, Resonators, and Discover. Mining is disabled on Android so phones do not try to run GGUF models or node workloads.">
          <HexField size={110} />
        </EmptyState>
      </div>
    );
  }

  if (mode !== "node") {
    return (
      <div className="p-6">
        <EmptyState title="Connect to your node to participate" hint="Running a node, mining, and earning happen on a ZIRA node. Open the Console from your own node (the desktop app runs one for you) to manage participation here.">
          <HexField size={110} />
        </EmptyState>
      </div>
    );
  }

  async function setObserve(on: boolean) {
    setBusy(true);
    try { await NodeApi.setStatus({ nodeConfig: { observeEnabled: on } }); await refreshStatus(); toast.push(on ? "Observing the field." : "Observation paused (relay only)."); }
    catch (e) { toast.push(e instanceof Error ? e.message : "could not update node", "danger"); }
    finally { setBusy(false); }
  }

  // The hardware control for the field. Mutually exclusive:
  //   "field" -> mine for the field (serve others, earn). Existing mining semantics, unchanged.
  //   "off"   -> do not lend this machine to the field. Field mode still works via the network.
  // Using your own hardware for your own tasks is set in the Console (Local mode), not here.
  async function setHardwareMode(next: "field" | "off") {
    setBusy(true);
    try {
      // "off" disables BOTH mining and storage so the node fully disengages: no serving, no vouch, no earning.
      // Leaving storage on after mining-off kept the node "committed" (it still earned via the liveness vouch),
      // which read as "mine off but still on". "field" enables mining, which auto-enables storage server-side.
      if (next === "field") await setMining({ enabled: true });
      else await setMining({ enabled: false, storageEnabled: false });
      await refreshStatus();
      toast.push(next === "field"
        ? "Mining on. Serving the field and earning when work is paid."
        : "Not lending this machine to the field. Field mode still works over the network.");
    } catch (e) { toast.push(e instanceof Error ? e.message : "could not update hardware use", "danger"); }
    finally { setBusy(false); }
  }


  async function rescanHardware() {
    setHardwareBusy(true);
    try { await NodeApi.refreshHardware(); await refreshStatus(); toast.push("Hardware profile refreshed."); }
    catch (e) { toast.push(e instanceof Error ? e.message : "hardware scan failed", "danger"); }
    finally { setHardwareBusy(false); }
  }

  // Storage is its own user-controllable toggle with a byte cap (default 1 GiB). The GB input is just a
  // friendly view of the cap; we convert to bytes for the dedicated /storage RPC. When enabling, we never
  // set the cap below what is already cached, so verified bytes are not immediately evicted.
  async function updateStorage(on = mining?.storageEnabled ?? false) {
    const usedGb = Math.ceil((mining?.storageUsedBytes ?? 0) / 1024 ** 3);
    const limitGb = Math.max(on ? Math.max(1, usedGb) : 1, Math.min(4096, Number(storageLimit) || 1));
    const capBytes = limitGb * 1024 ** 3;
    setBusy(true);
    try {
      await NodeApi.setStorage({ enabled: on, capBytes });
      await refreshStatus();
      toast.push(on ? (limitGb !== Number(storageLimit) ? `Storage on. Cap raised to ${limitGb} GB to cover what is already cached.` : "Storage on. Sharing authorized bytes with peers.") : "Storage off. This node no longer advertises or replicates peer storage.");
      setStorageLimit(String(limitGb));
    }
    catch (e) { toast.push(e instanceof Error ? e.message : "could not update storage", "danger"); }
    finally { setBusy(false); }
  }

  async function emptyStorage() {
    setBusy(true);
    try {
      const r = await NodeApi.clearStorage();
      await refreshStatus();
      const gb = ((r.freedBytes ?? 0) / 1024 ** 3).toFixed(2);
      toast.push(r.cleared ? `Cleared ${r.cleared} stored model(s), freed ${gb} GB. Storage re-fills from the field up to your cap.` : "Nothing to clear (only the model in use is kept).");
    }
    catch (e) { toast.push(e instanceof Error ? e.message : "could not clear storage", "danger"); }
    finally { setBusy(false); }
  }

  async function updateLocalTaskPermission(on = !(mining?.localTaskPermission ?? false)) {
    setBusy(true);
    try {
      await setMining({ localTaskPermission: on });
      await refreshStatus();
      toast.push(on ? "Workspace task permission enabled for the field." : "Workspace task permission disabled.");
    } catch (e) { toast.push(e instanceof Error ? e.message : "could not update workspace task permission", "danger"); }
    finally { setBusy(false); }
  }

  async function saveHardwareUse(useRecommended = false) {
    const maxThreads = Math.max(1, hardware?.cpuCores ?? 128);
    const nextGpuLayers = Math.max(0, Math.min(100, Number(gpuLayers) || 0));
    const nextThreads = Math.max(1, Math.min(maxThreads, Number(threads) || 1));
    setBusy(true);
    try {
      await setMining({
        gpuLayers: useRecommended ? (hardware?.recommendedGpuLayers ?? nextGpuLayers) : nextGpuLayers,
        threads: useRecommended ? (hardware?.recommendedThreads ?? nextThreads) : nextThreads,
        useRecommendedHardware: useRecommended,
      });
      await refreshStatus();
      toast.push(useRecommended ? "Using detected hardware recommendation." : "Mining hardware use saved.");
    } catch (e) { toast.push(e instanceof Error ? e.message : "could not update hardware use", "danger"); }
    finally { setBusy(false); }
  }

  async function saveMaximumHardwareUse() {
    const maxThreads = Math.max(1, hardware?.cpuCores ?? 128);
    const maxGpuLayers = Math.max(0, Math.min(100, hardware?.recommendedGpuLayers ?? (Number(gpuLayers) || 0)));
    setBusy(true);
    try {
      await setMining({
        gpuLayers: maxGpuLayers,
        threads: maxThreads,
        useRecommendedHardware: false,
      });
      setGpuLayers(String(maxGpuLayers));
      setThreads(String(maxThreads));
      await refreshStatus();
      toast.push("Maximum detected mining hardware use saved.");
    } catch (e) { toast.push(e instanceof Error ? e.message : "could not apply maximum hardware use", "danger"); }
    finally { setBusy(false); }
  }

  const peers = stats?.activeNodes ?? 0;
  const usingEndpoint = !!mining?.endpoint;
  const ready = mining?.serving ?? false;
  // The three mutually exclusive hardware states. Mining (field serving) takes precedence in the label
  // when both flags happen to be set; "own" is local-only inference; otherwise "off".
  const hardwareMode: "field" | "off" = mining?.enabled ? "field" : "off";
  const knownModels = mining?.known ?? [];
  const hasKnownModels = knownModels.length > 0;
  const fieldReady = knownModels.some((m) => m.ready);
  const hasLocalModelCache = (mining?.storageUsedBytes ?? 0) > 0;
  const canMineSomehow = mining?.enabled ?? false;
  const intelligenceScore = miningIntelligenceScore({ mining, hardware, models: knownModels, peers, usingEndpoint });
  const contributionLabel = miningContributionLabel({ mining, usingEndpoint, fieldReady });
  const coordinationOnly = ready && mining?.answerLabel === "field-coordinator";
  const lane = earningLane({ mining, usingEndpoint, coordinationOnly, fieldReady });
  const earningMiners = localLaunchMiners.filter((m) => m.mining && m.serving && m.providerReachable);
  const launchSettlementDailyCapUZIR = 20_000_000;
  const cappedLaunchMiners = localLaunchMiners.filter((m) => !m.isFounder && m.earnedTodayUZIR >= launchSettlementDailyCapUZIR);
  const founderMiningWithoutRewards = isFounder && (mining?.enabled ?? false) && providerStatus.earnedTodayUZIR === 0;
  const localLaunchEarnedUZIR = localLaunchMiners.reduce((sum, m) => sum + (m.earnedTodayUZIR ?? 0), 0);
  const localLaunchAnswers = localLaunchMiners.reduce((sum, m) => sum + (m.queriesAnswered ?? 0), 0);

  // The 3-contributor convergence gate: a node earns ONLY when >=3 contributors converge on the field
  // heartbeat. Prefer the authoritative store stats; fall back to live pricing's provider count.
  const convergenceMin = 3;
  const providersOnline = Math.max(stats?.providersOnline ?? 0, pricing?.providersOnline ?? 0);
  const locksPerMinute = stats?.locksPerMinute ?? 0;
  const convergedContributors = Math.max(peers, providersOnline);
  const earningUnlocked = convergedContributors >= convergenceMin;
  // One source of truth for the node's earning state so every badge agrees.
  const state = participationState({ mining, usingEndpoint, coordinationOnly, earningUnlocked });

  // Local-launch miners view: sort top earners first; hide idle rows (no mining, nothing earned) unless
  // the operator opts to show them, so a growing mesh stays an operations view rather than a wall of zeros.
  const isIdleMiner = (m: (typeof localLaunchMiners)[number]) => !m.mining && (m.earnedTodayUZIR ?? 0) === 0;
  const localMinerRows = useMemo(() => {
    const visible = showIdleMiners ? localLaunchMiners : localLaunchMiners.filter((m) => !isIdleMiner(m));
    return [...visible].sort((a, b) => (b.earnedTodayUZIR ?? 0) - (a.earnedTodayUZIR ?? 0) || (b.balanceUZIR ?? 0) - (a.balanceUZIR ?? 0));
  }, [localLaunchMiners, showIdleMiners]);
  const idleMinerCount = localLaunchMiners.filter(isIdleMiner).length;

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-6">
      <PageHeader
        title="Mine"
        description="Lend this machine to the network and earn ZIR when the work it helps with is paid."
        badge={<Badge tone={state.tone}><span className="inline-block h-1.5 w-1.5 rounded-full bg-current" /> {state.label}</Badge>}
      />

      <TierHeader label="Your participation" hint="State, hardware, convergence, and earnings" />
      <Card className="field-hero">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.2em] text-[var(--teal)]"><Sparkles size={14} /> ZIRA field</div>
          <h2 className="title-glow mt-1 text-xl font-semibold text-text">Earn ZIR by lending your machine to the network</h2>
          <p className="mt-1 text-sm text-muted">Mining puts your machine to work helping the network answer questions. You don&apos;t need an AI model or spare storage to start. Running a model and sharing storage are separate, optional add-ons.</p>
        </div>
        <div className="mt-4 grid gap-2 text-xs sm:grid-cols-3">
          <div className="rounded-lg border border-hairline bg-surface/70 p-3"><div className="flex items-center gap-1 font-medium text-text"><Radio size={13} /> Coordination</div><div className="mt-1 text-faint">{peers} peers, {providersOnline} providers, {locksPerMinute} locks/min</div></div>
          <div className="rounded-lg border border-hairline bg-surface/70 p-3"><div className="flex items-center gap-1 font-medium text-text"><Boxes size={13} /> Models (optional)</div><div className="mt-1 text-faint">{knownModels.length} known, {knownModels.filter((m) => m.ready).length} ready, {mining?.enabled && (usingEndpoint || mining?.loadedModel) ? "serving here" : "not serving here"}</div></div>
          <div className="rounded-lg border border-hairline bg-surface/70 p-3"><div className="flex items-center gap-1 font-medium text-text"><Link2 size={13} /> Storage (optional)</div><div className="mt-1 text-faint">{mining?.storageEnabled ? `on, ${formatBytes(mining?.storageUsedBytes ?? 0)} cached` : "off"}, workspace tasks {mining?.enabled && mining?.localTaskPermission ? "allowed" : "off"}</div></div>
        </div>
      </Card>

      {/* Onboarding-critical: while the field model is downloading, mining shows 0 earnings. Explain the
          exact phase so users don't think it's broken. Hidden once the node is holding+earning. */}
      <MiningReadyBanner mining={mining} earning={(balanceUZIR ?? 0) > 0} />

      {/* Earnings: paid ZIR vs ZTI from coordination, honestly distinguished. */}
      <EarningsPanel
        answered={(mining?.answered ?? 0) + localLaunchAnswers}
        earnedTodayUZIR={earned24hUZIR}
        balanceUZIR={balanceUZIR || minerBalanceUZIR}
        zti={zti}
        minerAddress={minerAddress}
      />

      {/* Your hardware: one simple control. Mine for the field or off, with one-click Engage maximum. */}
      <Card>
        <div className="flex items-center gap-2"><Cpu size={18} className="text-[var(--indigo)]" /><h2 className="text-lg font-semibold">Your hardware</h2></div>
        <p className="mt-1 text-sm text-muted">Mining gives your hardware's work to the field's coordination, no model or storage required, and earns ZIR when that work is paid. Or use this machine only for your own tasks, or turn local inference off. These are separate: you can run your own tasks without ever mining.</p>

        <HardwareModeControl
          mode={hardwareMode}
          busy={busy}
          hardwareName={hardwareTitle(hardware)}
          usingEndpoint={usingEndpoint}
          endpointModel={mining?.endpointModel}
          fieldDetail={lane.title.toLowerCase()}
          onPick={setHardwareMode}
        />

        {/* Hardware-engaged summary: makes it concrete that mining puts the whole machine to work, and puts
            "Engage maximum" one click away instead of buried in advanced settings. Shown only while mining. */}
        {mining?.enabled && (
          <div className="mt-3 rounded-xl border border-[color-mix(in_srgb,var(--indigo)_24%,var(--border))] bg-[color-mix(in_srgb,var(--indigo)_6%,transparent)] p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-sm font-medium text-text"><Cpu size={15} className="text-[var(--indigo)]" /> Hardware engaged</div>
              <Badge tone="indigo" className="text-[10px] uppercase tracking-wide">{hardware?.capabilityTier ?? "detecting"}</Badge>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              <Stat label="Machine" value={<span className="text-sm">{hardwareTitle(hardware)}</span>} />
              <Stat label="CPU threads" value={`${mining?.threads ?? 0} / ${hardware?.cpuCores ?? "?"}`} tone="indigo" hint="cores at work" />
              <Stat label="GPU layers" value={mining?.gpuLayers ?? 0} tone="indigo" hint={hardware?.gpuName ? "on GPU" : "CPU only"} />
            </div>
            {hardware?.cpuCores ? (
              <div className="mt-2">
                <div className="mb-1 flex justify-between text-[11px] text-faint">
                  <span>capacity engaged</span>
                  <span className="mono">{Math.round(100 * Math.min(1, (mining?.threads ?? 0) / Math.max(1, hardware.cpuCores)))}%</span>
                </div>
                <Meter value={Math.min(1, (mining?.threads ?? 0) / Math.max(1, hardware.cpuCores))} />
              </div>
            ) : null}
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <Button variant="secondary" onClick={() => void saveMaximumHardwareUse()} disabled={busy}>Engage maximum</Button>
              <span className="text-[11px] text-faint">Put every available core and GPU layer to work for stronger throughput and rewards.</span>
            </div>
          </div>
        )}

      </Card>

      {/* Field convergence: the 3-contributor earning gate, the single health panel that decides whether mining pays. */}
      <ConvergencePanel
        converged={convergedContributors}
        convergenceMin={convergenceMin}
        earningUnlocked={earningUnlocked}
        locksPerMinute={locksPerMinute}
        providersOnline={providersOnline}
        coordinationOnly={coordinationOnly}
        miningOn={Boolean(mining?.enabled)}
      />

      {/* Live field activity: terms/topics the field is converging on right now. */}
      <LiveActivity locks={locks} />

      {/* Answering visibility: the highest earning path, shown only when mining is on. */}
      {(mining?.enabled ?? false) && (
        <AnsweringPanel
          usingEndpoint={usingEndpoint}
          endpointModel={mining?.endpointModel}
          hasNativeModel={Boolean(mining?.loadedModel)}
          answered={(mining?.answered ?? 0) + localLaunchAnswers}
          hardwareName={hardwareTitle(hardware)}
          earnedAnsweringUZIR={earnedAnsweringUZIR}
        />
      )}

      {/* Period earnings history: 1H / 24H / 7D / 30D, computed from the signed ledger. */}
      <EarningsHistory address={address} />

      {/* Details and add-ons: live economics, node consensus, hardware tuning, model serving, storage, and
          steward tools. Collapsed by default so the main flow stays to what a contributor needs first. */}
      <button
        onClick={() => setShowDetails((v) => !v)}
        className="flex w-full items-center justify-between rounded-xl border border-hairline bg-surface/60 px-4 py-3 text-sm font-medium text-text transition-colors hover:border-hairline-strong"
      >
        <span className="flex items-center gap-2"><Cpu size={16} className="text-[var(--indigo)]" /> Details and add-ons</span>
        <span className="text-xs text-faint">{showDetails ? "Hide" : "Show"}</span>
      </button>

      {showDetails && (
        <div className="space-y-5">
      {/* Live, demand-driven economics. */}
      <DemandPanel pricing={pricing} error={pricingError} loading={pricingLoading} onRetry={() => { setPricingLoading(true); setPricingReload((n) => n + 1); }} />

      {/* Node: always on while ZIRA runs. Consensus + observation. */}
      <Card>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2"><ShieldCheck size={18} className="text-[var(--teal)]" /><h2 className="text-lg font-semibold">Node</h2></div>
          <Badge tone="teal"><span className="inline-block h-1.5 w-1.5 rounded-full bg-current" /> Active</Badge>
        </div>
        <p className="mt-1 text-sm text-muted">You&apos;re already part of the network. Your node helps keep the shared ledger honest. No graphics card or AI model needed, and it runs whenever ZIRA is open.</p>
        <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          <Stat label="Trust (ZTI)" value={zti.toFixed(2)} />
          <Stat label="Earned (24h)" value={formatZir(earned24hUZIR)} tone="teal" />
          <Stat label="Network peers" value={peers} />
        </div>
        <div className="mt-3 flex items-center justify-between rounded-lg border border-hairline bg-base px-3 py-2">
          <div className="text-xs"><div className="font-medium text-text">Submit observations</div><div className="text-faint">Earn consensus rewards for accurate measurements. Off = pure relay.</div></div>
          <Toggle on={nodeConfig.observeEnabled} onClick={() => setObserve(!nodeConfig.observeEnabled)} disabled={busy} />
        </div>
      </Card>

      {/* Mining details: engine, hardware, models, storage, and steward controls. */}
      <Card>
        <div className="flex items-center gap-2"><Cpu size={18} className="text-[var(--indigo)]" /><h2 className="text-lg font-semibold">Mining details</h2></div>
        <p className="mt-1 text-sm text-muted">Coordination is the base. Your hardware relays signed work, submits observations, and helps converge Resonator and model outputs by earned trust. Serving a model and sharing storage are independent add-ons below; neither is required to mine.</p>

        <div className="mt-3 rounded-xl border border-[color-mix(in_srgb,var(--teal)_24%,var(--border))] bg-[radial-gradient(circle_at_top_left,color-mix(in_srgb,var(--teal)_14%,transparent),transparent_36%),var(--bg-base)] p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-xs font-medium text-text"><Sparkles size={14} className="text-[var(--teal)]" /> Coordination strength</div>
            <span className="mono text-2xl gradient-text">{intelligenceScore}</span>
          </div>
          <div className="mt-2"><Meter value={intelligenceScore / 100} /></div>
          <div className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
            <div className="rounded-lg border border-hairline bg-surface/70 p-2"><div className="text-faint">Contribution</div><div className="font-medium text-text">{contributionLabel}</div></div>
            <div className="rounded-lg border border-hairline bg-surface/70 p-2"><div className="text-faint">Continuity</div><div className="font-medium text-text">{peers >= 2 ? "multi-peer" : peers === 1 ? "one peer" : "solo"}</div></div>
            <div className="rounded-lg border border-hairline bg-surface/70 p-2"><div className="text-faint">Model serving</div><div className="font-medium text-text">{coordinationOnly ? "coordination only" : ready ? "answering" : usingEndpoint ? "field model" : mining?.loadedModel ? "field model" : "not serving"}</div></div>
          </div>
        </div>

        {localLaunchMiners.length > 1 && (
          <div className="mt-3 rounded-lg border border-[color-mix(in_srgb,var(--teal)_24%,var(--border))] bg-[color-mix(in_srgb,var(--teal)_7%,transparent)] p-3 text-xs">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div>
                <div className="font-medium text-text">Local launch miners</div>
                <div className="text-faint">Aggregate from the local multi-node mesh. The steward/bootstrap wallet pays launch settlements; non-steward miner roles earn them when they answer model-backed work.</div>
              </div>
              <Badge tone={earningMiners.length ? "teal" : "neutral"}>{earningMiners.length}/{localLaunchMiners.length} earning</Badge>
            </div>
            <div className="grid grid-cols-3 gap-2.5">
              <Stat label="Answers" value={localLaunchAnswers} />
              <Stat label="Earned today" value={formatZir(localLaunchEarnedUZIR)} tone="teal" />
              <Stat label="Serving miners" value={earningMiners.length} />
            </div>
            {idleMinerCount > 0 && (
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-faint">{idleMinerCount} idle miner{idleMinerCount === 1 ? "" : "s"} hidden</span>
                <button onClick={() => setShowIdleMiners((v) => !v)} className="text-[var(--teal)] hover:underline">{showIdleMiners ? "Hide idle" : "Show idle"}</button>
              </div>
            )}
            {localMinerRows.length === 0 ? (
              <div className="mt-2 rounded-md border border-hairline bg-surface/60 px-2 py-2 text-faint">
                No local miners answering yet. They earn once the field has {convergenceMin}+ converged contributors and they answer model-backed work.
              </div>
            ) : (
            <div className="mt-2 grid gap-1">
              {localMinerRows.map((m) => {
                const roleNote = m.isFounder
                  ? "steward payer"
                  : m.earnedTodayUZIR >= launchSettlementDailyCapUZIR
                    ? "daily cap"
                    : m.providerActive && !m.providerReachable
                      ? "endpoint offline"
                      : !m.providerActive && m.mining
                        ? "coordination only"
                        : m.mining
                          ? "eligible when answering"
                          : "idle";
                return (
                  <div key={m.port} className="flex items-center justify-between rounded-md border border-hairline bg-surface/60 px-2 py-1">
                    <span className="text-faint">:{m.port} {m.answerLabel || (m.mining ? "coordinating" : "idle")} <span className="text-[var(--teal)]">({roleNote})</span></span>
                    <span className="mono text-text">{formatZir(m.earnedTodayUZIR)} / {formatZir(m.balanceUZIR)} bal</span>
                  </div>
                );
              })}
            </div>
            )}
            {(founderMiningWithoutRewards || cappedLaunchMiners.length > 0) && (
              <div className="mt-2 rounded-md border border-[color-mix(in_srgb,var(--warn)_32%,var(--border))] bg-[color-mix(in_srgb,var(--warn)_7%,transparent)] p-2 text-faint">
                {founderMiningWithoutRewards
                  ? "Your steward node can coordinate, store, and answer if its endpoint is reachable, but launch-miner ZIR settlements are paid from the steward wallet to non-steward miner wallets. Use a non-steward miner role for visible mining income."
                  : "Some local miner roles reached the current launch settlement daily cap. They can keep answering and building ZTI, but new steward-funded settlement ZIR resumes after the cap window resets or the cap is raised."}
              </div>
            )}
          </div>
        )}

        {mining?.enabled && coordinationOnly && (
          <div className="mt-3 rounded-lg border border-hairline bg-base p-3 text-xs text-muted">
            This machine is coordinating the field now: signed relay, observations, and converging Resonator and model outputs by trust. Earning more ZIR is optional, turn on Serve a model below to answer paid queries directly.
          </div>
        )}

        <div className="mt-3 rounded-lg border border-hairline bg-base p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-medium text-text"><Cpu size={14} /> Hardware intelligence</div>
            <Badge tone={hardware?.recommendedMode === "gpu" ? "teal" : hardware?.recommendedMode === "cpu" ? "indigo" : "neutral"}>{hardware?.recommendedMode ?? "scanning"}</Badge>
          </div>
          <HardwarePanel hardware={hardware} onRefresh={rescanHardware} refreshing={hardwareBusy} />
          <div className="mt-3 grid gap-2.5 sm:grid-cols-3">
            <Stat label="Applied GPU layers" value={mining?.gpuLayers ?? hardware?.recommendedGpuLayers ?? 0} />
            <Stat label="Applied CPU threads" value={mining?.threads ?? hardware?.recommendedThreads ?? 0} />
            <Stat label="Tuning mode" value={mining?.useRecommendedHardware === false ? "manual" : "adaptive"} />
          </div>
          <div className="mt-3 rounded-lg border border-hairline bg-surface/60 p-3">
            <div className="mb-2 text-xs font-medium text-text">Adjust mining hardware use</div>
            <div className="grid gap-2 sm:grid-cols-2">
              <Field label="GPU layers" hint="0 = CPU only. Higher uses more VRAM.">
                <Input className="mono" type="number" min={0} max={100} value={gpuLayers} onChange={(e) => setGpuLayers(e.target.value)} />
              </Field>
              <Field label="CPU threads" hint={`1 to ${hardware?.cpuCores ?? "available"} threads.`}>
                <Input className="mono" type="number" min={1} max={hardware?.cpuCores ?? 128} value={threads} onChange={(e) => setThreads(e.target.value)} />
              </Field>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => saveHardwareUse(false)} disabled={busy}>Save manual use</Button>
              <Button variant="ghost" onClick={() => saveHardwareUse(true)} disabled={busy || !hardware}>Use detected recommendation</Button>
              <Button variant="ghost" onClick={saveMaximumHardwareUse} disabled={busy || !hardware}>Use maximum detected</Button>
            </div>
            <p className="mt-2 text-[11px] text-faint">Recommendation is safer for everyday use. Maximum detected uses all CPU threads and the detected GPU offload estimate; use it only when you intentionally want this node to mine as hard as this machine can.</p>
          </div>
        </div>

        {/* Optional add-on: Serve a model. Independent of coordination and of storage. */}
        <div className="mt-3 rounded-lg border border-hairline bg-base p-3">
          <div className="mb-1 flex items-center gap-2 text-xs font-medium text-text"><Boxes size={14} className="text-[var(--indigo)]" /> Serve a model <span className="font-normal text-faint">optional add-on</span></div>
          <p className="text-[11px] text-faint">Layer answer-serving on top of coordination to earn more when queries are paid. Only the steward authorizes models; they then arrive peer to peer. When an authorized model is cached here and the native engine is installed, this machine serves it automatically. Serving needs neither storage nor your own tasks mode.</p>
          <FieldModelsView models={knownModels} recommendedId={mining?.recommendedModelId ?? null} />
          {!hasKnownModels && hasLocalModelCache && (
            <div className="mt-2 rounded-lg border border-[color-mix(in_srgb,var(--warn)_35%,transparent)] bg-[color-mix(in_srgb,var(--warn)_7%,transparent)] p-3 text-xs text-muted">
              This node has {formatBytes(mining?.storageUsedBytes ?? 0)} in its local model cache, but no authorized field model is currently announced on this network. This can happen after switching networks or testing earlier model links. Start fresh from genesis removes the cache, history, and old local model bytes.
            </div>
          )}
        </div>

        {/* Storage (peer-to-peer): a user-controllable toggle with a byte cap. Independent of mining and
            of serving a model: you can share storage without mining, or mine without sharing storage. */}
        <div className="mt-3 rounded-lg border border-hairline bg-base p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs">
              <div className="flex items-center gap-2 font-medium text-text"><Link2 size={14} className="text-[var(--indigo)]" /> Storage (peer-to-peer) <span className="font-normal text-faint">optional, on while you mine</span></div>
              <div className="mt-0.5 text-faint">Serving authorized model bytes earns a bonus on top of coordination, and passes models to other peers without a central host. It is optional: turn it off and this node still mines and earns from coordination, it just stops holding and serving heavy model bytes.</div>
            </div>
            <Toggle on={mining?.storageEnabled ?? false} onClick={() => updateStorage(!(mining?.storageEnabled ?? false))} disabled={busy} />
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-3">
            <Field label="Storage cap" hint="GB. Default is 8 GB, enough to hold one authorized model so this node can actually serve the field. The node never stores more than this; when full it stops taking new bytes and keeps serving what fits.">
              <Input className="mono" value={storageLimit} onChange={(e) => setStorageLimit(e.target.value)} onBlur={() => updateStorage(mining?.storageEnabled ?? false)} disabled={busy} />
            </Field>
            <Stat label="Used of cap" value={<span className="text-sm">{formatBytes(mining?.storageUsedBytes ?? 0)} / {formatBytes(mining?.storageCapBytes ?? (mining?.storageLimitGb ?? 8) * 1024 ** 3)}{(mining?.storageDownloadingBytes ?? 0) > 0 ? <span className="text-faint"> (+{formatBytes(mining?.storageDownloadingBytes ?? 0)} downloading)</span> : null}</span>} />
            <Stat label="Mode" value={<span className="text-sm">{mining?.storageEnabled ? "storage peer" : "light node"}</span>} />
          </div>
          {(mining?.storageUsedBytes ?? 0) > 0 && (
            <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-faint">
              <span>Free the disk without turning storage off. The node re-fills from the field up to your cap; the model it is actively serving is kept.</span>
              <Button variant="ghost" onClick={emptyStorage} disabled={busy} className="shrink-0 text-xs">Empty stored models</Button>
            </div>
          )}
          {mining?.storageEnabled && (mining?.storageUsedBytes ?? 0) >= (mining?.storageCapBytes ?? (mining?.storageLimitGb ?? 8) * 1024 ** 3) && (
            <div className="mt-2 rounded-lg border border-[color-mix(in_srgb,var(--warn)_35%,transparent)] bg-[color-mix(in_srgb,var(--warn)_7%,transparent)] p-2 text-[11px] text-muted">
              Storage is at its cap. This node keeps serving what it already holds and will not take new bytes until you raise the cap.
            </div>
          )}
        </div>

        {/* My tasks routing: let the field route your own-style build/task work here. Distinct from serving the field. */}
        <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-hairline bg-base px-3 py-3">
          <div className="text-xs">
            <div className="font-medium text-text">Workspace task permission</div>
            <div className="text-faint">Allow the field to route lightweight build, file, planning, or debugging tasks here. This does not download or run a model by itself; it uses your node, endpoint, or future tools only within your settings.</div>
          </div>
          <Toggle on={mining?.localTaskPermission ?? false} onClick={() => updateLocalTaskPermission()} disabled={busy} />
        </div>

        {/* One answering path: the field's own distributed model, served automatically on your hardware when
            Mining + Storage are on. No external model and no endpoint to configure; every answerer runs the
            same canonical model, so answers converge and settle, and stronger hardware serves a bigger model. */}
        <div className="mt-3 rounded-lg border border-[color-mix(in_srgb,var(--teal)_24%,var(--border))] bg-[color-mix(in_srgb,var(--teal)_7%,transparent)] p-3">
          <div className="flex items-center gap-2"><Sparkles size={15} className="text-[var(--teal)]" /><h3 className="text-sm font-semibold">Answer the field <span className="text-[11px] font-normal text-faint">earn more</span></h3></div>
          <p className="mt-1 text-[11px] text-muted">Turn on <span className="font-medium text-text">Mining</span> and <span className="font-medium text-text">Storage</span>. Your node receives the field's distributed model and answers on your own hardware automatically, with nothing to install and no model server to run. Your machine picks the largest field model it can run, so stronger hardware serves a bigger model, wins more queries, and earns more coordination pay on top of the storage baseline.</p>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-3">
            <div className="rounded-md border border-hairline bg-base p-2 text-[11px]">
              <div className="font-medium text-text">1. Mining on</div>
              <div className="mt-1 text-faint">Lend this machine to the field above.</div>
            </div>
            <div className="rounded-md border border-hairline bg-base p-2 text-[11px]">
              <div className="font-medium text-text">2. Storage on</div>
              <div className="mt-1 text-faint">Receive the field model, then serve it here.</div>
            </div>
            <div className="rounded-md border border-hairline bg-base p-2 text-[11px]">
              <div className="font-medium text-text">3. Answer automatically</div>
              <div className="mt-1 text-faint">Your node answers questions and earns. Works behind a home router or NAT, with no inbound connection needed.</div>
            </div>
          </div>
        </div>
        {!canMineSomehow && <p className="mt-2 text-[11px] text-faint">Turn mining on to coordinate the field with your hardware. No model is required; serving the field model and storage stay optional.</p>}
      </Card>

      {/* Battery auto-pause: stop mining when on battery below a chosen threshold. */}
      <BatteryPause miningEnabled={Boolean(mining?.enabled)} onPause={() => { void setMining({ enabled: false }); toast.push("Mining paused: battery below your threshold.", "warn"); }} />

      {/* Honest, three-bullet explainer. */}
      <HowYouEarn />

      {/* Steward: models + assigned storage policy. Active launch authority adds models to the field. */}
      {isFounder && <FounderModels />}
      {isFounder && <FounderStorage />}
        </div>
      )}

      <p className="text-center text-[11px] text-faint">Balance: {formatZir(balanceUZIR)} ZIR, <Server size={11} className="inline" /> connected to your node</p>
    </div>
  );
}

function FieldModelsView({ models, recommendedId }: { models: FieldModel[]; recommendedId: string | null }) {
  return (
    <div className="mt-3 rounded-lg border border-hairline bg-base p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-xs font-medium text-text">Distributed models on the field</div>
        <Badge tone={models.length ? "indigo" : "neutral"}>{models.length} available</Badge>
      </div>
      {models.length === 0 ? (
        <p className="text-xs text-faint">No authorized field model has reached this node yet. Mining still relays, observes, syncs, and this node can serve the field as a small storage peer if storage is enabled.</p>
      ) : (
        <div className="divide-y divide-hairline border-t border-hairline">
          {models.slice(0, 5).map((m) => (
            <div key={m.meta.id} className="flex items-center justify-between gap-3 py-2 text-xs">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-text">{m.meta.name}</div>
                <div className="mono text-faint">{formatBytes(m.meta.sizeBytes)}, {m.providers}/{m.targetHosts ?? 1} host{(m.targetHosts ?? 1) === 1 ? "" : "s"}, {(m.meta.domains ?? []).join(", ") || "general"}</div>
                <div className="mt-1"><Meter value={distributionPct(m) / 100} /></div>
              </div>
              <Badge tone={m.meta.id === recommendedId ? "teal" : m.local ? "indigo" : m.ready ? "teal" : "warn"}>{m.meta.id === recommendedId ? "recommended" : m.local ? "hosted here" : m.ready ? "field ready" : "replicating"}</Badge>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function distributionPct(m: FieldModel): number {
  return Math.round(Math.max(0, Math.min(1, m.distributionProgress ?? (m.providers / Math.max(1, m.targetHosts ?? 1)))) * 100);
}

// Onboarding status banner for mining. A new user enables Mine, then wonders why they see 0 earnings for
// the first few minutes. The truth is that the node must hold model bytes to be storage-vouched by a
// coordinator, and that download is quiet. Surface exactly what phase the node is in so the user has a
// concrete answer instead of "mining is broken". Hidden entirely when mining is off or already earning.
function MiningReadyBanner({ mining, earning }: { mining: MiningStatus | null | undefined; earning: boolean }) {
  if (!mining?.enabled || !mining.storageEnabled) return null;
  // The largest known model that this node does not yet hold locally is the one it is trying to fetch.
  const pending = (mining.known ?? []).filter((m) => !m.local && (m.meta.sizeBytes ?? 0) > 0);
  const targetBytes = pending.reduce((n, m) => Math.max(n, m.meta.sizeBytes ?? 0), 0);
  const used = mining.storageUsedBytes ?? 0;
  // In-flight partial bytes (dl-*.part / data.part) so progress moves instead of sitting at 0
  // while a multi-minute download is running (finalized bytes only count once verified).
  const inflight = mining.storageDownloadingBytes ?? 0;
  const have = used + inflight;
  const downloading = pending.length > 0 && used < targetBytes;
  if (downloading) {
    const pct = targetBytes > 0 ? Math.max(1, Math.min(99, Math.round((have / targetBytes) * 100))) : (inflight > 0 ? 1 : 0);
    return (
      <Card className="border-[color-mix(in_srgb,var(--indigo)_35%,transparent)]">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-text">Serving a field model (optional bonus)</div>
            <div className="mt-1 text-xs text-muted">You are already earning from coordination. In the background your node is fetching an authorized model so it can also serve storage, which earns a bonus on top. This is optional; mining does not wait for it.</div>
          </div>
          <div className="shrink-0 rounded-lg border border-hairline bg-base px-3 py-2 text-center">
            <div className="mono text-lg text-[var(--teal)]">{pct}%</div>
            <div className="text-[11px] text-faint">{formatBytes(have)} / {formatBytes(targetBytes)}</div>
          </div>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-base">
          <div className="h-full bg-[var(--teal)] transition-[width]" style={{ width: pct + "%" }} />
        </div>
      </Card>
    );
  }
  if (used > 0 && !earning) {
    return (
      <Card className="border-[color-mix(in_srgb,var(--indigo)_35%,transparent)]">
        <div className="text-sm font-semibold text-text">Storage ready. A coordinator will add your bonus shortly.</div>
        <div className="mt-1 text-xs text-muted">You earn from coordination as soon as mining is on. Serving this model adds a storage bonus: coordinators verify it every 20 seconds and include it in the next signed round.</div>
      </Card>
    );
  }
  return null;
}

function FounderStorage() {
  const toast = useToast();
  const [peers, setPeers] = useState<string[]>([]);
  const [val, setVal] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() { try { setPeers((await NodeApi.storagePeers()).peers); } catch { /* */ } }
  useEffect(() => { void load(); }, []);

  async function save(next: string[]) {
    setBusy(true);
    try { const r = await NodeApi.setStoragePeers(next); setPeers(r.peers ?? next); }
    catch (e) { toast.push(e instanceof Error ? e.message : "could not save", "danger"); }
    finally { setBusy(false); }
  }
  const add = () => { if (val.trim().startsWith("/")) { void save([...peers, val.trim()]); setVal(""); } else toast.push("Expected a node multiaddr (/dns4/host/tcp/9645/p2p/...).", "warn"); };
  const remove = (p: string) => void save(peers.filter((x) => x !== p));

  return (
    <Card>
      <div className="mb-2 flex items-center gap-2"><Server size={16} className="text-[var(--warn)]" /><h3 className="text-sm font-semibold">Steward: storage addresses</h3></div>
      <p className="mb-3 text-xs text-muted">Steward-assigned storage addresses are trusted backbone hosts, not the only storage peers. Any node that turns on mining becomes a storage peer (an 8GB cap by default), and a user can disable it or raise the cap. Together these peers distribute authorized models and future field artifacts without a central host.</p>
      <Field label="Assign a storage address" hint="A trusted node multiaddr. It will be allowed to host and serve heavy bytes.">
        <div className="flex gap-2">
          <Input className="mono flex-1" value={val} onChange={(e) => setVal(e.target.value)} placeholder="/dns4/store.example.com/tcp/9645/p2p/12D3..." />
          <Button variant="primary" onClick={add} disabled={busy || !val.trim()}>Assign storage</Button>
        </div>
      </Field>
      {peers.length > 0 && (
        <div className="mt-3 divide-y divide-hairline border-t border-hairline">
          {peers.map((p) => (
            <div key={p} className="flex items-center justify-between gap-2 py-2 text-xs">
              <span className="mono truncate text-muted">{p}</span>
              <button onClick={() => remove(p)} className="shrink-0 text-faint hover:text-[var(--danger)]">remove</button>
            </div>
          ))}
        </div>
      )}
      {peers.length === 0 && <p className="mt-2 text-[11px] text-faint">No backbone storage addresses assigned yet. Mining nodes still contribute as storage peers through their default 8GB cap, unless the user disables storage.</p>}
    </Card>
  );
}

function FounderModels() {
  const toast = useToast();
  const requestUnlock = useUnlock((s) => s.request);
  // add-by-link
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [quant, setQuant] = useState("");
  const [addDomains, setAddDomains] = useState<Domain[]>(["general", "reasoning"]);
  const [field, setField] = useState<FieldModel[]>([]);
  const [adding, setAdding] = useState(false);
  // advisory recommendation
  const [label, setLabel] = useState("");
  const [backendHint, setBackendHint] = useState("");
  const [notes, setNotes] = useState("");
  const [recDomains, setRecDomains] = useState<Domain[]>(["general", "reasoning", "language"]);
  const [list, setList] = useState<ModelRecommendation[]>([]);
  const [busy, setBusy] = useState(false);

  async function load() {
    try { setField(await NodeApi.models()); } catch { /* */ }
    try { setList(await NodeApi.recommendations()); } catch { /* */ }
  }
  useEffect(() => { void load(); }, []);
  const pendingModel = field.find((m) => m.local && !m.ready);
  useEffect(() => {
    if (!pendingModel) return;
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [pendingModel?.meta.id]);

  async function addByLink() {
    if (!url.trim() || pendingModel) return;
    const ok = await requestUnlock();
    if (!ok) return;
    const founderPubKey = Wallet.publicKey();
    if (!founderPubKey) { toast.push("Unlock the steward wallet first.", "warn"); return; }
    setAdding(true);
    try {
      const input = { url: url.trim(), name: name.trim() || "model", quant: quant.trim() || undefined, domains: addDomains, ts: Date.now() };
      const requestSig = Wallet.sign(canonical(input));
      const prepared = await NodeApi.prepareModelLink({ input, founderPubKey, requestSig });
      const manifestSig = Wallet.sign(canonical(prepared));
      const meta = await NodeApi.authorizeModel({ meta: prepared, founderPubKey, manifestSig });
      toast.push(`Added ${meta.name}. Uploading to the field now.`);
      setUrl(""); setName(""); setQuant("");
      await load();
    } catch (e) { toast.push(e instanceof Error ? e.message : "could not add model", "danger"); }
    finally { setAdding(false); }
  }

  async function publish() {
    if (!label.trim()) return;
    setBusy(true);
    try {
      await NodeApi.publishRecommendation({ label: label.trim(), backendHint: backendHint.trim(), domains: recDomains, notes: notes.trim() });
      toast.push("Recommendation published. Miners follow it; ZTI enforces quality.");
      setLabel(""); setBackendHint(""); setNotes("");
      await load();
    } catch (e) { toast.push(e instanceof Error ? e.message : "could not publish", "danger"); }
    finally { setBusy(false); }
  }

  return (
    <Card>
      <div className="mb-2 flex items-center gap-2"><Boxes size={16} className="text-[var(--warn)]" /><h3 className="text-sm font-semibold">Steward: models on the field</h3></div>
      <p className="mb-3 text-xs text-muted">Only active stewardship can introduce a model. Today this accepts direct raw GGUF links; the same capability tags prepare the field for future image, video, audio, tool, and multimodal models. The node rejects HTML pages and Git LFS pointer files, then hashes and signs the real bytes before peer distribution.</p>

      <div className="space-y-2">
        <Field label="Model link" hint="Today: raw .gguf file URL, for example a Hugging Face /resolve/ link with download=1. Future model families can use the same signed capability path.">
          <div className="flex gap-2">
            <Input className="mono flex-1" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://.../model.Q4_K_M.gguf" disabled={Boolean(pendingModel)} />
            <Button variant="primary" onClick={addByLink} disabled={adding || Boolean(pendingModel) || !url.trim()}><Link2 size={14} className="mr-1 inline" />{adding ? "Preparing" : pendingModel ? "Wait" : "Add"}</Button>
          </div>
        </Field>
        {adding && (
          <div className="rounded-lg border border-[color-mix(in_srgb,var(--warn)_36%,var(--border))] bg-[color-mix(in_srgb,var(--warn)_8%,transparent)] p-3 text-xs text-muted">
            Downloading and validating GGUF bytes. If the link returns an HTML page or Git LFS pointer instead of the real model file, ZIRA will reject it before signing.
          </div>
        )}
        {pendingModel && (
          <div className="rounded-lg border border-[color-mix(in_srgb,var(--teal)_28%,var(--border))] bg-[color-mix(in_srgb,var(--teal)_7%,transparent)] p-3 text-xs">
            <div className="font-medium text-text">Uploading to the field: {pendingModel.meta.name}</div>
            <div className="mt-1 text-faint">Wait until it is field-ready before adding another model.</div>
            <div className="mt-2"><Meter value={distributionPct(pendingModel) / 100} /></div>
            <div className="mono mt-1 text-faint">{distributionPct(pendingModel)}%, {pendingModel.providers}/{pendingModel.targetHosts ?? 1} host{(pendingModel.targetHosts ?? 1) === 1 ? "" : "s"}</div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Qwen2.5 7B" /></Field>
          <Field label="Quant"><Input className="mono" value={quant} onChange={(e) => setQuant(e.target.value)} placeholder="Q4_K_M" /></Field>
        </div>
        <Field label="Capability domains" hint="Choose all modalities and skill areas this model should be routed for."><DomainChips selected={addDomains} onToggle={(d) => setAddDomains((s) => (s.includes(d) ? s.filter((x) => x !== d) : [...s, d]))} /></Field>
      </div>

      {field.length > 0 && (
        <div className="mt-4 divide-y divide-hairline border-t border-hairline">
          {field.map((m) => (
            <div key={m.meta.id} className="flex items-center justify-between py-2 text-sm">
              <div className="min-w-0 flex-1 pr-3">
                <span className="font-medium">{m.meta.name}</span>
                <div className="text-[11px] text-faint mono">{formatBytes(m.meta.sizeBytes)}, {m.providers}/{m.targetHosts ?? 1} host{(m.targetHosts ?? 1) === 1 ? "" : "s"}, {(m.meta.domains ?? []).join(", ") || "general"}</div>
                <div className="mt-1"><Meter value={distributionPct(m) / 100} /></div>
              </div>
              <Badge tone={m.ready ? "teal" : "warn"}>{m.ready ? "field ready" : "distributing"}</Badge>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 border-t border-hairline pt-3">
        <div className="mb-2 flex items-center gap-2"><Sparkles size={14} className="text-[var(--warn)]" /><h4 className="text-xs font-semibold">Advisory recommendation</h4></div>
        <p className="mb-2 text-[11px] text-muted">Optional. Recommend a configuration for endpoint miners (no signing, no enforcement). Quality is enforced by ZTI.</p>
        <div className="space-y-2">
          <Field label="Name"><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Mistral 7B (recommended)" /></Field>
          <Field label="Backend hint"><Input className="mono" value={backendHint} onChange={(e) => setBackendHint(e.target.value)} placeholder="Ollama: mistral" /></Field>
          <Field label="Domains"><DomainChips selected={recDomains} onToggle={(d) => setRecDomains((s) => (s.includes(d) ? s.filter((x) => x !== d) : [...s, d]))} /></Field>
          <Field label="Notes"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Fast, accurate general model." /></Field>
        </div>
        <Button variant="secondary" className="mt-2" onClick={publish} disabled={busy || !label.trim()}>Publish recommendation</Button>
        {list.length > 0 && (
          <div className="mt-3 divide-y divide-hairline border-t border-hairline">
            {list.map((r, i) => (
              <div key={i} className="flex items-center justify-between py-2 text-sm">
                <div>
                  <span className="font-medium">{r.label}</span>
                  <div className="text-[11px] text-faint mono">{r.backendHint}, {r.domains.join(", ")}</div>
                </div>
                <CheckCircle2 size={15} className="text-[var(--teal)]" />
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
