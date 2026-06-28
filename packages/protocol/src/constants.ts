// packages/protocol/src/constants.ts
export const PROTOCOL = {
  MAX_SUPPLY_ZIR: 28_700_000_000,
  UZIR_PER_ZIR: 1_000_000,
  MAX_SUPPLY_UZIR: 28_700_000_000 * 1_000_000,

  // Genesis reserve is 41% of supply, seeded on-ledger at block 0 and fully auditable. It is not a
  // founder premine: the bulk is reserved for anchor owners and distributed only as they redeem codes.
  //   30% anchor reserve, held in a labeled anchor-reserve wallet (founder-administered, not founder
  //        funds): released to anchor seat owners as they redeem their anchor codes, optionally vested.
  //   10% community events and airdrop reserve (transparent, claimed, never sold).
  //   1% founder operations (gas, bootstrap, ecosystem grants).
  // The remaining 59% is earned: emitted only as rewards for real work over time. Trust is earned.
  EARNED_SHARE: 0.59,                  // general emission, earned as rewards over time
  RESERVE_SHARE: 0.41,                 // genesis reserve: anchor + events + founder ops
  ANCHOR_RESERVE_SHARE: 0.30,          // anchor reserve wallet, released to seat owners on code redemption
  EVENTS_RESERVE_SHARE: 0.10,          // community events and airdrop reserve (transparent, never sold)
  FOUNDER_OPS_SHARE: 0.01,             // founder operations: gas, bootstrap, ecosystem grants
  RESERVE_UZIR: Math.round(28_700_000_000 * 0.41) * 1_000_000,        // 11.767B ZIR genesis reserve
  ANCHOR_RESERVE_UZIR: Math.round(28_700_000_000 * 0.30) * 1_000_000, // 8.61B anchor reserve (seeded to the anchor-reserve wallet)

  ACCOUNTING_ROUND_MS: 5_000,
  OBSERVATION_WINDOW_MS: 30_000,

  CV_THRESHOLD: 0.02,
  MIN_OBSERVATIONS: 3,
  FINALITY_THRESHOLD: 0.67,

  ACCURACY_WEIGHT: 0.55,
  CONSISTENCY_WEIGHT: 0.25,
  UPTIME_WEIGHT: 0.20,
  SMOOTHING: 0.08,
  ABSENCE_DECAY: 0.9997,
  STEP_BASE: 0.10,
  STEP_TRUST_FACTOR: 0.85,

  MASTER_NODE_ZTI: 0.70,
  // Sybil-resistant master admission. Reaching MASTER_NODE_ZTI is necessary but not sufficient to join
  // the finality set: trust may rise at most MAX_ZTI_ASCENT_PER_EPOCH per epoch, and a node must have
  // taken part for at least MIN_MASTER_TENURE_EPOCHS epochs with at least MIN_INDEPENDENT_SUPPORTERS
  // distinct co-observers before it becomes a master. So a fresh, perfectly-accurate identity cannot vault
  // to finality control in one window; master standing is earned over time and across distinct peers.
  // Genesis masters (the bootstrap quorum) are seeded at full trust and exempt from these gates.
  MAX_ZTI_ASCENT_PER_EPOCH: 0.02,
  MIN_MASTER_TENURE_EPOCHS: 720,        // ~1 hour at 5s epochs of continuous accurate participation
  MIN_INDEPENDENT_SUPPORTERS: 3,
  // Verifiable-work gate for the inference-free "mining/storage earns" emission. A node draws a slice of
  // the heartbeat round emission (and accrues master tenure) only if it did real on-ledger work — received
  // a settled coordination payout — within the last WORK_VALIDITY_EPOCHS. Genesis masters (bootstrap
  // infrastructure) are exempt and always eligible, so the network earns and finalizes from epoch one even
  // before any user queries. Empty heartbeats still converge for liveness but mint nothing. The gate is
  // scoped to FIELD_HEARTBEAT_SUBJECT only: real measurement subjects (oracle data) earn directly, because
  // the accurate observation IS the work there.
  WORK_VALIDITY_EPOCHS: 720,            // ~1 hour: a node that served recently keeps earning base emission
  FIELD_HEARTBEAT_SUBJECT: "ZIRA_FIELD_HEARTBEAT",  // the liveness beacon subject the work-gate applies to
  BASE_FEE_UZIR: 1_000,
  // F12: the entire transaction fee is removed from circulation and booked as burned. The sender always
  // pays the full fee (need = amount + fee), and the non-burned remainder was never credited to any
  // recipient, so recording the full fee as burned makes circulating = issued - burned exact without
  // changing any balance. (A future treasury split would credit a share to a steward-ops wallet here.)
  FEE_BURN: 1.0,
  GOV_MIN_PROPOSE_ZTI: 0.1,
  GOV_APPROVAL: 0.67,

  // cost to ask the field, on top of the base fee, paid to providers
  QUERY_PRICE_UZIR: 5_000,

  // A small share of every Resonator hire payment is routed to the founder operations wallet, the
  // rest goes to the Resonator. This funds stewardship and ecosystem work. Kept deliberately small.
  RESONATOR_FEE_SHARE: 0.05,

  // Coordination settlement split (whitepaper "Coordination settlement"). When a funded query/task
  // budget settles, it divides into five slices that always sum to the whole: contributors
  // (miners/providers, weighted by domain ZTI x confidence), the network wallet (long-term protocol
  // sustainability), the resonator pool (active anchor holders by lattice weight), a permanent burn, and
  // the ecosystem treasury. Replaces the prior single 5% steward-ops carve-off for coordination
  // settlements. Mints no ZIR (pure division of an already-funded budget); the burn slice is destroyed
  // via a bond_burn, increasing `burned` and shrinking circulating supply. The five shares sum to 1.0.
  COORD_SPLIT: {
    CONTRIBUTORS: 0.72,
    NETWORK: 0.08,
    RESONATOR_POOL: 0.10,
    BURN: 0.05,
    ECOSYSTEM: 0.05,
  },
  // When two or more contributors coordinate on a query, no single one may take more than this fraction of
  // the contributors slice, so coordination pay is genuinely shared and one model cannot dominate it by
  // self-reporting a high confidence. The excess is redistributed deterministically to the others. With a
  // lone contributor there is no one to share with, so the cap does not apply (it keeps the full slice).
  COORD_MAX_SHARE: 0.7,

  // Cost to CREATE (stand up) a new Resonator: the minimum ZIR the owner must fund the Resonator's agent
  // wallet with at creation, so it has a real operating float to learn and coordinate from day one, and
  // so standing up a Resonator carries a meaningful, non-trivial commitment (anti-spam for the Discover
  // directory). This raises the prior effective floor (20 ZIR, console-only) to a meaningful 1,000 ZIR
  // and makes it a canonical protocol constant enforced by the node. It is NOT a fee/burn and mints no
  // ZIR: it is the owner's own ZIR moved into their own Resonator's wallet (withdrawable later), so
  // supply, emission, and the genesis hash are all unchanged. Set deliberately high so a Resonator is a
  // serious, funded agent with real operating float — not a throwaway anyone can spam into the directory.
  RESONATOR_CREATION_COST_UZIR: 1000 * 1_000_000,

  // Storage-weighted emission. Hosting the field's authorized model weights is real, costly work, so a
  // contributor that serves more model data earns a bounded bonus on its emission split. The bonus is a
  // multiplier on the contributor's reward WEIGHT only (never on its trust/ZTI, which stays earned purely
  // by accurate observation), scaling linearly from 1.0 (no storage) up to 1 + BONUS_MAX once the host
  // serves REF_GIB or more, then flat. Capped so storage cannot dominate accuracy and so a self-reported
  // figure has bounded upside (true proof-of-storage is post-launch hardening). Mints no new ZIR — it only
  // reweights an already-curve-bounded emission pool — so the supply cap and genesis hash are unchanged.
  STORAGE_REWARD: {
    BONUS_MAX: 0.5,   // up to +50% emission weight for a fully provisioned storage host
    REF_GIB: 50,      // bonus saturates at 50 GiB of authorized model data served
  },
} as const;

