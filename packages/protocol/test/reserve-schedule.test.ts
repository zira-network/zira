// packages/protocol/test/reserve-schedule.test.ts
// Local reserve distribution plans are deterministic schedule math; funds only move when due slots
// are signed and submitted as reserve_grant transactions.
import { describe, it, expect } from "vitest";
import { dueReserveDistributionSlots, reserveDistributionSlots, type ReserveDistributionPlan } from "../src/reserve";

const DAY = 24 * 60 * 60 * 1000;

function plan(patch: Partial<ReserveDistributionPlan> = {}): ReserveDistributionPlan {
  return {
    id: "reserve-plan-test",
    targets: ["zir1target"],
    amountPerTargetUZIR: 1_000_000,
    startAt: 1_700_000_000_000,
    endAt: 1_700_000_000_000 + 2 * DAY,
    cadence: "daily",
    reason: "test reserve schedule",
    createdAt: 1_700_000_000_000,
    sent: [],
    ...patch,
  };
}

describe("reserve distribution schedules", () => {
  it("splits a target amount over due slots and preserves the exact total", () => {
    const slots = reserveDistributionSlots(plan({ amountPerTargetUZIR: 10 }));
    expect(slots).toHaveLength(3);
    expect(slots.map((s) => s.amountUZIR)).toEqual([4, 3, 3]);
    expect(slots.reduce((sum, slot) => sum + slot.amountUZIR, 0)).toBe(10);
  });

  it("creates independent slots for multiple targets", () => {
    const slots = reserveDistributionSlots(plan({ targets: ["zir1a", "zir1b"], amountPerTargetUZIR: 9 }));
    expect(slots).toHaveLength(6);
    expect(slots.filter((slot) => slot.to === "zir1a").reduce((sum, slot) => sum + slot.amountUZIR, 0)).toBe(9);
    expect(slots.filter((slot) => slot.to === "zir1b").reduce((sum, slot) => sum + slot.amountUZIR, 0)).toBe(9);
  });

  it("adds a final installment when the cadence does not land exactly on the end date", () => {
    const slots = reserveDistributionSlots(plan({
      endAt: 1_700_000_000_000 + 10 * DAY,
      cadence: "weekly",
    }));
    expect(slots.map((slot) => slot.dueAt)).toEqual([
      1_700_000_000_000,
      1_700_000_000_000 + 7 * DAY,
      1_700_000_000_000 + 10 * DAY,
    ]);
  });

  it("excludes already-sent and cancelled future installments from due work", () => {
    const base = plan({ amountPerTargetUZIR: 10 });
    const slots = reserveDistributionSlots(base);
    const sent = [{ key: slots[0]!.key, txId: "tx1", timestamp: base.startAt, amountUZIR: slots[0]!.amountUZIR, to: slots[0]!.to }];

    expect(dueReserveDistributionSlots({ ...base, sent }, base.endAt)).toHaveLength(2);
    expect(dueReserveDistributionSlots({ ...base, sent, cancelledAt: base.startAt + DAY }, base.endAt)).toHaveLength(0);
  });
});
