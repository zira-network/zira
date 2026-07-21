// node/src/image/ImageSafety.ts
// G1 content safety for text-to-image (2.9.0 Track A) — a HARD precondition: a public image-generation network
// carries real legal/reputational exposure (CSAM, non-consensual intimate imagery, targeted deepfakes). This
// gate runs on the PROVIDER side before any generation and on the coordinator side before a job is offered, so
// prohibited prompts are never generated and never paid. It is intentionally simple + conservative (deny on
// match) and always-on whenever image serving is enabled; a model-level safety checker on the output is a
// second layer wired at A1 integration. This is policy, not a model, so it is deterministic and auditable.
//
// Scope: this blocks the categories that are illegal or that the network refuses to produce. It is deliberately
// NOT a general "taste" filter. The prohibited categories and phrasings live here so the policy is one place.

export type SafetyVerdict = { allowed: true } | { allowed: false; category: string; reason: string };

// Categories the network refuses to generate. Each is a set of lowercase substrings; a match denies the prompt.
// Kept minimal + high-precision (the goal is the clearly-prohibited, not broad censorship). Combined with the
// output-side model safety checker (A1) for defence in depth.
const PROHIBITED: { category: string; reason: string; needles: string[] }[] = [
  {
    category: "csam",
    reason: "Sexual content involving minors is illegal and absolutely prohibited.",
    // minor terms co-occurring with sexual terms; also standalone abuse acronyms.
    needles: ["csam", "child porn", "childporn", "cp preteen", "loli", "shota", "underage nude", "minor nude", "preteen nude", "child nude", "toddler nude"],
  },
  {
    category: "ncii",
    reason: "Non-consensual intimate imagery of real people is prohibited.",
    needles: ["revenge porn", "nonconsensual nude", "non-consensual nude", "deepfake nude", "nude of my ex", "undress photo of"],
  },
  {
    category: "extremist",
    reason: "Content promoting terrorism or mass violence is prohibited.",
    needles: ["how to build a bomb image", "terrorist propaganda poster", "isis recruitment", "mass shooting glorif"],
  },
];

// Sexual + minor co-occurrence catch (either ordering), for prompts that split the terms.
const MINOR_WORDS = ["child", "children", "kid", "kids", "minor", "minors", "toddler", "infant", "preteen", "underage", "prepubescent", "boy", "girl", "teen", "teenager"];
const SEXUAL_WORDS = ["nude", "naked", "sex", "sexual", "porn", "explicit", "nsfw", "erotic", "genital", "aroused", "intercourse"];

const norm = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[\s_]+/g, " ").trim();

/** Screen a text-to-image prompt (positive + negative). Deny on any prohibited match. Conservative by design:
 * when a minor term and a sexual term co-occur, deny regardless of phrasing. */
export function screenImagePrompt(prompt: string, negativePrompt = ""): SafetyVerdict {
  const text = norm(`${prompt} ${negativePrompt}`);
  for (const p of PROHIBITED) {
    for (const n of p.needles) if (text.includes(n)) return { allowed: false, category: p.category, reason: p.reason };
  }
  const hasMinor = MINOR_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(text));
  const hasSexual = SEXUAL_WORDS.some((w) => new RegExp(`\\b${w}\\b`).test(text));
  if (hasMinor && hasSexual) {
    return { allowed: false, category: "csam", reason: "Sexual content involving minors is illegal and absolutely prohibited." };
  }
  return { allowed: true };
}

/** Convenience boolean for hot paths. */
export function isImagePromptAllowed(prompt: string, negativePrompt = ""): boolean {
  return screenImagePrompt(prompt, negativePrompt).allowed;
}
