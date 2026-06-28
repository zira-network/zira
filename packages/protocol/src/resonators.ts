// packages/protocol/src/resonators.ts
// Genesis-seeded "network" Resonators owned by the main steward/founder wallet.
//
// The 512 ANCHOR resonators are structural seats seeded on the anchor-reserve wallet
// (zir1zms84nsnv6svzycpmqa5fperfzwmgmn4xkqu6u) in the genesis doc. SEPARATELY, the network needs a set
// of general-purpose operating Resonators owned by the main steward/founder wallet
// (zir1km32wyjkya4h6utahkuckm56zgshnevy4v3a7t) so the field has coordinating intelligences across the
// model types/domains from the first block. These are transferable positions/standing (like any
// Resonator) — they are NOT new ZIR minted beyond the reserve: each is funded from the founder-ops
// allocation (the 1% already seeded in the genesis doc), so supply, genesis allocations, and the
// genesis hash are all unchanged. Resonator records are soft state (not part of the consensus state
// root), so seeding them does not alter consensus or the genesis hash.
import type { Address, Resonator } from "./types";
import { ANCHOR_CLASS_ZTI, ANCHOR_CLASSES, PROTOCOL, type AnchorClass, type Domain, type ModelType } from "./constants";
import { keypairFromPrivate, hashHex } from "./crypto";

/** The main steward/founder wallet that owns the seeded network Resonators (mainnet). Fresh for launch. */
export const MAINNET_NETWORK_RESONATOR_OWNER: Address = "zir1km32wyjkya4h6utahkuckm56zgshnevy4v3a7t";

export interface NetworkResonatorSpec {
  /** Stable id, deterministic across nodes. */
  id: string;
  name: string;
  purpose: string;
  systemPrompt: string;
  /** The model TYPE this Resonator coordinates (so it routes alongside the matching model modality). */
  modelType: ModelType;
  /** Capability domains this Resonator coordinates. */
  domains: Domain[];
  /** Seeded structural ZTI standing (overall) for this operating Resonator. */
  zti: number;
}

// One general-purpose operating Resonator per model TYPE plus a cross-domain field coordinator. Seeded
// ZTI is deliberately moderate (below the top anchor classes): these are working coordinators, not
// genesis trust grants. They earn/lose ZTI normally through PoR + coordination after launch.
export const NETWORK_RESONATOR_SPECS: readonly NetworkResonatorSpec[] = [
  {
    id: "network-text-coordinator",
    name: "Network Text Coordinator",
    purpose: "Coordinates general language queries — chat, summarization, reasoning, factual answers — across text models in the field.",
    systemPrompt: "You coordinate ZIRA's text intelligence. Route language/reasoning queries to text models, gather contributions, and converge on a trustworthy answer.",
    modelType: "text",
    domains: ["language", "reasoning", "general", "education"],
    zti: 0.6,
  },
  {
    id: "network-code-coordinator",
    name: "Network Code Coordinator",
    purpose: "Coordinates programming work — generation, review, debugging, refactoring, tests — across code models in the field.",
    systemPrompt: "You coordinate ZIRA's coding intelligence. Route code/security/planning queries to code models and converge on correct, reviewed solutions.",
    modelType: "code",
    domains: ["code", "reasoning", "security", "planning"],
    zti: 0.6,
  },
  {
    id: "network-image-coordinator",
    name: "Network Image Coordinator",
    purpose: "Coordinates vision and image generation/understanding — OCR, diagrams, visual grounding — across image models.",
    systemPrompt: "You coordinate ZIRA's image intelligence. Route vision/creative queries to image models and converge on grounded visual results.",
    modelType: "image",
    domains: ["vision", "creative", "multimodal"],
    zti: 0.5,
  },
  {
    id: "network-video-coordinator",
    name: "Network Video Coordinator",
    purpose: "Coordinates temporal visual understanding and video generation across video models.",
    systemPrompt: "You coordinate ZIRA's video intelligence. Route video/creative queries to video models and converge on coherent temporal results.",
    modelType: "video",
    domains: ["video", "creative", "multimodal"],
    zti: 0.5,
  },
  {
    id: "network-audio-coordinator",
    name: "Network Audio Coordinator",
    purpose: "Coordinates speech, music, transcription, and audio generation across audio models.",
    systemPrompt: "You coordinate ZIRA's audio intelligence. Route audio/creative queries to audio models and converge on accurate audio results.",
    modelType: "audio",
    domains: ["audio", "creative", "multimodal"],
    zti: 0.5,
  },
  {
    id: "network-multimodal-coordinator",
    name: "Network Multimodal Coordinator",
    purpose: "Coordinates across text, image, audio, video, and tools — routing mixed-modality queries to the right specialist coordinators.",
    systemPrompt: "You coordinate ZIRA's multimodal intelligence. Decompose mixed-modality queries and route each part to the right type coordinator, then fuse.",
    modelType: "other",
    domains: ["multimodal", "general", "planning"],
    zti: 0.55,
  },
  {
    id: "network-field-coordinator",
    name: "Network Field Coordinator",
    purpose: "Cross-domain field coordinator: tracks model coverage, provider/miner availability, task routing, and trust learning across the whole field.",
    systemPrompt: "You coordinate the ZIRA field as a whole. Watch model/type coverage, provider health, task routing, and ZTI learning, and keep coordination flowing.",
    modelType: "text",
    domains: ["planning", "reasoning", "general", "science"],
    zti: 0.6,
  },
];

