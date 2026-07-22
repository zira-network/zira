// apps/console/src/components/viz.tsx
// The ZIRA Resonance data-viz primitives (v3): a neon gradient dial, a gradient sparkline, and gradient bars.
// All draw in the teal->indigo brand energy over the dark-glass ground, theme-aware, deterministic, and cheap.
// Compose these on every surface instead of re-inventing charts per page.
import { useId } from "react";
import type { ReactNode } from "react";

/** A circular progress dial in the brand gradient with a soft glow and a centered figure. value is 0..1. */
export function NeonDial({ value, size = 96, stroke = 8, label, sub, track = true }: {
  value: number; size?: number; stroke?: number; label?: ReactNode; sub?: string; track?: boolean;
}) {
  const gid = useId();
  const v = Math.max(0, Math.min(1, value));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const cx = size / 2;
  const ariaLabel = `${sub ? `${sub}: ` : ""}${Math.round(v * 100)} percent`;
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={ariaLabel}>
        <defs><linearGradient id={gid} x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="var(--brand-teal)" /><stop offset="100%" stopColor="var(--brand-indigo)" /></linearGradient></defs>
        {track && <circle cx={cx} cy={cx} r={r} fill="none" stroke="var(--border-strong)" strokeOpacity={0.5} strokeWidth={stroke} />}
        <circle cx={cx} cy={cx} r={r} fill="none" stroke={`url(#${gid})`} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={`${v * c} ${c}`} transform={`rotate(-90 ${cx} ${cx})`}
          style={{ filter: "drop-shadow(0 0 6px color-mix(in srgb, var(--brand-teal) 55%, transparent))", transition: "stroke-dasharray .5s var(--ease)" }} />
      </svg>
      {(label || sub) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center leading-none">
          {label && <div className="mono font-semibold text-text" style={{ fontSize: size * 0.24 }}>{label}</div>}
          {sub && <div className="mt-1 uppercase tracking-[0.14em] text-faint" style={{ fontSize: Math.max(7, size * 0.075) }}>{sub}</div>}
        </div>
      )}
    </div>
  );
}

function pathFrom(data: number[], w: number, h: number, pad = 2) {
  if (data.length < 2) return { line: "", area: "", last: [w, h / 2] as [number, number] };
  const min = Math.min(...data), max = Math.max(...data), span = max - min || 1;
  const step = (w - pad * 2) / (data.length - 1);
  const pts = data.map((d, i) => [pad + i * step, pad + (1 - (d - min) / span) * (h - pad * 2)] as [number, number]);
  const line = pts.map((p, i) => (i === 0 ? `M${p[0]} ${p[1]}` : `L${p[0]} ${p[1]}`)).join(" ");
  const first = pts[0]!, endp = pts[pts.length - 1]!;
  const area = `${line} L${endp[0]} ${h} L${first[0]} ${h} Z`;
  return { line, area, last: endp };
}

/** A gradient sparkline with an area fade and a glowing endpoint. */
export function Sparkline({ data, width = 220, height = 40, area = true }: { data: number[]; width?: number; height?: number; area?: boolean }) {
  const gid = useId();
  const { line, area: areaD, last } = pathFrom(data, width, height);
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false" className="block">
      <defs>
        <linearGradient id={`${gid}l`} x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stopColor="var(--brand-teal)" /><stop offset="100%" stopColor="var(--brand-indigo)" /></linearGradient>
        <linearGradient id={`${gid}f`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--brand-teal)" stopOpacity={0.22} /><stop offset="100%" stopColor="var(--brand-teal)" stopOpacity={0} /></linearGradient>
      </defs>
      {area && <path d={areaD} fill={`url(#${gid}f)`} />}
      <path d={line} fill="none" stroke={`url(#${gid}l)`} strokeWidth={1.8} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r={2.4} fill="var(--brand-indigo)" />
    </svg>
  );
}

/** Gradient bars for a discrete series (e.g. coordination per hour). */
export function Bars({ data, width = 220, height = 40 }: { data: number[]; width?: number; height?: number }) {
  const gid = useId();
  const max = Math.max(...data, 1);
  const gap = 3;
  const bw = (width - gap * (data.length - 1)) / data.length;
  return (
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false" className="block">
      <defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--brand-teal)" /><stop offset="100%" stopColor="var(--brand-indigo)" /></linearGradient></defs>
      {data.map((d, i) => {
        const bh = Math.max(2, (d / max) * (height - 2));
        return <rect key={i} x={i * (bw + gap)} y={height - bh} width={bw} height={bh} rx={1.5} fill={`url(#${gid})`} fillOpacity={0.55 + (d / max) * 0.45} />;
      })}
    </svg>
  );
}
