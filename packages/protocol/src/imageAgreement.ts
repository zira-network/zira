// Perceptual-hash agreement for text-to-image coordination (ZIRA 2.9.0, Track A / crux).
//
// THE PROBLEM this solves: image generation is NOT bitwise-deterministic across hardware. The same prompt,
// seed, model, and params on an Nvidia vs AMD vs CPU backend produce slightly different pixels (float-op order
// differs). So the field's text agreement ("N providers converge by textual Jaccard") CANNOT verify images:
// two honest providers will never produce byte-identical output. If we hashed the bytes, no two would ever
// agree and no payout could settle.
//
// THE DESIGN: agreement by PERCEPTUAL similarity, not bytes. Each provider generates the image, computes a
// small perceptual hash (dHash) of it locally, and COMMITS only {provider, pHash, seed, modelId, paramsHash}.
// The image bytes themselves NEVER enter consensus (too big) and flow out of band (asker <- provider). The
// settler groups commitments that share the same (seed, modelId, paramsHash) and finds the largest cluster of
// pHashes that are mutually within a Hamming threshold; if that cluster reaches the agreement count, the result
// is accepted and the agreeing providers are paid. `imageAgreementOutcome` is a PURE function of the committed
// data, so the payout it drives stays a settler-signed / pure-epoch fork-safe operation exactly like the field
// payout — every node computes the identical outcome from the identical commitments.
//
// This module is engine-agnostic and image-decoder-agnostic: the node decodes an image to grayscale luma and
// calls dHash(); the protocol only ever compares the resulting hex hashes. Nothing here loads a model or reads
// pixels from disk, so it is safe to run inside consensus.

import { hashHex } from "./crypto";
import { canonical } from "./serialize";
import { PRICING } from "./constants";

/** Default perceptual-agreement parameters. Tunable; committed at the activation epoch so every node agrees. */
export const IMAGE_AGREEMENT = {
  /** dHash side: an N x (N+1) grayscale grid compared horizontally yields N*N bits. 8 -> a 64-bit hash. */
  HASH_SIDE: 8,
  /** Max Hamming distance (in bits) for two perceptual hashes to count as the "same" image. ~10% of 64 bits
   * tolerates honest cross-hardware float drift while still rejecting a different image (which differs ~50%). */
  MAX_HAMMING: 6,
  /** Minimum number of mutually-agreeing providers required to settle an image result. */
  MIN_AGREE: 2,
} as const;

/** A single provider's commitment for one image job. Only these small fields are ever gossiped/settled; the
 * image bytes are delivered out of band. `paramsHash` binds the generation params (steps, cfg, size, sampler)
 * so only providers who ran the IDENTICAL job are compared. */
export interface ImageCommitment {
  provider: string;   // provider address
  pHash: string;      // lowercase hex perceptual hash (dHash)
  seed: number;       // generation seed (fixed per job so outputs are comparable)
  modelId: string;    // model the image was generated with
  paramsHash: string; // hash of the canonical generation params
}

export interface ImageAgreementResult {
  agreed: boolean;
  /** Addresses of the providers in the winning perceptual cluster (to be paid). */
  agreeingProviders: string[];
  /** A representative hash of the agreed cluster (the lexicographically smallest, for determinism). */
  canonicalHash: string | null;
}

/** Perceptual hash (dHash) of a grayscale image. `luma` is row-major 8-bit grayscale of size width*height.
 * Downscales (nearest-neighbour, deterministic integer math) to side x (side+1), then sets one bit per row
 * per adjacent-pixel comparison. Robust to small pixel differences (the whole point), identical for identical
 * input bytes. Returns lowercase hex, zero-padded to ceil(side*side/4) nibbles. */
export function dHash(luma: Uint8Array | number[], width: number, height: number, side: number = IMAGE_AGREEMENT.HASH_SIDE): string {
  if (!width || !height || width < 1 || height < 1) throw new Error("dHash: bad dimensions");
  const cols = side + 1, rows = side;
  // Nearest-neighbour sample into a rows x cols small grid.
  const small = new Array<number>(rows * cols);
  for (let y = 0; y < rows; y++) {
    const sy = Math.min(height - 1, Math.floor((y * height) / rows));
    for (let x = 0; x < cols; x++) {
      const sx = Math.min(width - 1, Math.floor((x * width) / cols));
      small[y * cols + x] = (luma[sy * width + sx] ?? 0) & 0xff;
    }
  }
  // One bit per (row, adjacent-column) comparison: bit set if left pixel is brighter than its right neighbour.
  let bits = "";
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < side; x++) {
      bits += (small[y * cols + x] ?? 0) > (small[y * cols + x + 1] ?? 0) ? "1" : "0";
    }
  }
  // Pack the bit string into hex nibbles.
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4).padEnd(4, "0"), 2).toString(16);
  }
  return hex;
}

