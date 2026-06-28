// packages/protocol/src/por/zti.ts
//
// The trust update math. See Part 3.4 of the build pack.
// ZTI is earned, never bought. It is the synapse of the network.
import { PROTOCOL } from "../constants";

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Part 3.4: error = |obsValue - resonantValue| / resonantValue;
 * score = max(0, 1 - (2*error)^2). A 10% miss barely scratches (~0.96),
 * a 50% miss zeroes out.
 */
export function accuracyScore(obsValue: number, resonantValue: number): number {
  if (resonantValue === 0) return obsValue === 0 ? 1 : 0;
  const error = Math.abs(obsValue - resonantValue) / Math.abs(resonantValue);
  const v = 1 - Math.pow(2 * error, 2);
  return v < 0 ? 0 : v;
}

/**
 * Part 3.4: a slow exponential moving average with smoothing 0.08, so one bad
 * reading cannot sink a trusted identity but weeks of bad readings grind it down.
 */
export function emaAccuracy(prev: number, score: number): number {
  return PROTOCOL.SMOOTHING * score + (1 - PROTOCOL.SMOOTHING) * prev;
}

/**
 * Part 3.4: consistency falls when an observer reports erratic values for the
 * same subject in a window, even if the average is right. Modeled as
 * 1 - coefficient of variation of the observer's own values, clamped to 0..1.
 */
export function consistencyScore(valuesInWindow: number[]): number {
  if (valuesInWindow.length < 2) return 1;
  const mean = valuesInWindow.reduce((a, b) => a + b, 0) / valuesInWindow.length;
  if (mean === 0) return 1;
  const variance = valuesInWindow.reduce((a, b) => a + (b - mean) * (b - mean), 0) / valuesInWindow.length;
  const cv = Math.sqrt(variance) / Math.abs(mean);
  return clamp01(1 - cv);
}

/**
 * Part 3.4: absence decays trust by ABSENCE_DECAY (0.9997) per missed round, so a
 * full month away cuts trust to roughly 44% of what it was.
 */
export function applyAbsenceDecay(zti: number, missedRounds: number): number {
  if (missedRounds <= 0) return zti;
  return zti * Math.pow(PROTOCOL.ABSENCE_DECAY, missedRounds);
}

/**
 * Part 3.4: overall ZTI is 0.55*accuracy + 0.25*consistency + 0.20*uptime,
 * clamped to 0 and 1, computed both overall and per domain.
 */
export function composeZti(accuracy: number, consistency: number, uptime: number): number {
  return clamp01(
    PROTOCOL.ACCURACY_WEIGHT * accuracy +
    PROTOCOL.CONSISTENCY_WEIGHT * consistency +
    PROTOCOL.UPTIME_WEIGHT * uptime,
  );
}

export interface ZtiState {
  accuracy: number;   // EMA of per Lock accuracy scores
  consistency: number;
  uptime: number;     // fraction of recent rounds the observer took part in
  zti: number;
}

/** Apply one Lock outcome to an observer's trust state and recompute its ZTI. */
export function updateZtiState(
  prev: ZtiState,
  obsValue: number,
  resonantValue: number,
  valuesInWindow: number[],
  uptime: number,
): ZtiState {
  const accuracy = emaAccuracy(prev.accuracy, accuracyScore(obsValue, resonantValue));
  const consistency = consistencyScore(valuesInWindow);
  const zti = composeZti(accuracy, consistency, uptime);
  return { accuracy, consistency, uptime, zti };
}
