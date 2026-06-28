// packages/protocol/src/por/field.ts
//
// Proof of Resonance: how the network agrees on a value. See Part 3.3.
// The median, never the mean, is the agreed value, because a median does not move
// unless an attacker controls more than half of the weight.
import { PROTOCOL, type Domain } from "../constants";
import type { Lock, PublicKey } from "../types";

export interface Claim { value: number; zti: number; confidence: number; observer?: PublicKey; }

/**
 * Part 3.3: trust weighted median. weight = zti*confidence. Sort by value, return
 * the value where cumulative weight first reaches half of the total weight.
 * Returns null when total weight is 0.
 */
export function trustWeightedMedian(claims: Claim[]): number | null {
  const weighted = claims
    .map((c) => ({ value: c.value, weight: c.zti * c.confidence }))
    .filter((c) => c.weight > 0);
  if (weighted.length === 0) return null;
  const total = weighted.reduce((a, c) => a + c.weight, 0);
  if (total <= 0) return null;
  weighted.sort((a, b) => a.value - b.value);
  const half = total / 2;
  let cumulative = 0;
  for (const c of weighted) {
    cumulative += c.weight;
    if (cumulative >= half) return c.value;
  }
  // numerical guard, return the last value
  return weighted[weighted.length - 1]!.value;
}

/**
 * Coefficient of variation across claim values: stddev/mean. Infinity if the mean
 * is 0 or there are fewer than 2 values. This is the convergence gauge for a Lock.
 */
export function cv(values: number[]): number {
  if (values.length < 2) return Infinity;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return Infinity;
  const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / values.length;
  return Math.sqrt(variance) / Math.abs(mean);
}

/**
 * Part 3.3: each observer nudges its own estimate toward the median, more slowly the
 * higher its trust, so trusted observers anchor the field.
 * step = STEP_BASE * (1 - STEP_TRUST_FACTOR * zti).
 */
export function convergeStep(estimate: number, target: number, zti: number): number {
  const step = PROTOCOL.STEP_BASE * (1 - PROTOCOL.STEP_TRUST_FACTOR * zti);
  return estimate + step * (target - estimate);
}

export type LockBody = Omit<Lock, "id" | "sealedAt"> & { sealedAt?: number };

/**
 * Part 3.3: seal a Lock when at least MIN_OBSERVATIONS contributed, a trust weighted
 * median exists, cv < CV_THRESHOLD, and supporting trust >= FINALITY_THRESHOLD.
 * Returns the Lock body without id and sealedAt, or null when the gate is not met.
 */
export function tryLock(
  subject: string,
  domain: Domain,
  epoch: number,
  claims: Claim[],
  supportingTrust: number,
): Omit<Lock, "id" | "sealedAt"> | null {
  if (claims.length < PROTOCOL.MIN_OBSERVATIONS) return null;
  const median = trustWeightedMedian(claims);
  if (median === null) return null;
  const variation = cv(claims.map((c) => c.value));
  if (!(variation < PROTOCOL.CV_THRESHOLD)) return null;
  if (supportingTrust < PROTOCOL.FINALITY_THRESHOLD) return null;
  const supporters = claims
    .filter((c) => c.observer)
    .map((c) => c.observer as PublicKey);
  return {
    subject,
    domain,
    epoch,
    resonantValue: median,
    cv: variation,
    observationCount: claims.length,
    supportingTrust,
    supporters,
  };
}
