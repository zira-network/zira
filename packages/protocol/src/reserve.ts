// packages/protocol/src/reserve.ts
// Deterministic helper for local launch-reserve distribution plans. The helper does not move funds;
// each due slot still becomes real only when a steward wallet signs a reserve_grant transaction.
import type { Address, uZIR } from "./types";

export type ReserveDistributionCadence = "hourly" | "daily" | "weekly" | "monthly";

export interface ReserveDistributionSent {
  key: string;
  txId: string;
  timestamp: number;
  amountUZIR: uZIR;
  to: Address;
}

export interface ReserveDistributionPlan {
  id: string;
  targets: Address[];
  amountPerTargetUZIR: uZIR;
  startAt: number;
  endAt: number;
  cadence: ReserveDistributionCadence;
  reason: string;
  createdAt: number;
  cancelledAt?: number;
  sent: ReserveDistributionSent[];
}

export interface ReserveDistributionSlot {
  key: string;
  dueAt: number;
  to: Address;
  amountUZIR: uZIR;
}

export const RESERVE_CADENCE_MS: Record<ReserveDistributionCadence, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

export function reserveDistributionSlots(plan: ReserveDistributionPlan): ReserveDistributionSlot[] {
  const startAt = Math.min(plan.startAt, plan.endAt);
  const endAt = Math.max(plan.startAt, plan.endAt);
  const step = RESERVE_CADENCE_MS[plan.cadence];
  const times: number[] = [];
  for (let t = startAt; t <= endAt; t += step) times.push(t);
  if (times.length === 0 || times[times.length - 1] !== endAt) times.push(endAt);

  const out: ReserveDistributionSlot[] = [];
  for (const to of plan.targets) {
    const base = Math.floor(plan.amountPerTargetUZIR / times.length);
    let remainder = plan.amountPerTargetUZIR - base * times.length;
    times.forEach((dueAt, idx) => {
      const extra = remainder > 0 ? 1 : 0;
      remainder -= extra;
      out.push({ key: `${plan.id}:${to}:${idx}`, dueAt, to, amountUZIR: base + extra });
    });
  }
  return out.filter((slot) => slot.amountUZIR > 0);
}

export function dueReserveDistributionSlots(plan: ReserveDistributionPlan, now: number): ReserveDistributionSlot[] {
  if (plan.cancelledAt) return [];
  const sent = new Set(plan.sent.map((slot) => slot.key));
  return reserveDistributionSlots(plan).filter((slot) => slot.dueAt <= now && !sent.has(slot.key));
}

// ----- Anchor allocation vesting -----
// Assigning an anchor position vests that position's class allocation from the 30% anchor-reserve
// wallet to the owner's ZIR address over one year, released linearly. This is a deterministic
// schedule: every node computes the same vested-to-date figure from (start, total, now), so the
// node holding the reserve key can submit exactly the claimable delta as a real transfer. Nothing
// is minted: the reserve account is debited as releases occur, so supply accounting stays exact.

/** One year of linear vesting, in milliseconds (365 days). */
export const ANCHOR_VESTING_DURATION_MS = 365 * 24 * 60 * 60 * 1000;

export interface AnchorVestingSchedule {
  /** Total allocation to vest, in µZIR (the position's class reserve). */
  totalUZIR: uZIR;
  /** Wall-clock time vesting began (the assignment time). */
  startAt: number;
  /** Vesting duration in ms. Defaults to one year. */
  durationMs?: number;
}

/**
 * Cumulative vested amount at `now`, in µZIR. Linear from 0 at startAt to totalUZIR at
 * startAt + duration. Clamped to [0, total]; before start it is 0, after end it is the full total.
 * Deterministic and integer-valued so all nodes agree on the released figure.
 */
export function anchorVestedToDate(schedule: AnchorVestingSchedule, now: number): uZIR {
  const total = Math.max(0, Math.floor(schedule.totalUZIR));
  if (total === 0) return 0;
  const duration = schedule.durationMs && schedule.durationMs > 0 ? schedule.durationMs : ANCHOR_VESTING_DURATION_MS;
  const elapsed = now - schedule.startAt;
  if (elapsed <= 0) return 0;
  if (elapsed >= duration) return total;
  // floor keeps releases conservative (never ahead of true linear schedule) and integer-exact.
  return Math.floor((total * elapsed) / duration);
}

/**
 * The amount claimable right now given how much has already been released. Always >= 0, and never
 * more than the unreleased remainder. This is the exact µZIR a vesting-release transfer should move.
 */
export function anchorVestingClaimableUZIR(schedule: AnchorVestingSchedule, alreadyReleasedUZIR: uZIR, now: number): uZIR {
  const vested = anchorVestedToDate(schedule, now);
  const released = Math.max(0, Math.floor(alreadyReleasedUZIR));
  const claimable = vested - released;
  return claimable > 0 ? claimable : 0;
}
