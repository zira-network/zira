// node/src/log.ts
// A tiny timestamped logger. No deps.
const levels = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type Level = keyof typeof levels;
let threshold: number = levels.info;

export function setLogLevel(l: Level): void {
  threshold = levels[l];
}

function fmt(level: Level, args: unknown[]): void {
  if (levels[level] < threshold) return;
  const ts = new Date().toISOString().slice(11, 23);
  const tag = level.toUpperCase().padEnd(5);
  // eslint-disable-next-line no-console
  console.log(`${ts} ${tag}`, ...args);
}

export const log = {
  debug: (...a: unknown[]) => fmt("debug", a),
  info: (...a: unknown[]) => fmt("info", a),
  warn: (...a: unknown[]) => fmt("warn", a),
  error: (...a: unknown[]) => fmt("error", a),
};