// ----- Task lifecycle timeouts -----
// A hire moves through pending -> assigned -> delivered -> verified/released, with reaper
// driven fallbacks: an undelivered task expires and refunds; a delivered task the hirer never
// verifies auto releases. See node/core/ZiraNode.reapTasks.
export const TASK_ACCEPT_TIMEOUT_MS = 10 * 60 * 1000;        // 10 min to accept
export const TASK_DELIVER_TIMEOUT_MS = 60 * 60 * 1000;       // 1 hr to deliver
export const TASK_VERIFY_TIMEOUT_MS = 24 * 60 * 60 * 1000;   // 24 hr auto release if the hirer is silent

// ----- Adaptive, decentralized pricing -----
// Prices for asking the field, agent coordination, and hiring are not fixed: they float with live
// network conditions every node can observe (open demand vs. providers online, required trust). The
// computation is deterministic so every node arrives at the same fair price without a central setter.
export const PRICING = {
  /** Floor / reference price to ask the field (µZIR), paid to the providers that answer. */
  QUERY_BASE_UZIR: PROTOCOL.QUERY_PRICE_UZIR,
  /** Price band around demand pressure: 0.5x when supply is ample, up to 4x under heavy demand. */
  QUERY_MIN_MULT: 0.5,
  QUERY_MAX_MULT: 4,
  /** Base coordination fee for hiring a Resonator / an AI↔AI task (µZIR). */
  TASK_BASE_UZIR: 2 * PROTOCOL.QUERY_PRICE_UZIR,
  /** Extra cost for high-complexity tasks (0..1) and extra required evidence/results. */
  TASK_COMPLEXITY_WEIGHT: 1.5,
  TASK_EVIDENCE_STEP: 0.15,
} as const;

