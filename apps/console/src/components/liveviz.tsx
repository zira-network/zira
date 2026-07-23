// apps/console/src/components/liveviz.tsx
// Real-time observability primitives for the ZIRA Dashboard (v3 "Resonance" dark-glass system).
// These are thin, reusable, and draw only from CSS tokens. Semantic ALERT colors (good / warn / critical)
// are kept deliberately separate from the teal->indigo brand accent so health reads at a glance by color:
//   good     -> --teal   (green/positive)
//   warn     -> --warn   (amber/warning)
//   critical -> --danger (red/critical)
//   info     -> --indigo (blue/neutral-positive, the second brand accent)
//   idle     -> --neutral
// Every looping/flash animation is gated on prefers-reduced-motion (globals.css also neutralizes it).
import { useEffect, useRef, useState, useId, type ReactNode } from "react";
import { cn } from "../lib/cn";

export type Sem = "good" | "warn" | "critical" | "info" | "idle";
const semVar: Record<Sem, string> = {
  good: "var(--teal)",
  warn: "var(--warn)",
  critical: "var(--danger)",
  info: "var(--indigo)",
  idle: "var(--neutral)",
};

// True only when the user has asked for reduced motion. JS-driven flashes read this so they never move
// for those users; SMIL/CSS decorative motion is already neutralized globally.
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    const sync = () => setReduced(!!mq?.matches);
    sync();
    mq?.addEventListener?.("change", sync);
    return () => mq?.removeEventListener?.("change", sync);
  }, []);
  return reduced;
}

// ---- HealthDot: a single semantic status dot, optionally breathing ----
export function HealthDot({ status, pulse = false, size = 8 }: { status: Sem; pulse?: boolean; size?: number }) {
  const reduced = usePrefersReducedMotion();
  const color = semVar[status];
  return (
    <span
      aria-hidden
      className={cn("inline-block shrink-0 rounded-full", pulse && !reduced && "animate-breathe")}
      style={{ width: size, height: size, background: color, boxShadow: `0 0 8px -1px color-mix(in srgb, ${color} 70%, transparent)` }}
    />
  );
}

// ---- StatusPill: a composite semantic status, read at a glance by color ----
export function StatusPill({ status, label, sub, big = false }: { status: Sem; label: string; sub?: string; big?: boolean }) {
  const color = semVar[status];
  return (
    <span
      className={cn("inline-flex items-center gap-2 rounded-full border", big ? "px-3.5 py-1.5" : "px-3 py-1")}
      style={{ borderColor: `color-mix(in srgb, ${color} 34%, transparent)`, background: `color-mix(in srgb, ${color} 10%, transparent)` }}
      role="status"
    >
      <HealthDot status={status} pulse={status === "good"} size={big ? 9 : 8} />
      <span className={cn("font-semibold", big ? "text-base" : "text-sm")} style={{ color }}>{label}</span>
      {sub && <span className="text-[11px] text-faint">{sub}</span>}
    </span>
  );
}

// ---- LiveNumber: value that softly flashes its color on change, then fades back. tabular-nums. ----
// No layout shift (only text color transitions), so updates feel graceful rather than jarring.
export function LiveNumber({ value, unit, className, format, flashTone = "info" }: {
  value: number | string;
  unit?: string;
  className?: string;
  format?: (v: number) => string;
  flashTone?: Sem;
}) {
  const reduced = usePrefersReducedMotion();
  const prev = useRef<number | string>(value);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      if (!reduced) {
        setFlash(true);
        const t = setTimeout(() => setFlash(false), 650);
        return () => clearTimeout(t);
      }
    }
  }, [value, reduced]);
  const text = typeof value === "number" ? (format ? format(value) : String(value)) : value;
  return (
    <span
      className={cn("mono tabular-nums", className)}
      style={{
        color: flash && !reduced ? semVar[flashTone] : undefined,
        transition: flash ? "color 90ms var(--ease)" : "color 620ms var(--ease)",
      }}
    >
      {text}
      {unit && <span className="ml-1 text-[0.62em] font-normal text-faint">{unit}</span>}
    </span>
  );
}