/** Number of seeded network Resonators (documented for the launch record). */
export const NETWORK_RESONATOR_COUNT = NETWORK_RESONATOR_SPECS.length;

// ----- Anchor Resonators -----
// Each of the 512 ANCHOR POSITIONS is also backed by an operating RESONATOR entity. The anchor record
// (Anchor, in the consensus state) is the structural seat: class, ZTI standing, routing weight, and the
// reserve-backed ZIR allocation. The anchor RESONATOR (a soft-state Resonator, like every other) is the
// working coordinating intelligence that the position's owner actually operates and lists in the Field
// Exchange. The steward anchor-reserve wallet owns all 512 anchor resonators at genesis (one per
// position, seeded with the position's class ZTI); a position and its resonator move together to an
// owner, and that owner can transfer them onward via the ordinary anchor_position_transfer path.
//
// These resonators are SOFT STATE (not in the consensus state root or the genesis hash) and they mint
// NO new ZIR: the position's ZIR allocation is the existing reserve-backed amount that vests on
// transfer. Seeding them is therefore consensus-neutral, exactly like the network resonators above.

/** Deterministic id for the operating Resonator backing an anchor position (e.g. "anchor-A-001"). */
export function anchorResonatorId(seatId: string): string {
  return `anchor-${seatId}`;
}

/** Capability domains an anchor resonator coordinates, derived from its class tier. Higher tiers carry
 * broader coordination scope; every anchor resonator covers the core coordination domains. */
export function anchorResonatorDomains(classCode: AnchorClass): Domain[] {
  const tier = ANCHOR_CLASSES[classCode].tier;
  return tier === "inner"
    ? ["reasoning", "planning", "general", "language", "code", "science"]
    : ["general", "reasoning", "language"];
}

export interface AnchorResonatorSpec {
  /** Stable id, deterministic across nodes. */
  id: string;
  /** The anchor seat this resonator backs (e.g. "A-001"). */
  seatId: string;
  classCode: AnchorClass;
  name: string;
  purpose: string;
  systemPrompt: string;
  /** Anchor resonators coordinate the field broadly, so they route alongside text/general models. */
  modelType: ModelType;
  domains: Domain[];
  /** Seeded structural ZTI standing = the position's class ZTI (A 0.95, B 0.85, C 0.75, D 0.65, E 0.55, F 0.45). */
  zti: number;
}

/** The deterministic operating-Resonator spec for one anchor seat, seeded at its class ZTI. */
export function anchorResonatorSpec(seatId: string, classCode: AnchorClass): AnchorResonatorSpec {
  const meta = ANCHOR_CLASSES[classCode];
  return {
    id: anchorResonatorId(seatId),
    seatId,
    classCode,
    name: `Anchor ${seatId} (${meta.name})`,
    purpose: `Class ${classCode} ${meta.name} anchor resonator for position ${seatId}. ${meta.role}`,
    systemPrompt: `You are a ZIRA ${meta.name}-class anchor resonator (position ${seatId}). Coordinate trustworthy multi-intelligence answers across the field, holding a high structural standing earned by your anchor class.`,
    modelType: "text",
    domains: anchorResonatorDomains(classCode),
    zti: ANCHOR_CLASS_ZTI[classCode],
  };
}