function clamp(x: number, lo: number, hi: number): number { return x < lo ? lo : x > hi ? hi : x; }

/**
 * Adaptive query price. Scales the base by demand pressure = open queries per online provider, so
 * an under-served field pays more (drawing providers in) and an over-served field settles to the
 * floor. Deterministic for a given observed state.
 */
export function adaptiveQueryPriceUZIR(ctx: { openQueries: number; providersOnline: number }): number {
  const supply = Math.max(1, ctx.providersOnline);
  const pressure = Math.max(0, ctx.openQueries) / supply;
  const mult = clamp(PRICING.QUERY_MIN_MULT + pressure * 0.5, PRICING.QUERY_MIN_MULT, PRICING.QUERY_MAX_MULT);
  return Math.round(PRICING.QUERY_BASE_UZIR * mult);
}

/**
 * Adaptive task / coordination price. The base coordination fee scales by required counterparty trust,
 * live demand pressure, task complexity, and how much independent evidence the hirer requests.
 */
export function adaptiveTaskPriceUZIR(ctx: {
  minZti?: number;
  openQueries?: number;
  providersOnline?: number;
  complexity?: number;
  evidenceCount?: number;
}): number {
  const trust = clamp(ctx.minZti ?? 0, 0, 1);
  const complexity = clamp(ctx.complexity ?? 0, 0, 1);
  const evidence = Math.max(1, Math.floor(ctx.evidenceCount ?? 1));
  const supply = Math.max(1, ctx.providersOnline ?? 1);
  const pressure = Math.max(0, ctx.openQueries ?? 0) / supply;
  const mult = clamp(
    1 + trust + pressure * 0.25 + complexity * PRICING.TASK_COMPLEXITY_WEIGHT + (evidence - 1) * PRICING.TASK_EVIDENCE_STEP,
    1,
    6,
  );
  return Math.round(PRICING.TASK_BASE_UZIR * mult);
}

// ----- Emission schedule (formal tapering curve) -----
// The 59% earned supply enters the world only as earned rewards. Per epoch reward follows a
// geometric decay (a halving curve) split three ways across the participation tiers.
export const EMISSION = {
  /** Total earned supply: 59% of 28.7B ZIR, in µZIR. */
  TOTAL_EARNED_UZIR: 16_933_000_000_000_000n,

  /**
   * Geometric decay: reward halves every HALVING_EPOCHS.
   * epoch_reward(n) = max( INITIAL >> floor(n / HALVING_EPOCHS), MINIMUM )
   */
  INITIAL_EPOCH_REWARD_UZIR: 50_000_000_000n, // 50,000 ZIR/epoch at genesis
  HALVING_EPOCHS: 2_102_400,                  // ~4 years at 1 epoch/min
  MINIMUM_EPOCH_REWARD_UZIR: 1_000_000n,      // 1 ZIR floor

  /**
   * Three way split per epoch:
   *   CONSENSUS: all active nodes, weighted by uptime ZTI
   *   INFERENCE: providers, weighted by domain ZTI × answered queries
   *   AGENT:     Resonators, weighted by verified task completions
   */
  CONSENSUS_SHARE: 0.25,
  INFERENCE_SHARE: 0.50,
  AGENT_SHARE: 0.25,
} as const;

