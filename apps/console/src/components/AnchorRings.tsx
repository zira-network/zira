// apps/console/src/components/AnchorRings.tsx
// 2.9.0 (3F): the six anchor classes as six concentric rings — the brand's six-circle resonance motif rendered
// as the network's foundational structure. Genesis (A) at the core, Foundation (F) at the reach. Each ring is a
// progress arc: the bright segment is the share of that class HELD by a distinct owner (a signed early holder),
// a small teal tick marks seats currently OPEN to claim, and the dim track is the reserve still held by the
// steward. Pure presentational SVG over the anchor data the page already has; theme-aware via currentColor/opacity.
import { ANCHOR_CLASS_VISUAL } from "./anchorClass";
import { MAINNET_ANCHOR_STEWARD, type Anchor, type AnchorClass } from "@zira/protocol";

const CLASS_ORDER: AnchorClass[] = ["A", "B", "C", "D", "E", "F"];

export function AnchorRings({ anchors, size = 240 }: { anchors: Anchor[]; size?: number }) {
  const cx = size / 2, cy = size / 2;
  const inner = size * 0.11, gap = (size * 0.47 - inner) / (CLASS_ORDER.length - 1);

  const perClass = CLASS_ORDER.map((code, i) => {
    const seats = anchors.filter((a) => a.classCode === code);
    const total = ANCHOR_CLASS_VISUAL[code].seats;
    const held = seats.filter((a) => a.owner && a.owner !== MAINNET_ANCHOR_STEWARD).length;
    const open = seats.filter((a) => a.owner === MAINNET_ANCHOR_STEWARD && a.contributionsOpen).length;
    const r = inner + i * gap;
    return { code, color: ANCHOR_CLASS_VISUAL[code].color, r, total, held, open };
  });

  const totals = perClass.reduce((acc, c) => ({ held: acc.held + c.held, open: acc.open + c.open, total: acc.total + c.total }), { held: 0, open: 0, total: 0 });

  return (
    <div className="flex flex-col items-center">
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label="Anchor classes as concentric rings" className="max-w-full">
        {perClass.map(({ code, color, r, total, held, open }) => {
          const c = 2 * Math.PI * r;
          const heldLen = total > 0 ? (held / total) * c : 0;
          const openStart = total > 0 ? (held / total) * c : 0;
          const openLen = total > 0 ? Math.min(open / total, 1) * c : 0;
          return (
            <g key={code} transform={`rotate(-90 ${cx} ${cy})`}>
              {/* reserve track */}
              <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeOpacity={0.14} strokeWidth={size * 0.03} />
              {/* held (community) arc */}
              {heldLen > 0 && (
                <circle cx={cx} cy={cy} r={r} fill="none" stroke={color} strokeWidth={size * 0.03}
                  strokeLinecap="round" strokeDasharray={`${heldLen} ${c - heldLen}`} strokeDashoffset={0} />
              )}
              {/* open-to-claim tick */}
              {openLen > 0 && (
                <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--teal)" strokeWidth={size * 0.03}
                  strokeLinecap="round" strokeDasharray={`${Math.max(openLen, size * 0.012)} ${c}`} strokeDashoffset={-openStart} />
              )}
            </g>
          );
        })}
        <text x={cx} y={cy - 4} textAnchor="middle" style={{ fill: "var(--text)", fontSize: size * 0.14, fontWeight: 700 }}>{totals.total}</text>
        <text x={cx} y={cy + size * 0.075} textAnchor="middle" style={{ fill: "var(--text-faint, #8a8f98)", fontSize: size * 0.05, letterSpacing: "0.08em" }}>SEATS</text>
      </svg>
      <div className="mt-2 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px] text-faint">
        <span className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-full" style={{ background: "var(--text)" }} />{totals.held} held by owners</span>
        <span className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-full" style={{ background: "var(--teal)" }} />{totals.open} open to claim</span>
        <span className="inline-flex items-center gap-1.5"><i className="h-2 w-2 rounded-full bg-white/20" />{totals.total - totals.held - totals.open} in reserve</span>
      </div>
    </div>
  );
}
