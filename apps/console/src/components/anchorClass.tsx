// apps/console/src/components/anchorClass.tsx
// The six anchor classes as one shared visual language, mirroring the anchors web page (zira-field/anchors.html):
// each class has a signature color, a role, a seat count, and an animated SVG glyph. Used across the app so the
// Lattice, Anchors, and Discover all read the same "one map, six rings" identity the website establishes.
import { type AnchorClass } from "@zira/protocol";

export interface AnchorClassVisual { name: string; role: string; color: string; seats: number }

// Colors + roles + seat counts are taken verbatim from the website's class ladder so the app and site match.
export const ANCHOR_CLASS_VISUAL: Record<AnchorClass, AnchorClassVisual> = {
  A: { name: "Genesis", role: "core", color: "#D4A820", seats: 16 },
  B: { name: "Meridian", role: "backbone", color: "#F08030", seats: 32 },
  C: { name: "Nexus", role: "connection", color: "#3ECFC0", seats: 64 },
  D: { name: "Lattice", role: "structure", color: "#18C080", seats: 96 },
  E: { name: "Sentinel", role: "edge", color: "#4D94F7", seats: 160 },
  F: { name: "Foundation", role: "reach", color: "#8296B5", seats: 144 },
};

export function anchorClassColor(cls: string): string {
  return ANCHOR_CLASS_VISUAL[cls as AnchorClass]?.color ?? "var(--text-faint)";
}

// The per-class glyph paths, drawn on a 0 0 64 64 canvas in currentColor, matching the website glyphs:
// Genesis = radar rings, Meridian = line of three, Nexus = hub and spokes, Lattice = 3x3 mesh,
// Sentinel = boundary arc, Foundation = hexagon frame.
function Glyph({ cls }: { cls: AnchorClass }) {
  switch (cls) {
    case "A":
      return (<><circle cx="32" cy="32" r="18" fill="none" stroke="currentColor" strokeWidth="1.4" opacity=".45" /><circle cx="32" cy="32" r="11" fill="none" stroke="currentColor" strokeWidth="1.4" opacity=".7" /><circle cx="32" cy="32" r="4" fill="currentColor" /></>);
    case "B":
      return (<><line x1="32" y1="15" x2="32" y2="49" stroke="currentColor" strokeWidth="1.4" opacity=".45" /><circle cx="32" cy="18" r="4" fill="currentColor" /><circle cx="32" cy="32" r="4" fill="currentColor" /><circle cx="32" cy="46" r="4" fill="currentColor" /></>);
    case "C":
      return (<><g stroke="currentColor" strokeWidth="1.4" opacity=".5"><line x1="32" y1="32" x2="50" y2="32" /><line x1="32" y1="32" x2="41" y2="16.4" /><line x1="32" y1="32" x2="23" y2="16.4" /><line x1="32" y1="32" x2="14" y2="32" /><line x1="32" y1="32" x2="23" y2="47.6" /><line x1="32" y1="32" x2="41" y2="47.6" /></g><circle cx="50" cy="32" r="2.6" fill="currentColor" /><circle cx="41" cy="16.4" r="2.6" fill="currentColor" /><circle cx="23" cy="16.4" r="2.6" fill="currentColor" /><circle cx="14" cy="32" r="2.6" fill="currentColor" /><circle cx="23" cy="47.6" r="2.6" fill="currentColor" /><circle cx="41" cy="47.6" r="2.6" fill="currentColor" /><circle cx="32" cy="32" r="5" fill="currentColor" /></>);
    case "D":
      return (<g fill="currentColor"><circle cx="20" cy="20" r="3.2" /><circle cx="32" cy="20" r="3.2" /><circle cx="44" cy="20" r="3.2" /><circle cx="20" cy="32" r="3.2" /><circle cx="32" cy="32" r="3.2" /><circle cx="44" cy="32" r="3.2" /><circle cx="20" cy="44" r="3.2" /><circle cx="32" cy="44" r="3.2" /><circle cx="44" cy="44" r="3.2" /></g>);
    case "E":
      return (<><path d="M17 41 A16 16 0 0 1 47 25" fill="none" stroke="currentColor" strokeWidth="1.4" opacity=".55" /><circle cx="17" cy="41" r="3.6" fill="currentColor" /><circle cx="47" cy="25" r="3.6" fill="currentColor" /></>);
    case "F":
      return (<><polygon points="32,15 47,23.5 47,40.5 32,49 17,40.5 17,23.5" fill="none" stroke="currentColor" strokeWidth="1.4" opacity=".55" /><circle cx="32" cy="32" r="3.6" fill="currentColor" /></>);
  }
}

// An anchor-class glyph in its signature color. `animated` turns on the website's subtle motion (respecting
// prefers-reduced-motion via the CSS in globals.css). `boxed` frames it like the website's ring tiles.
export function AnchorGlyph({ cls, size = 28, animated = true, boxed = false }: { cls: AnchorClass; size?: number; animated?: boolean; boxed?: boolean }) {
  const v = ANCHOR_CLASS_VISUAL[cls];
  if (!v) return null;
  const inner = (
    <svg viewBox="0 0 64 64" width={size} height={size} data-anchor-class={animated ? cls : undefined} className="anchor-glyph" style={{ color: v.color }} aria-hidden="true">
      <Glyph cls={cls} />
    </svg>
  );
  if (!boxed) return inner;
  return (
    <span
      className="anchor-glyph-tile inline-grid place-items-center rounded-xl border"
      style={{ width: size + 20, height: size + 20, borderColor: `color-mix(in srgb, ${v.color} 40%, var(--border))`, background: `color-mix(in srgb, ${v.color} 9%, transparent)` }}
    >
      {inner}
    </span>
  );
}
