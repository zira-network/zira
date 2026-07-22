// apps/console/src/components/ResonanceField.tsx
// The ZIRA mark rendered as a living core of light: the six-circle flower-of-life at the SAME proportions as the
// brand art (a large flower that fills the frame), crisp bright petal outlines over a teal -> cyan -> blue ->
// violet fill, a glowing convergence center, and a MINIMAL ambient field (a sparse star drift + two faint slow
// orbit arcs). No text is ever drawn on the mark. `intensity` (0..1) drives glow + orbit speed; `live=false`
// dims it (mining off / offline). Deterministic, theme-aware, honors prefers-reduced-motion and offscreen pause.
import { useEffect, useId, useRef, useState } from "react";

function useMotionActive(ref: React.RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(false);
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    const syncMq = () => setReduced(!!mq?.matches);
    syncMq();
    mq?.addEventListener?.("change", syncMq);
    const el = ref.current;
    let io: IntersectionObserver | null = null;
    if (el && typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver((e) => setVisible(!!e[0]?.isIntersecting), { rootMargin: "80px" });
      io.observe(el);
    } else setVisible(true);
    return () => { io?.disconnect(); mq?.removeEventListener?.("change", syncMq); };
  }, [ref]);
  return visible && !reduced;
}

// Sparse ambient stars (angle deg, radius fraction, size fraction) drifting far out. Hand-placed for balance.
const STARS: [number, number, number][] = [
  [200, 0.92, 0.006], [222, 0.8, 0.004], [250, 0.88, 0.005], [140, 0.9, 0.004],
  [118, 0.82, 0.005], [95, 0.95, 0.004], [20, 0.86, 0.005], [312, 0.9, 0.004], [340, 0.8, 0.004],
];

export function ResonanceField({
  size = 300,
  intensity = 0.5,
  live = true,
  // Accepted for call-site compatibility but never drawn on the mark (no text on the logo). Callers that want a
  // figure render it beside or below the field, not over it.
  label: _label,
  sublabel: _sublabel,
  center: _center,
}: {
  size?: number;
  intensity?: number;
  live?: boolean;
  label?: unknown;
  sublabel?: unknown;
  center?: unknown;
}) {
  const cx = size / 2, cy = size / 2;
  const clamped = Math.max(0, Math.min(1, intensity));
  const petalR = size * 0.156;               // large flower-of-life, matching the brand mark's proportions
  const glow = live ? 0.62 + clamped * 0.38 : 0.26;

  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const gEnergy = `${uid}e`, gCore = `${uid}c`, fBloom = `${uid}bl`, fLine = `${uid}ln`;

  const wrapRef = useRef<HTMLDivElement>(null);
  const active = useMotionActive(wrapRef);
  const animate = live && active;

  // six petals at 270deg + i*60 (top first), offset == radius so they overlap through the center. Graded fill
  // opacity copied from the brand mark (top brightest, then around) so the overlaps build depth.
  const ops = [0.9, 0.66, 0.5, 0.66, 0.5, 0.74];
  const cells = ops.map((op, i) => {
    const a = (270 + i * 60) * (Math.PI / 180);
    return { x: cx + petalR * Math.cos(a), y: cy + petalR * Math.sin(a), op };
  });

  return (
    <div ref={wrapRef} className={`relative inline-flex items-center justify-center${active ? "" : " rf-paused"}`} style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true" focusable="false" className="max-w-full overflow-visible">
        <defs>
          <linearGradient id={gEnergy} x1="0.08" y1="0.04" x2="0.94" y2="0.98">
            <stop offset="0%" stopColor="#3ECFC0" />
            <stop offset="32%" stopColor="#68E3DA" />
            <stop offset="64%" stopColor="#6B8CE8" />
            <stop offset="100%" stopColor="#9A7FE8" />
          </linearGradient>
          <radialGradient id={gCore} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity={glow} />
            <stop offset="14%" stopColor="#8CEFE4" stopOpacity={glow * 0.8} />
            <stop offset="44%" stopColor="#6B8CE8" stopOpacity={0.13} />
            <stop offset="100%" stopColor="#9A7FE8" stopOpacity={0} />
          </radialGradient>
          <filter id={fBloom} x="-70%" y="-70%" width="240%" height="240%"><feGaussianBlur stdDeviation={size * 0.02} /></filter>
          <filter id={fLine} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation={size * 0.004} result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* deep radial bloom */}
        <circle cx={cx} cy={cy} r={size * 0.5} fill={`url(#${gCore})`} />

        {/* two faint slow orbit arcs, soft (not bold rings) */}
        {[0.82, 0.95].map((rf, i) => {
          const r = size * 0.5 * rf, c = 2 * Math.PI * r;
          return (
            <g key={`arc${i}`} className={animate ? "rf-orbit" : undefined}
               style={{ transformOrigin: `${cx}px ${cy}px`, animationDuration: `${(70 + i * 26) - clamped * 12}s`, animationDirection: i % 2 ? "reverse" : "normal" }}>
              <circle cx={cx} cy={cy} r={r} fill="none" stroke="#6B8CE8" strokeOpacity={live ? 0.12 : 0.05}
                strokeWidth={Math.max(0.5, size * 0.0016)} strokeLinecap="round" strokeDasharray={`${c * 0.16} ${c}`} />
            </g>
          );
        })}

        {/* sparse drifting stars */}
        {STARS.map(([ang, rf, sf], i) => {
          const a = ang * (Math.PI / 180), r = size * 0.5 * rf;
          return <circle key={`s${i}`} cx={cx + r * Math.cos(a)} cy={cy + r * Math.sin(a)} r={size * sf}
            fill="#DCF7FF" opacity={live ? 0.7 : 0.28} filter={`url(#${fLine})`}
            className={animate ? "rf-node" : undefined} style={{ animationDelay: `${i * 0.7}s` }} />;
        })}

        {/* the mark: six overlapping circles, gradient fill + bright hairline outlines + glowing center */}
        <g className={animate ? "rf-breathe" : undefined} style={{ transformOrigin: `${cx}px ${cy}px` }}>
          <g filter={`url(#${fBloom})`} opacity={glow * 0.7}>
            {cells.map((c, i) => <circle key={`bl${i}`} cx={c.x} cy={c.y} r={petalR} fill={`url(#${gEnergy})`} fillOpacity={c.op * 0.8} />)}
          </g>
          {cells.map((c, i) => <circle key={`f${i}`} cx={c.x} cy={c.y} r={petalR} fill={`url(#${gEnergy})`} fillOpacity={c.op * 0.62} />)}
          {cells.map((c, i) => <circle key={`o${i}`} cx={c.x} cy={c.y} r={petalR} fill="none" stroke="#DFFBFF"
            strokeOpacity={live ? 0.62 : 0.32} strokeWidth={Math.max(0.8, size * 0.0032)} filter={`url(#${fLine})`} />)}
          <circle cx={cx} cy={cy} r={size * 0.03} fill="#ffffff" filter={`url(#${fLine})`} opacity={glow} />
          <circle cx={cx} cy={cy} r={size * 0.012} fill="#ffffff" opacity={Math.min(1, glow + 0.15)} />
        </g>
      </svg>
    </div>
  );
}