/** Per epoch reward in µZIR. Caps at MINIMUM; the state machine caps cumulative emissions. */
export function epochReward(epochNumber: number): bigint {
  const halvings = Math.floor(epochNumber / EMISSION.HALVING_EPOCHS);
  const raw = halvings >= 0 && halvings < 63
    ? EMISSION.INITIAL_EPOCH_REWARD_UZIR >> BigInt(halvings)
    : 0n;
  return raw < EMISSION.MINIMUM_EPOCH_REWARD_UZIR ? EMISSION.MINIMUM_EPOCH_REWARD_UZIR : raw;
}

// ----- Governance -----
export const GOVERNANCE = {
  MIN_PROPOSE_ZTI: 0.10,
  APPROVAL_THRESHOLD: 0.67,
  VETO_THRESHOLD: 0.34,
  QUORUM: 0.30,
  VOTING_WINDOW_MS: 7 * 24 * 60 * 60 * 1000,
  CATEGORIES: ["fee", "emission", "zti_weights", "domain_add", "anchor_config", "upgrade"] as const,
} as const;
export type GovernanceCategory = typeof GOVERNANCE.CATEGORIES[number];

export const CRYPTO = {
  ADDRESS_PREFIX: "zir",
  CURVE: "ed25519",
  HASH: "sha3-256",
  ADDRESS_HASH_BYTES: 20,
} as const;

export type NetworkId = "devnet" | "testnet" | "mainnet";
export const NETWORKS: Record<NetworkId, { id: NetworkId; human: string; zirLive: boolean }> = {
  devnet:  { id: "devnet",  human: "Devnet (local)", zirLive: false },
  testnet: { id: "testnet", human: "Testnet",        zirLive: false },
  mainnet: { id: "mainnet", human: "Mainnet",        zirLive: true  },
};

// Anchors are 512 ZRC-1 structural positions in the coordination topology. Ownership can exist
// before activation; routing revenue starts only after the future activation gate opens.
export const ANCHOR_CLASSES = {
  A: { name: "Genesis", seats: 16, tier: "inner" as const, weight: 6, minZTI: 0.95, stakeZIR: 10_000_000, role: "Core convergence: route the highest trust coordination flow." },
  B: { name: "Meridian", seats: 32, tier: "inner" as const, weight: 5, minZTI: 0.85, stakeZIR: 5_000_000, role: "Coordination backbone: sustain the main topology paths." },
  C: { name: "Nexus", seats: 64, tier: "inner" as const, weight: 4, minZTI: 0.75, stakeZIR: 2_000_000, role: "Signal propagation: connect domains, models, and agents." },
  D: { name: "Lattice", seats: 96, tier: "outer" as const, weight: 3, minZTI: 0.65, stakeZIR: 1_000_000, role: "Structural mesh: maintain regional and domain routing structure." },
  E: { name: "Sentinel", seats: 160, tier: "outer" as const, weight: 2, minZTI: 0.55, stakeZIR: 500_000, role: "Peripheral support: observe, relay, and protect boundary flow." },
  F: { name: "Foundation", seats: 144, tier: "outer" as const, weight: 1, minZTI: 0.45, stakeZIR: 100_000, role: "Boundary completion: widen continuity and access." },
} as const;
export type AnchorClass = keyof typeof ANCHOR_CLASSES;
export const TOTAL_ANCHOR_SEATS = 512;
export const ANCHOR_TOTALS = { innerSeats: 112, outerSeats: 400, totalSeats: TOTAL_ANCHOR_SEATS } as const;
export const ANCHOR_ACTIVATION_ENABLED = false;

