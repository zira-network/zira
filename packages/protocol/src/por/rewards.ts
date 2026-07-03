// packages/protocol/src/por/rewards.ts
//
// The tapering emission curve and the reward split. See Part 3.5: the earned 59%
// enters the world only as reward emissions on a curve that pays early and tapers,
// and emission can never push total issuance past the cap.
import { PROTOCOL } from "../constants";
import type { PublicKey, uZIR } from "../types";

const EARNED_CAP_UZIR = Math.round(PROTOCOL.MAX_SUPPLY_UZIR * PROTOCOL.EARNED_SHARE);

// Fraction of the still unemitted earned pool paid out per round. Small, so the curve is smooth: high in
// absolute terms early (large remaining pool) and tapering as the pool empties, an exponential decay toward
// the cap that never crosses it. Calibrated for a ~10-year half-life at the 5s round cadence: the earned
// 59% pool releases about half over ~10 years and tails off for decades after, so ZIR supply grows gradually
// like a real, long-lived network rather than minting most of itself in the first year.
// half-life = ln(2) / (fraction * rounds_per_year); rounds_per_year = 365.25*24*3600/5 ≈ 6.31M.
const ROUND_EMISSION_FRACTION = 0.000_000_011;
// A floor so late rounds still pay a little while remaining stays positive.
const MIN_ROUND_REWARD_UZIR = 1_000;

/**
 * perRoundReward: a smooth tapering curve over the earned share (59% of supply).
 * reward = max(floor, fraction * remaining), clamped so it can never exceed the
 * remaining earned pool. Higher early (remaining large), lower later (remaining small).
 */
export function perRoundReward(emittedUZIR: uZIR, demandMult = 1): uZIR {
  const remaining = EARNED_CAP_UZIR - emittedUZIR;
  if (remaining <= 0) return 0;
  const taper = Math.floor(ROUND_EMISSION_FRACTION * remaining * Math.max(0, demandMult));
  const reward = Math.max(MIN_ROUND_REWARD_UZIR, taper);
  return Math.min(reward, remaining);
}

// Demand-driven emission. The taper sets the pool drain; live coordination demand (how many distinct
// subjects the field is actively resolving this round) scales each reward within a bounded band, so
// busy periods pay contributors more and idle periods conserve the pool. Deterministic: every node
// derives the same factor from the same in-window observations, so committed emission still converges.
export const DEMAND_REWARD = { MIN_MULT: 0.5, MAX_MULT: 2.5, REF_SUBJECTS: 6 } as const;
export function demandMultiplier(activeSubjects: number): number {
  const base = Math.max(0, activeSubjects) / DEMAND_REWARD.REF_SUBJECTS;
  const m = DEMAND_REWARD.MIN_MULT + base * (1 - DEMAND_REWARD.MIN_MULT);
  return Math.min(DEMAND_REWARD.MAX_MULT, Math.max(DEMAND_REWARD.MIN_MULT, m));
}

export const EARNED_CAP = EARNED_CAP_UZIR;

/**
 * storageRewardMultiplier: the bounded emission-weight bonus for a contributor serving `storageGiB` of the
 * field's authorized model weights. Returns a multiplier in [1, 1 + STORAGE_REWARD.BONUS_MAX]: 1.0 with no
 * storage, scaling linearly to the cap once the host serves STORAGE_REWARD.REF_GIB, then flat. Deterministic
 * and pure, so every node derives the same factor from the same gossiped, signed observation. It multiplies
 * the reward WEIGHT only — trust/ZTI is untouched — and the pool it divides is already curve-capped, so this
 * mints no new ZIR.
 */
export function storageRewardMultiplier(storageGiB: number): number {
  const g = Number.isFinite(storageGiB) ? Math.max(0, storageGiB) : 0;
  const frac = Math.min(1, g / PROTOCOL.STORAGE_REWARD.REF_GIB);
  return 1 + PROTOCOL.STORAGE_REWARD.BONUS_MAX * frac;
}

export interface Contributor { pubKey: PublicKey; accuracy: number; }

// ----- Multi-intelligence coordination settlement -----
// A field query/task is served by MANY models/Resonators coordinating. Each contributor is weighted by
// its domain ZTI x answer confidence (its credibility on THIS topic). The query budget is split among
// contributors by that weight, after carving off the small steward-ops share (RESONATOR_FEE_SHARE) that
// funds stewardship. This is a pure, deterministic division of an already-funded budget — it mints no
// new ZIR, so PoR emission and the supply cap are untouched.
export interface CoordinationContribution {
  /** The contributor's payout address (provider/Resonator wallet). */
  address: string;
  /** Trust on the query's domain (domain ZTI, falling back to overall ZTI). */
  domainZti: number;
  /** Self-reported confidence in [0,1]. */
  confidence: number;
  /** Agreement with the coordinated consensus in [0,1]: how closely this answer matched the others. An
   *  outlier earns little even with high self-confidence, so a contributor cannot farm pay with a garbage
   *  answer. Optional; defaults to 1 (full agreement) so a lone contributor and legacy callers are unchanged. */
  agreement?: number;
}
export interface CoordinationSplit {
  /** Per-contributor payouts in µZIR (the 77% contributors slice), summing with the three protocol
   *  slices below to exactly totalUZIR. */
  payouts: { address: string; weight: number; amountUZIR: uZIR }[];
  /** Network wallet slice (8%): long-term protocol sustainability and operations. */
  networkUZIR: uZIR;
  /** Resonator pool slice (10%): distributed to active anchor holders by lattice weight. */
  resonatorPoolUZIR: uZIR;
  /** Burn slice (5%): destroyed via bond_burn, permanently removed from circulation. */
  burnUZIR: uZIR;
  /** A coordinated-confidence score in [0,1]: the weight-weighted mean domain ZTI. */
  confidenceScore: number;
}

