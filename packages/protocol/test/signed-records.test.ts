// packages/protocol/test/signed-records.test.ts
// The Signed mixin authenticates every soft-state record. signRecord/verifyRecord must round-trip
// and must reject tampering or a mismatched key.
import { describe, it, expect } from "vitest";
import { signRecord, verifyRecord, recordOwnerMatches, generateKeypair } from "../src/crypto";

describe("signed records", () => {
  const kp = generateKeypair();

  it("round-trips for a resonator-like record", () => {
    const rec = signRecord({ id: "r1", owner: kp.address, name: "Ada", updatedAt: 1 }, kp.privateKey);
    expect(rec.pubKey).toBe(kp.publicKey);
    expect(verifyRecord(rec)).toBe(true);
    expect(recordOwnerMatches(rec, kp.address)).toBe(true);
  });

  it("round-trips for a provider profile and a listing", () => {
    const profile = signRecord({ address: kp.address, label: "p", domains: ["general"], updatedAt: 9 }, kp.privateKey);
    expect(verifyRecord(profile)).toBe(true);
    const listing = signRecord({ resonatorId: "x", owner: kp.address, priceUZIR: 5 }, kp.privateKey);
    expect(verifyRecord(listing)).toBe(true);
  });

  it("returns false for tampered content", () => {
    const rec = signRecord({ id: "r1", owner: kp.address, name: "Ada", updatedAt: 1 }, kp.privateKey);
    const tampered = { ...rec, name: "Eve" };
    expect(verifyRecord(tampered)).toBe(false);
  });

  it("returns false when the pubKey is swapped to another identity", () => {
    const other = generateKeypair();
    const rec = signRecord({ id: "r1", owner: kp.address, updatedAt: 1 }, kp.privateKey);
    const swapped = { ...rec, pubKey: other.publicKey };
    expect(verifyRecord(swapped)).toBe(false);
    expect(recordOwnerMatches(swapped, kp.address)).toBe(false);
  });

  it("returns false for an unsigned record", () => {
    expect(verifyRecord({ pubKey: "", sig: "" } as any)).toBe(false);
    expect(verifyRecord({} as any)).toBe(false);
  });
});
