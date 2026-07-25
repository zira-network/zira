import { describe, it, expect } from "vitest";
import { looksLikeGarbage, isCoherentAnswer, isNearDuplicate, answerConfidence } from "../src/answerQuality";

describe("answer quality primitives", () => {
  it("flags the real garbage failure mode a user saw", () => {
    expect(looksLikeGarbage("clock!!!!!!!!!!!!")).toBe(true); // 10+ repeated char
    expect(looksLikeGarbage("!!!!!!!!!!!!!!!!!!!!!!")).toBe(true); // punctuation spam
    expect(looksLikeGarbage("")).toBe(true);
    expect(looksLikeGarbage("   ")).toBe(true);
  });

  it("passes short factual answers and real prose", () => {
    expect(looksLikeGarbage("20")).toBe(false);
    expect(looksLikeGarbage("Paris")).toBe(false);
    expect(looksLikeGarbage("4 times 5 is 20.")).toBe(false);
    expect(isCoherentAnswer("The capital of France is Paris.")).toBe(true);
  });

  it("derives a real confidence that ranks complete answers above garbage", () => {
    const junk = answerConfidence("clock!!!!!!!!!!!!");
    const terse = answerConfidence("20");
    const full = answerConfidence("Four multiplied by five equals twenty. This is basic arithmetic.");
    expect(junk).toBe(0.3);
    expect(terse).toBeGreaterThan(junk);
    expect(full).toBeGreaterThan(terse);
    expect(full).toBeLessThanOrEqual(0.95);
    // deterministic in the text: same input, same output on any node
    expect(answerConfidence("20")).toBe(terse);
  });

  it("detects agreement between paraphrases and rejects unrelated answers", () => {
    const a = "The capital of France is Paris, a major European city.";
    const b = "Paris is the capital city of France and a major European city.";
    const c = "Photosynthesis converts sunlight into chemical energy in plants.";
    expect(isNearDuplicate(a, b)).toBe(true);
    expect(isNearDuplicate(a, c)).toBe(false);
  });
});