/**
 * Split a funded coordination budget into the four §9 slices (whitepaper "Coordination settlement").
 * The network/pool/burn slices are each floor(total*share); the contributors slice is the remainder, so
 * the four parts ALWAYS sum to exactly totalUZIR with no minting. The contributors slice is divided by
 * domainZti*confidence (clamped to a small floor so a brand-new contributor still earns a sliver), with
 * deterministic dust handling (dust to the highest weight, ties by address). If no one contributed, the
 * contributors slice folds into the network wallet so the sum stays exact.
 */
export function settleCoordination(
  totalUZIR: uZIR,
  contributors: CoordinationContribution[],
): CoordinationSplit {
  const total = Math.max(0, Math.floor(totalUZIR));
  const networkUZIR = Math.floor(total * PROTOCOL.COORD_SPLIT.NETWORK);
  const resonatorPoolUZIR = Math.floor(total * PROTOCOL.COORD_SPLIT.RESONATOR_POOL);
  const burnUZIR = Math.floor(total * PROTOCOL.COORD_SPLIT.BURN);
  // Contributors get the remainder (>= 77%), which absorbs all rounding so the four slices sum exactly.
  const contributorsPool = total - networkUZIR - resonatorPoolUZIR - burnUZIR;
  if (total <= 0 || contributors.length === 0) {
    // No contributors answered: their slice funds the network wallet. Sum stays exact.
    return { payouts: [], networkUZIR: networkUZIR + Math.max(0, contributorsPool), resonatorPoolUZIR, burnUZIR, confidenceScore: 0 };
  }
  // Weight = domain trust x self-confidence x agreement-with-consensus. The agreement factor means a
  // divergent (likely wrong) answer earns little even if the contributor claims high confidence.
  const weights = contributors.map((c) =>
    Math.max(0.01,
      Math.max(0, c.domainZti) *
      Math.max(0, Math.min(1, c.confidence)) *
      Math.max(0, Math.min(1, c.agreement ?? 1))));
  const weightSum = weights.reduce((a, b) => a + b, 0) || 1;
  // Normalized shares, then a per-contributor cap so no single voice dominates a coordinated payout. The
  // cap only applies with >= 2 contributors (a lone contributor has no one to share with). Excess over the
  // cap is redistributed to the under-cap contributors by their share; iterate so a recipient pushed over
  // the cap is itself clamped. Deterministic and pure.
  let frac = weights.map((w) => w / weightSum);
  if (contributors.length >= 2) {
    const cap = PROTOCOL.COORD_MAX_SHARE;
    for (let iter = 0; iter < contributors.length; iter++) {
      const excess = frac.reduce((a, f) => a + (f > cap ? f - cap : 0), 0);
      if (excess <= 1e-12) break;
      const underSum = frac.reduce((a, f) => a + (f < cap ? f : 0), 0) || 1;
      frac = frac.map((f) => (f >= cap ? cap : f + excess * (f / underSum)));
    }
  }
  const rows = contributors.map((c, i) => ({
    address: c.address,
    weight: frac[i]!,
    amountUZIR: Math.floor(contributorsPool * frac[i]!),
  }));
  // Deterministic dust: any rounding remainder goes to the highest weight, ties broken by address.
  let dust = contributorsPool - rows.reduce((a, r) => a + r.amountUZIR, 0);
  const order = rows.map((r, i) => ({ i, weight: r.weight, address: r.address }))
    .sort((a, b) => (b.weight - a.weight) || (a.address < b.address ? -1 : 1));
  let k = 0;
  while (dust > 0 && order.length > 0) { rows[order[k % order.length]!.i]!.amountUZIR += 1; dust -= 1; k += 1; }
  const confidenceScore = rows.reduce((s, r, i) => s + r.weight * Math.max(0, contributors[i]!.domainZti), 0);
  return { payouts: rows, networkUZIR, resonatorPoolUZIR, burnUZIR, confidenceScore: Number(confidenceScore.toFixed(4)) };
}

/**
 * splitReward: split a total in integer uZIR by accuracy share, deterministic
 * remainder handling. Any rounding dust goes to the highest accuracy contributor
 * (ties broken by pubKey order) so the sum of parts always equals the total.
 */
export function splitReward(total: uZIR, contributors: Contributor[]): { pubKey: PublicKey; amountUZIR: uZIR }[] {
  if (total <= 0 || contributors.length === 0) return [];
  const weights = contributors.map((c) => (c.accuracy > 0 ? c.accuracy : 0));
  const weightSum = weights.reduce((a, b) => a + b, 0);
  // If no positive accuracy, split evenly.
  const useEven = weightSum <= 0;
  const shares = contributors.map((c, i) => {
    const w = useEven ? 1 / contributors.length : weights[i]! / weightSum;
    return { pubKey: c.pubKey, amountUZIR: Math.floor(total * w), w };
  });
  let assigned = shares.reduce((a, s) => a + s.amountUZIR, 0);
  let dust = total - assigned;
  // Give the dust deterministically to the highest weight, then by pubKey.
  const order = shares
    .map((s, i) => ({ i, w: s.w, pubKey: s.pubKey }))
    .sort((a, b) => (b.w - a.w) || (a.pubKey < b.pubKey ? -1 : 1));
  let k = 0;
  while (dust > 0 && order.length > 0) {
    const target = order[k % order.length]!;
    shares[target.i]!.amountUZIR += 1;
    dust -= 1;
    k += 1;
  }
  return shares.map((s) => ({ pubKey: s.pubKey, amountUZIR: s.amountUZIR }));
}