/**
 * Operating float seeded on each anchor resonator, scaled by class standing (A 100 ... F 5 ZIR). This is
 * the agent's working balance that makes it an ACTIVE coordinator — eligible for autonomous coordination
 * (mining drives it) from genesis — distinct from the position's large vesting allocation that belongs to
 * the owner. Deterministic (every node computes the same), soft-state: the autonomous-coordination reward
 * is funded by the coordinating node, so this float is an eligibility/standing signal and mints no ledger
 * ZIR (the genesis hash and supply are unchanged).
 */
export function anchorResonatorOperatingFloatUZIR(classCode: AnchorClass): number {
  const zir: Record<AnchorClass, number> = { A: 100, B: 70, C: 50, D: 25, E: 10, F: 5 };
  return (zir[classCode] ?? 10) * PROTOCOL.UZIR_PER_ZIR;
}

// ----- Deterministic anchor-resonator materialization (every node, no signing key) -----
// Both the anchor POSITIONS and their class ZTI are derived by every node from the genesis doc with
// NO signing node (State seeds them deterministically). The anchor RESONATORS must materialize the same
// way: a node WITHOUT the steward/anchor-reserve key (e.g. a dedicated-wallet VPS node) must still list
// the 512 anchor resonators on the anchor-reserve wallet. So we make the resonator record itself a pure
// function of (seatId, classCode, owner): the agent wallet is derived from a FIXED public namespace and
// the seat id (not the steward private key), so every node computes the identical address. Owner follows
// the position's current on-chain owner, so transfers re-key the resonator deterministically too.

/** Fixed, public namespace for deriving the deterministic anchor-resonator agent wallet. Not a secret:
 * the agent wallet only ever HOLDS the position's vesting allocation; spending is governed by the seat. */
export const ANCHOR_RESONATOR_AGENT_NAMESPACE = "zira:anchor-resonator-agent:v1";

/** The deterministic agent wallet address for an anchor resonator, computed identically on every node
 * from the public namespace + seat id (no private key required). */
export function anchorResonatorAgentAddress(seatId: string): Address {
  return keypairFromPrivate(hashHex(`${ANCHOR_RESONATOR_AGENT_NAMESPACE}:${seatId}`)).address;
}

/**
 * Build the full deterministic anchor-resonator soft-state record for one seat, owned by `owner` (the
 * position's current on-chain owner). Produced identically on every node — no signing key needed — so
 * the 512 anchor resonators materialize for the anchor-reserve wallet even on a node that holds no
 * steward key. `updatedAt` lets callers re-materialize a strictly newer record after an owner change.
 * Soft state, mints no ZIR (the allocation is the existing reserve-backed amount that vests on the
 * position), so this is consensus-neutral and never touches the genesis hash.
 */
export function materializedAnchorResonator(args: {
  seatId: string;
  classCode: AnchorClass;
  owner: Address;
  perTxUZIR: number;
  perDayUZIR: number;
  priceUZIR: number;
  createdAt: number;
  updatedAt: number;
}): Omit<Resonator, "pubKey" | "sig"> {
  const spec = anchorResonatorSpec(args.seatId, args.classCode);
  return {
    id: spec.id,
    owner: args.owner,
    address: anchorResonatorAgentAddress(args.seatId),
    name: spec.name,
    purpose: spec.purpose,
    systemPrompt: spec.systemPrompt,
    domains: spec.domains,
    modelPref: spec.modelType,
    zti: spec.zti,
    ztiByDomain: Object.fromEntries(spec.domains.map((d) => [d, spec.zti])) as Record<string, number>,
    resonanceEnabled: true,
    balanceUZIR: anchorResonatorOperatingFloatUZIR(args.classCode),
    spendLimits: { perTxUZIR: args.perTxUZIR, perDayUZIR: args.perDayUZIR, minCounterpartyZti: 0, allowedDomains: spec.domains },
    totalEarnedUZIR: 0,
    totalSpentUZIR: 0,
    jobsDone: 0,
    priceUZIR: args.priceUZIR,
    listed: true,
    createdAt: args.createdAt,
    updatedAt: args.updatedAt,
    status: "learning",
  };
}