// ---- DeltaBadge: the real-time number contrasted against a baseline, colored by direction + semantics ----
export function DeltaBadge({ value, baseline, goodDirection = "up", suffix = "vs avg", digits = 0, minPct = 0.5 }: {
  value: number;
  baseline: number | null | undefined;
  goodDirection?: "up" | "down" | "neutral";
  suffix?: string;
  digits?: number;
  minPct?: number;
}) {
  if (baseline === null || baseline === undefined || !isFinite(baseline)) return null;
  const denom = Math.abs(baseline) < 1e-9 ? (Math.abs(value) < 1e-9 ? 1 : Math.abs(value)) : Math.abs(baseline);
  const pct = ((value - baseline) / denom) * 100;
  const flat = Math.abs(pct) < minPct;
  const up = pct > 0;
  let sem: Sem = "info";
  if (flat) sem = "idle";
  else if (goodDirection !== "neutral") {
    const isGood = goodDirection === "up" ? up : !up;
    sem = isGood ? "good" : "warn";
  }
  const color = semVar[sem];
  const arrow = flat ? "→" : up ? "↑" : "↓";
  const text = flat ? "flat" : `${up ? "+" : ""}${pct.toFixed(digits)}%`;
  return (
    <span className="mono inline-flex items-center gap-1 text-[11px] font-medium" style={{ color }}>
      <span aria-hidden>{arrow}</span>
      <span>{text}</span>
      <span className="font-normal text-faint">{suffix}</span>
    </span>
  );
}

// ---- TrendLine: thin-stroke line of a series, with an optional dashed baseline and area fill ----
export function TrendLine({ data, baseline, width = 220, height = 44, stroke = 1.6, tone = "info", showBaseline = true, fill = false }: {
  data: number[];
  baseline?: number | null;
  width?: number;
  height?: number;
  stroke?: number;
  tone?: Sem;
  showBaseline?: boolean;
  fill?: boolean;
}) {
  const gid = useId();
  const pad = 3;
  const color = semVar[tone];
  if (data.length < 2) {
    return <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden className="block" />;
  }
  const hasBase = baseline !== null && baseline !== undefined && isFinite(baseline);
  const vals = hasBase ? [...data, baseline as number] : data;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const step = (width - pad * 2) / (data.length - 1);
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
  const pts = data.map((d, i) => [pad + i * step, y(d)] as const);
  const first = pts[0]!;
  const endp = pts[pts.length - 1]!;
  const line = pts.map((p, i) => (i === 0 ? `M${p[0].toFixed(1)} ${p[1].toFixed(1)}` : `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`)).join(" ");
  const area = `${line} L${endp[0].toFixed(1)} ${height} L${first[0].toFixed(1)} ${height} Z`;
  const baseY = hasBase ? y(baseline as number) : null;
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden className="block">
      <defs>
        <linearGradient id={`${gid}f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.18} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      {fill && <path d={area} fill={`url(#${gid}f)`} />}
      {showBaseline && baseY !== null && (
        <line x1={pad} y1={baseY} x2={width - pad} y2={baseY} stroke="var(--border-strong)" strokeWidth={1} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      )}
      <path d={line} fill="none" stroke={color} strokeWidth={stroke} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={endp[0]} cy={endp[1]} r={2.2} fill={color} />
    </svg>
  );
}

// ---- Freshness: a live "Last refreshed Ns ago" stamp; turns amber when data goes stale ----
export function Freshness({ at, label = "Last refreshed", staleMs = 15000 }: { at: number | null; label?: string; staleMs?: number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (!at) return <span className="text-[11px] text-faint">{label}: waiting for data</span>;
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  const stale = secs * 1000 > staleMs;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px]">
      <HealthDot status={stale ? "warn" : "good"} pulse={!stale} size={6} />
      <span className="text-faint">{label}</span>
      <span className="mono text-muted">{secs}s ago</span>
    </span>
  );
}

// ---- DataQuality: differentiates confirmed / streaming / collecting / offline metrics ----
export type Quality = "confirmed" | "streaming" | "collecting" | "offline";
export function DataQuality({ quality, note }: { quality: Quality; note?: string }) {
  const map: Record<Quality, { sem: Sem; label: string }> = {
    confirmed: { sem: "good", label: "confirmed" },
    streaming: { sem: "info", label: "streaming" },
    collecting: { sem: "warn", label: "collecting" },
    offline: { sem: "idle", label: "offline" },
  };
  const { sem, label } = map[quality];
  const color = semVar[sem];
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
      style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
      title={note}
    >
      <span className="inline-block h-1 w-1 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

// ---- MiniBar: a labelled composition bar (no pie charts) for by-source splits ----
export function MiniBar({ label, value, total, tone = "info", unit }: { label: string; value: number; total: number; tone?: Sem; unit?: ReactNode }) {
  const color = semVar[tone];
  const pct = total > 0 ? Math.max(0, Math.min(1, value / total)) * 100 : 0;
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between gap-2 text-[11px]">
        <span className="truncate text-muted">{label}</span>
        <span className="mono shrink-0 text-faint">{unit}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-elevated">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color, transition: "width 500ms var(--ease)" }} />
      </div>
    </div>
  );
}
