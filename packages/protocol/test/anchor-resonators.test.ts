// packages/protocol/test/anchor-resonators.test.ts
// The 512 anchor RESONATORS: one operating coordinating intelligence per anchor POSITION, seeded at the
// position's class ZTI. These prove the deterministic spec derivation: ids, class ZTI seeding, and that
// every one of the 512 positions in the public registry has a backing resonator spec.
import { describe, it, expect } from "vitest";
import {
  DEFAULT_ANCHOR_CODE_COMMITMENTS, ANCHOR_CLASS_ZTI, TOTAL_ANCHOR_SEATS,
  anchorResonatorId, anchorResonatorSpec, anchorResonatorDomains,
  type AnchorClass,
} from "../src/index";

describe("anchor resonators", () => {
  it("derives a deterministic resonator id per anchor position", () => {
    expect(anchorResonatorId("A-001")).toBe("anchor-A-001");
    expect(anchorResonatorId("F-144")).toBe("anchor-F-144");
  });

  it("seeds each anchor resonator at its position's class ZTI (A 0.95 ... F 0.45)", () => {
    const expected: Record<AnchorClass, number> = { A: 0.95, B: 0.85, C: 0.75, D: 0.65, E: 0.55, F: 0.45 };
    for (const code of Object.keys(expected) as AnchorClass[]) {
      const spec = anchorResonatorSpec(`${code}-001`, code);
      expect(spec.zti).toBe(expected[code]);
      expect(spec.zti).toBe(ANCHOR_CLASS_ZTI[code]);
      expect(spec.seatId).toBe(`${code}-001`);
      expect(spec.classCode).toBe(code);
      expect(spec.domains.length).toBeGreaterThan(0);
      // the seed ZTI applies to every domain the resonator coordinates
      expect(anchorResonatorDomains(code).length).toBe(spec.domains.length);
    }
  });

  it("covers all 512 registered anchor positions with a unique resonator spec", () => {
    expect(DEFAULT_ANCHOR_CODE_COMMITMENTS.length).toBe(TOTAL_ANCHOR_SEATS);
    const ids = new Set<string>();
    for (const c of DEFAULT_ANCHOR_CODE_COMMITMENTS) {
      const spec = anchorResonatorSpec(c.seatId, c.classCode);
      expect(spec.id).toBe(`anchor-${c.seatId}`);
      expect(spec.zti).toBe(ANCHOR_CLASS_ZTI[c.classCode]);
      ids.add(spec.id);
    }
    expect(ids.size).toBe(TOTAL_ANCHOR_SEATS);
  });
});