// ----- Refined per-position anchor allocations -----
// Each of the 512 anchor positions is a transferable RESONATOR asset that carries a ZIR allocation
// (reserve-backed, vested to its owner over a year), a class ZTI standing, and a routing weight. The
// allocation depends on whether the position is part of the genesis-reserved half (the half each class
// seeds to the steward at launch, modeled on the original mainnet reserve set) or the open half:
//   - RESERVED positions carry 2x the website figure (A 100M, B 70M, C 50M, D 25M, E 10M, F 3M ZIR).
//   - OPEN positions carry 1x the website figure (A 50M, B 35M, C 25M, D 12.5M, E 5M, F 1.5M ZIR).
// Reconciliation (see anchors.ts ANCHOR_ALLOCATION_AUDIT): 256 reserved positions sum to 5.736B ZIR and
// 256 open positions sum to 2.868B ZIR, for 8.604B ZIR total. The 30% anchor reserve is 8.61B ZIR, so
// ~6M ZIR remains as an unallocated buffer in the reserve wallet. ANCHOR_RESERVE_UZIR is deliberately
// left at 8.61B: changing it would alter the seeded genesis supply and the genesis hash, which would
// require a mainnet relaunch. The buffer is documented, not removed.
//
// The class "seats split" is exactly half reserved / half open per class: A 8/8, B 16/16, C 32/32,
// D 48/48, E 80/80, F 72/72 -> 256 reserved + 256 open = 512 positions.
/** Website per-position figure (1x) per class, in whole ZIR. The open half carries this; reserved 2x. */
export const ANCHOR_POSITION_ZIR_1X: Record<AnchorClass, number> = {
  A: 50_000_000, B: 35_000_000, C: 25_000_000, D: 12_500_000, E: 5_000_000, F: 1_500_000,
};
/** Class ZTI standing each anchor resonator is seeded at (the website per-class level). */
export const ANCHOR_CLASS_ZTI: Record<AnchorClass, number> = {
  A: 0.95, B: 0.85, C: 0.75, D: 0.65, E: 0.55, F: 0.45,
};

/**
 * The ZIR allocation a position carries, in µZIR. `reserved` positions (the genesis-reserved half each
 * class seeds to the steward) carry 2x the website figure; open positions carry 1x. This is the amount
 * that vests to the position's owner over the one-year settlement period.
 */
export function anchorPositionAllocationUZIR(classCode: AnchorClass, reserved: boolean): number {
  const base = ANCHOR_POSITION_ZIR_1X[classCode] * PROTOCOL.UZIR_PER_ZIR;
  return reserved ? base * 2 : base;
}

// Universal domain taxonomy. Measurement domains accept POST /rpc/observation. Inference domains
// are updated through query fusion receipts and verified work, so models and Resonators earn ZTI by
// producing useful outputs rather than by hand-submitting observations.
export const DOMAIN_META = {
  compute:   { label: "Compute",   desc: "Benchmarks, hardware telemetry, throughput.",          observationType: "measurement" },
  energy:    { label: "Energy",    desc: "Power consumption, renewable output, grid state.",      observationType: "measurement" },
  carbon:    { label: "Carbon",    desc: "CO2 levels, emission factors, carbon credits.",         observationType: "measurement" },
  data:      { label: "Data",      desc: "Dataset quality, freshness, coverage.",                 observationType: "measurement" },
  currency:  { label: "Currency",  desc: "Exchange rates, price feeds, on-chain value.",          observationType: "measurement" },
  goods:     { label: "Goods",     desc: "Product prices, availability, provenance.",             observationType: "measurement" },
  code:      { label: "Code",      desc: "Software quality, test results, audits.",               observationType: "measurement" },
  science:   { label: "Science",   desc: "Reproducible scientific measurements.",                 observationType: "measurement" },
  reasoning: { label: "Reasoning", desc: "Logical inference, math accuracy, consistency.",        observationType: "inference"   },
  language:  { label: "Language",  desc: "Translation quality, summarization, factual accuracy.", observationType: "inference"   },
  vision:    { label: "Vision",    desc: "Images, diagrams, OCR, visual grounding.",              observationType: "inference"   },
  audio:     { label: "Audio",     desc: "Speech, sound, music, transcription quality.",          observationType: "inference"   },
  video:     { label: "Video",     desc: "Temporal visual understanding and video generation.",    observationType: "inference"   },
  robotics:  { label: "Robotics",  desc: "Embodied planning, control signals, spatial action.",   observationType: "inference"   },
  medicine:  { label: "Medicine",  desc: "Clinical reasoning, biomedical evidence, safety.",      observationType: "inference"   },
  law:       { label: "Law",       desc: "Legal reasoning, policy, compliance, contracts.",       observationType: "inference"   },
  finance:   { label: "Finance",   desc: "Markets, risk, treasury, accounting, value flows.",     observationType: "inference"   },
  education: { label: "Education", desc: "Tutoring, curricula, explanations, assessment.",        observationType: "inference"   },
  creative:  { label: "Creative",  desc: "Design, writing, image/video/audio creative work.",     observationType: "inference"   },
  security:  { label: "Security",  desc: "Threat modeling, audits, incident reasoning.",          observationType: "inference"   },
  planning:  { label: "Planning",  desc: "Multi-step strategy, scheduling, operations.",          observationType: "inference"   },
  multimodal:{ label: "Multimodal",desc: "Coordination across text, image, audio, video, tools.", observationType: "inference"   },
  general:   { label: "General",   desc: "Cross-domain or unclassified.",                         observationType: "inference"   },
} as const;
export type Domain = keyof typeof DOMAIN_META;
export const DOMAINS = Object.keys(DOMAIN_META) as Domain[];