/** Hamming distance (differing bits) between two equal-length hex hashes. Returns Infinity if lengths differ,
 * so mismatched hash configs never spuriously "agree". */
export function hammingHex(a: string, b: string): number {
  if (a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = (parseInt(a[i] ?? "0", 16) ^ parseInt(b[i] ?? "0", 16)) & 0xf;
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/** Whether two perceptual hashes represent the same image within the threshold. */
export function imagesAgree(a: string, b: string, maxHamming: number = IMAGE_AGREEMENT.MAX_HAMMING): boolean {
  return hammingHex(a, b) <= maxHamming;
}

/** The settler's decision for one image job. PURE: identical commitments -> identical outcome on every node.
 * Considers only commitments sharing the job's (seed, modelId, paramsHash); finds the largest cluster of
 * providers whose hashes are all within maxHamming of a common member; settles if the cluster >= minAgree.
 * One commitment per provider is honoured (a provider cannot pad the cluster with duplicates). */
export function imageAgreementOutcome(
  commitments: ImageCommitment[],
  opts: { seed: number; modelId: string; paramsHash: string; maxHamming?: number; minAgree?: number },
): ImageAgreementResult {
  const maxHamming = opts.maxHamming ?? IMAGE_AGREEMENT.MAX_HAMMING;
  const minAgree = opts.minAgree ?? IMAGE_AGREEMENT.MIN_AGREE;
  const none: ImageAgreementResult = { agreed: false, agreeingProviders: [], canonicalHash: null };

  // Filter to this exact job, then keep one commitment per provider (deterministic: lexicographically smallest
  // hash), and order by (hash, provider) so clustering is order-independent across nodes.
  const byProvider = new Map<string, ImageCommitment>();
  for (const c of commitments) {
    if (c.seed !== opts.seed || c.modelId !== opts.modelId || c.paramsHash !== opts.paramsHash) continue;
    if (!/^[0-9a-f]+$/.test(c.pHash)) continue;
    const prev = byProvider.get(c.provider);
    if (!prev || c.pHash < prev.pHash) byProvider.set(c.provider, c);
  }
  const items = [...byProvider.values()].sort((x, y) => x.pHash < y.pHash ? -1 : x.pHash > y.pHash ? 1 : (x.provider < y.provider ? -1 : 1));
  if (items.length < minAgree) return none;

  // For each candidate centre, gather all providers within threshold; take the largest such cluster (ties
  // broken by the smallest canonical hash) so the result is deterministic.
  let best: { members: ImageCommitment[]; canonical: string } | null = null;
  for (const centre of items) {
    const members = items.filter((it) => hammingHex(centre.pHash, it.pHash) <= maxHamming);
    // centre is always in its own cluster (distance 0), so its hash is a safe, defined reduce seed.
    const canonical = members.reduce((m, it) => (it.pHash < m ? it.pHash : m), centre.pHash);
    if (!best || members.length > best.members.length || (members.length === best.members.length && canonical < best.canonical)) {
      best = { members, canonical };
    }
  }
  if (!best || best.members.length < minAgree) return none;
  return {
    agreed: true,
    agreeingProviders: best.members.map((m) => m.provider).sort(),
    canonicalHash: best.canonical,
  };
}

// ---- Image job: request params, canonical hashing, deterministic ids, and (dormant) pricing ----

/** Generation params that define one image job. Bound into the paramsHash so only providers who ran the
 * IDENTICAL job are compared for agreement. Kept minimal + normalized so the hash is stable across clients. */
export interface ImageParams {
  width: number;
  height: number;
  steps: number;
  cfg: number;            // classifier-free guidance scale
  sampler: string;
  negativePrompt: string;
}

export const IMAGE_DEFAULTS: ImageParams = {
  width: 512, height: 512, steps: 20, cfg: 7, sampler: "euler_a", negativePrompt: "",
};

/** Bounds — also the anti-abuse guard (G6): huge sizes/steps are expensive compute and are rejected, not
 * silently run. Dimensions snap to multiples of 64 (SD requirement) within [256, 1024]. */
export const IMAGE_BOUNDS = {
  MIN_DIM: 256, MAX_DIM: 1024, DIM_STEP: 64,
  MIN_STEPS: 1, MAX_STEPS: 50,
  MIN_CFG: 1, MAX_CFG: 20,
} as const;

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
const snapDim = (n: number) => {
  const s = Math.round(clamp(n, IMAGE_BOUNDS.MIN_DIM, IMAGE_BOUNDS.MAX_DIM) / IMAGE_BOUNDS.DIM_STEP) * IMAGE_BOUNDS.DIM_STEP;
  return clamp(s, IMAGE_BOUNDS.MIN_DIM, IMAGE_BOUNDS.MAX_DIM);
};

/** Normalize + clamp partial params to a valid, bounded, canonical ImageParams. Deterministic. */
export function normalizeImageParams(p?: Partial<ImageParams>): ImageParams {
  const d = IMAGE_DEFAULTS;
  const sampler = String(p?.sampler ?? d.sampler).toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 32) || d.sampler;
  return {
    width: snapDim(Math.round(Number(p?.width ?? d.width)) || d.width),
    height: snapDim(Math.round(Number(p?.height ?? d.height)) || d.height),
    steps: Math.round(clamp(Number(p?.steps ?? d.steps) || d.steps, IMAGE_BOUNDS.MIN_STEPS, IMAGE_BOUNDS.MAX_STEPS)),
    cfg: clamp(Number(p?.cfg ?? d.cfg) || d.cfg, IMAGE_BOUNDS.MIN_CFG, IMAGE_BOUNDS.MAX_CFG),
    sampler,
    negativePrompt: String(p?.negativePrompt ?? "").slice(0, 2000),
  };
}

/** Canonical hash of normalized params — the binding used in ImageCommitment.paramsHash. */
export function imageParamsHash(p?: Partial<ImageParams>): string {
  return hashHex(canonical(normalizeImageParams(p)));
}

/** Deterministic image job id from the signed request fields, so every node/provider agrees which job a
 * commitment belongs to. */
export function imageJobId(prompt: string, params: Partial<ImageParams> | undefined, modelId: string, seed: number, asker: string): string {
  return hashHex(canonical({ prompt: String(prompt).slice(0, 4000), paramsHash: imageParamsHash(params), modelId, seed, asker }));
}

/** Image pricing (µZIR). Images are heavy compute so they cost a multiple of the text query base, scaled by
 * pixels and steps, bounded. DORMANT until IMAGE_PRICING.ACTIVATION_EPOCH (returns the plain query base) so
 * shipping is inert until we arm it — same discipline as queryTierMultiplier. */
export const IMAGE_PRICING = {
  /** Base image job costs this multiple of a text query at 512x512 / 20 steps. */
  BASE_MULT: 8,
  /** Reference job for the scale factor. */
  REF_PIXELS: 512 * 512,
  REF_STEPS: 20,
  /** Ceiling so a max job cannot cost more than this multiple of the base image price. */
  MAX_FACTOR: 6,
  /** 0 = dormant (image pricing inert). Set > 0 at a coordinated activation epoch. */
  ACTIVATION_EPOCH: 0,
} as const;

export function imagePriceUZIR(params?: Partial<ImageParams>, epoch?: number, baseQueryUZIR: number = PRICING.QUERY_BASE_UZIR): number {
  const act = IMAGE_PRICING.ACTIVATION_EPOCH;
  if (!(act > 0) || (epoch !== undefined && epoch < act)) return baseQueryUZIR; // dormant: behaves like a normal query
  const p = normalizeImageParams(params);
  const pixelFactor = (p.width * p.height) / IMAGE_PRICING.REF_PIXELS;
  const stepFactor = p.steps / IMAGE_PRICING.REF_STEPS;
  const factor = Math.min(IMAGE_PRICING.MAX_FACTOR, Math.max(1, pixelFactor * stepFactor));
  return Math.round(baseQueryUZIR * IMAGE_PRICING.BASE_MULT * factor);
}
