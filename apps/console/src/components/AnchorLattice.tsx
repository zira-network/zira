// apps/console/src/components/AnchorLattice.tsx
// The 512-seat anchor lattice as a LIVING assignment tracker, the same concept as the web anchors page
// (zira-field/zira-rings.js): six concentric rings, one per class (A Genesis inner .. F Foundation outer), each
// holding exactly its cap of seat nodes evenly spaced. Assigned seats are FILLED and bright with a breathing
// glow halo; open seats are dim outlines, clearly "available". Inner rings carry the highest weight and trust.
// Rendered on a canvas (hundreds of nodes animate smoothly), HiDPI-aware, offscreen/reduced-motion paused, and
// wired to REAL per-class assigned counts. Counts only; never any identity. Deterministic layout.
import { useEffect, useMemo, useRef } from "react";
import { MAINNET_ANCHOR_STEWARD, type Anchor } from "@zira/protocol";

type ClassDef = { key: string; label: string; cap: number; r: number; color: string; dot: number };
// Caps + palette match the anchor cards, legend, and the web tracker exactly (A..F, total 512).
const CLASSES: ClassDef[] = [
  { key: "A", label: "Genesis", cap: 16, r: 0.16, color: "#D4A820", dot: 5.0 },
  { key: "B", label: "Meridian", cap: 32, r: 0.30, color: "#F08030", dot: 4.2 },
  { key: "C", label: "Nexus", cap: 64, r: 0.44, color: "#3ECFC0", dot: 3.4 },
  { key: "D", label: "Lattice", cap: 96, r: 0.58, color: "#18C080", dot: 2.9 },
  { key: "E", label: "Sentinel", cap: 160, r: 0.72, color: "#4D94F7", dot: 2.4 },
  { key: "F", label: "Foundation", cap: 144, r: 0.86, color: "#869AB8", dot: 2.3 },
];

function rgba(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

/** A seat counts as ASSIGNED once it leaves the steward (owned by a real contributor). Counts only. */
function assignedByClass(anchors: Anchor[]): Record<string, number> {
  const out: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, E: 0, F: 0 };
  for (const a of anchors) {
    if (a.owner && a.owner !== MAINNET_ANCHOR_STEWARD && out[a.classCode] !== undefined) out[a.classCode]!++;
  }
  return out;
}

export function AnchorLattice({ anchors = [], assigned: assignedProp, size = 420, live = true }: {
  anchors?: Anchor[];
  assigned?: Record<string, number>;
  size?: number;
  live?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const assigned = useMemo(() => assignedProp ?? assignedByClass(anchors), [assignedProp, anchors]);
  // keep the latest assigned counts in a ref so the animation loop reads fresh data without re-subscribing
  const assignedRef = useRef(assigned);
  assignedRef.current = assigned;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.max(1, Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2.5));
    const w = size, h = size;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    const cx = w / 2, cy = h / 2;
    const R = Math.min(w, h) * 0.5 - Math.max(14, size * 0.05);
    const nodeScale = Math.max(0.6, Math.min(1, Math.min(w, h) / 560));
    const phase = CLASSES.map((_, i) => i * 0.9);

    function draw(t: number) {
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // soft central core glow
      const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.9);
      core.addColorStop(0, rgba("#3ECFC0", live ? 0.1 : 0.05));
      core.addColorStop(0.5, rgba("#6B8CE8", 0.04));
      core.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = core;
      ctx.beginPath(); ctx.arc(cx, cy, R * 0.9, 0, Math.PI * 2); ctx.fill();

      // outer -> inner so brighter inner nodes sit on top
      for (let i = CLASSES.length - 1; i >= 0; i--) {
        const cls = CLASSES[i]!;
        const ringR = R * cls.r;
        const dir = i % 2 === 0 ? 1 : -1;
        const speed = reduced || !live ? 0 : 0.045 - i * 0.005;
        const rot = dir * t * speed - Math.PI / 2;

        // faint guide ring
        ctx.beginPath(); ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(cls.color, 0.12); ctx.lineWidth = 1; ctx.stroke();

        const n = cls.cap;
        const asg = Math.max(0, Math.min(n, assignedRef.current[cls.key] ?? 0));
        const step = (Math.PI * 2) / n;
        const shimmer = reduced || !live ? 0 : Math.sin(t * 0.9 + phase[i]!);
        const dot = cls.dot * nodeScale;

        for (let s = 0; s < n; s++) {
          const a = rot + s * step;
          const x = cx + Math.cos(a) * ringR, y = cy + Math.sin(a) * ringR;
          if (s < asg) {
            const local = reduced || !live ? 0.7 : 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t * 1.1 + s * 0.6 + i));
            const glowA = 0.12 + 0.16 * (0.5 + 0.5 * shimmer);
            const g = ctx.createRadialGradient(x, y, 0, x, y, dot * 3.2);
            g.addColorStop(0, rgba(cls.color, glowA + 0.2 * local)); g.addColorStop(1, "rgba(0,0,0,0)");
            ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, dot * 3.2, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = rgba(cls.color, 0.6 + 0.36 * local); ctx.beginPath(); ctx.arc(x, y, dot, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = rgba("#FFFFFF", 0.3 + 0.3 * local); ctx.beginPath(); ctx.arc(x, y, dot * 0.38, 0, Math.PI * 2); ctx.fill();
          } else {
            ctx.beginPath(); ctx.arc(x, y, dot * 0.82, 0, Math.PI * 2);
            ctx.strokeStyle = rgba(cls.color, 0.28); ctx.lineWidth = 1; ctx.stroke();
          }
        }
      }

      // central convergence node
      const pulse = reduced || !live ? 0.5 : 0.5 + 0.5 * Math.sin(t * 0.8);
      const coreR = (7 + pulse * 2.2) * nodeScale;
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR * 3.4);
      cg.addColorStop(0, rgba("#E8FCF7", 0.95)); cg.addColorStop(0.4, rgba("#3ECFC0", 0.5)); cg.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(cx, cy, coreR * 3.4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = rgba("#E8FCF7", 0.95); ctx.beginPath(); ctx.arc(cx, cy, coreR * 0.5, 0, Math.PI * 2); ctx.fill();
    }

    let raf = 0, io: IntersectionObserver | null = null, visible = true, start = 0;
    const loop = (now: number) => {
      if (!start) start = now;
      draw((now - start) / 1000);
      if (visible && !reduced && live) raf = requestAnimationFrame(loop);
    };
    // Always paint one frame synchronously so the lattice is never blank while waiting for the first
    // requestAnimationFrame (which a backgrounded tab or headless renderer may throttle indefinitely).
    draw(0);
    if (reduced || !live) {
      // static frame already drawn
    } else if (typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver((e) => {
        const nowVisible = !!e[0]?.isIntersecting;
        if (nowVisible && !visible) { start = 0; raf = requestAnimationFrame(loop); }
        if (!nowVisible && raf) { cancelAnimationFrame(raf); raf = 0; }
        visible = nowVisible;
        if (!nowVisible) draw(0);
      }, { rootMargin: "100px" });
      io.observe(canvas);
      raf = requestAnimationFrame(loop);
    } else {
      raf = requestAnimationFrame(loop);
    }
    return () => { if (raf) cancelAnimationFrame(raf); io?.disconnect(); };
  }, [size, live]);

  return <canvas ref={canvasRef} role="img"
    aria-label={`Anchor lattice: ${Object.values(assigned).reduce((a, b) => a + b, 0)} of 512 seats assigned across six classes`}
    className="block max-w-full" />;
}