// ----- Model modality (type) taxonomy -----
// The serving/model field is multi-modal by design: the steward can add many model TYPES over time.
// A model is registered with a modality plus its capability domains, and field queries/tasks route to
// models of the matching type+domain. The peer-to-peer GGUF serving still carries text/code models
// today; image/video/audio/other are first-class so the registry and routing are ready for them.
export const MODEL_TYPE_META = {
  text:  { label: "Text",  desc: "General language: chat, summarization, reasoning, factual answers.", domains: ["language", "reasoning", "general", "education", "law", "medicine", "finance", "science"] as Domain[] },
  code:  { label: "Code",  desc: "Programming: generation, review, debugging, refactoring, tests.",     domains: ["code", "reasoning", "security", "planning"] as Domain[] },
  image: { label: "Image", desc: "Vision and image generation/understanding, OCR, diagrams.",          domains: ["vision", "creative", "multimodal"] as Domain[] },
  video: { label: "Video", desc: "Temporal visual understanding and video generation.",                domains: ["video", "creative", "multimodal"] as Domain[] },
  audio: { label: "Audio", desc: "Speech, music, transcription, and audio generation.",                domains: ["audio", "creative", "multimodal"] as Domain[] },
  other: { label: "Other", desc: "Any other modality: embeddings, robotics, tools, multimodal.",       domains: ["robotics", "multimodal", "general"] as Domain[] },
} as const;
export type ModelType = keyof typeof MODEL_TYPE_META;
export const MODEL_TYPES = Object.keys(MODEL_TYPE_META) as ModelType[];

/** The default capability domains for a model type, used when a model is registered without explicit
 * domains so routing still has something to match on. */
export function defaultDomainsForModelType(type: ModelType): Domain[] {
  return [...MODEL_TYPE_META[type].domains];
}

/** Whether a model of the given type+domains can serve a query in `domain`. A model serves its
 * declared domains; an undeclared/empty domain set falls back to the type's default domains. A `text`
 * or `other` model also acts as a generalist for the catch-all `general` domain. */
export function modelServesDomain(type: ModelType, domains: Domain[] | undefined, domain: Domain): boolean {
  const eff = domains && domains.length ? domains : defaultDomainsForModelType(type);
  if (eff.includes(domain)) return true;
  if (domain === "general" && (type === "text" || type === "other")) return true;
  return false;
}

/** Map a query domain to the model TYPE that should primarily answer it. Used so a code query routes
 * to a code model, a vision query to an image model, etc., with text as the universal fallback. */
export function preferredModelTypeForDomain(domain: Domain): ModelType {
  switch (domain) {
    case "code": return "code";
    case "vision": return "image";
    case "video": return "video";
    case "audio": return "audio";
    case "robotics": return "other";
    default: return "text";
  }
}

export type NetworkPhase = "formation" | "first_release" | "live";

// Well known non spendable coordinator addresses. The relay escrow holds query fees
// while answers are collected, then releases them to the providers who contributed.
// These are policy addresses moved by the coordinator under the protocol rules, not by a key.
export const SPECIAL_ADDRESSES = {
  RELAY_ESCROW: "zira-relay-escrow",
} as const;

export const BRAND = {
  bgBase: "#070B14", bgSurface: "#0F1422", bgElevated: "#161D30",
  border: "rgba(255,255,255,0.08)", borderStrong: "rgba(255,255,255,0.14)",
  text: "#E8ECF4", textMuted: "#9AA6BD", textFaint: "#5C6781",
  teal: "#3ECFC0", indigo: "#6B8CE8", mist: "#E8FCF7",
  warn: "#E8B84B", danger: "#E8736B", neutral: "#6B7690",
  gradient: "linear-gradient(135deg, #E8FCF7 0%, #3ECFC0 38%, #6B8CE8 100%)",
} as const;
