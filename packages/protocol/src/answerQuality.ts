// packages/protocol/src/answerQuality.ts
// Shared, deterministic answer-quality primitives used by BOTH the node (serving + fusion) and the Console
// client (client-side coordination). Keeping one implementation here means the coherence gate that protects
// a user's answer is identical no matter which path evaluates it. These are pure heuristics over the answer
// text: they carry NO consensus weight (confidence and coherence are soft/off-root), they only decide which
// answers are shown to a user and how they are weighted in coordination.

/** Heuristic garbage/incoherence detector for a field answer. Catches the broken-model failure mode a user
 * saw ("clock!!!!!!!!!!!!" for "what is 4*5"): a long run of one repeated character, an answer dominated by
 * punctuation, or a long string with essentially no distinct words. Short factual answers ("20", "Paris")
 * pass. Pure/deterministic; used to drop junk before it ever reaches a user. */
export function looksLikeGarbage(s: string): boolean {
  const t = (s || "").trim();
  if (t.length < 1) return true;
  if (/(.)\1{9,}/.test(t)) return true; // 10+ of the same char in a row
  const nonAlnum = t.replace(/[a-z0-9\s]/gi, "");
  if (nonAlnum.length > 12 && nonAlnum.length / t.length > 0.5) return true; // punctuation spam
  const words = new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1));
  if (t.length > 24 && words.size <= 1) return true; // long but one/zero real words
  return false;
}

/** True when a field answer is coherent enough to present to a user. Inverse of looksLikeGarbage, named
 * positively for readable call sites. */
export function isCoherentAnswer(s: string): boolean {
  return !looksLikeGarbage(s);
}

/** True when two answers share most of their significant vocabulary, so fusion folds them by weight instead
 * of listing the same point twice, and so agreement can be measured across a coordinating panel. */
export function isNearDuplicate(a: string, b: string): boolean {
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  const sa = words(a), sb = words(b);
  if (sa.size === 0 || sb.size === 0) return false;
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared++;
  return shared / Math.min(sa.size, sb.size) >= 0.8;
}

/** A real, self-derived confidence in [0.30, 0.95] for a generated answer, replacing the old hardcoded
 * constant so that ZTI x confidence weighting actually means something. There are no logprobs available from
 * the llama.cpp / OpenAI-compatible paths, so confidence is derived from observable answer shape:
 *   - garbage or empty answers collapse to the floor,
 *   - very short or truncated-looking answers are penalized,
 *   - answers with real sentence structure and adequate length score higher.
 * This is a soft signal (never in the state root); it only ranks answers in coordination. Deterministic in
 * the answer text so two nodes scoring the same text agree. */
export function answerConfidence(answer: string): number {
  const t = (answer || "").trim();
  if (t.length === 0 || looksLikeGarbage(t)) return 0.3;
  const words = t.split(/\s+/).filter(Boolean).length;
  const sentences = t.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 0).length;
  let c = 0.55;
  // Length adequacy: a one-word answer can be right (a fact) but carries less standalone signal; a few
  // complete sentences read as a considered answer.
  if (words >= 3) c += 0.1;
  if (words >= 12) c += 0.1;
  if (sentences >= 1) c += 0.05;
  if (sentences >= 2) c += 0.05;
  // Truncation smell: ends mid-word / with a dangling comma. Slightly lower confidence.
  if (/[,;:]$/.test(t) || /\b\w{1,2}$/.test(t) === false && /[^.!?\])"']$/.test(t) && words > 20) c -= 0.05;
  // Contains a code block or structured content: usually a deliberate, complete answer.
  if (/```|\n\s*[-*\d]/.test(t)) c += 0.05;
  return Math.max(0.3, Math.min(0.95, Number(c.toFixed(3))));
}
