// apps/web/src/components/brand.tsx
// ZiraMark logo and HexField, the breathing cluster used for loaders, empty states, and the
// convergence backdrop. The signature motif of the brand.
import { cn } from "../lib/cn";

export function ZiraMark({ size = 32, glow = false, className }: { size?: number; glow?: boolean; className?: string }) {
  return (
    <img
      src="./zira-mark.svg"
      width={size}
      height={size}
      alt="ZIRA"
      className={cn(glow && "drop-shadow-[0_2px_6px_rgba(91,91,214,0.22)]", className)}
    />
  );
}

// A breathing cluster of hex cells in the original ZIRA brand gradient (teal to blue), matching
// zira-mark.svg so the mark reads the same everywhere it appears.
export function HexField({ size = 160, className }: { size?: number; className?: string }) {
  const cells = [
    { cx: 44, cy: 31, o: 0.88, d: 0 },
    { cx: 55.3, cy: 37.5, o: 0.64, d: 0.4 },
    { cx: 55.3, cy: 50.5, o: 0.48, d: 0.8 },
    { cx: 44, cy: 57, o: 0.64, d: 1.2 },
    { cx: 32.7, cy: 50.5, o: 0.48, d: 1.6 },
    { cx: 32.7, cy: 37.5, o: 0.72, d: 2.0 },
  ];
  return (
    <svg width={size} height={size} viewBox="0 0 88 88" className={className} aria-hidden>
      <defs>
        <linearGradient id="hf-cell" x1="18" y1="14" x2="70" y2="74" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#E8FCF7" stopOpacity="0.95" />
          <stop offset="0.38" stopColor="#3ECFC0" stopOpacity="0.9" />
          <stop offset="1" stopColor="#6B8CE8" stopOpacity="0.78" />
        </linearGradient>
      </defs>
      {cells.map((c, i) => (
        <circle key={i} cx={c.cx} cy={c.cy} r={13} fill="url(#hf-cell)" fillOpacity={c.o}>
          <animate attributeName="fill-opacity" values={`${c.o};${Math.min(1, c.o + 0.2)};${c.o}`} dur="3.2s" begin={`${c.d}s`} repeatCount="indefinite" />
        </circle>
      ))}
      {cells.map((c, i) => (
        <circle key={"s" + i} cx={c.cx} cy={c.cy} r={13} fill="none" stroke="color-mix(in srgb, #3ECFC0 30%, transparent)" strokeWidth={0.75} />
      ))}
    </svg>
  );
}
