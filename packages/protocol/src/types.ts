// packages/protocol/src/types.ts
import type { Domain, GovernanceCategory, NetworkId, NetworkPhase } from "./constants";

export type uZIR = number;
export type Address = string;
export type Hex = string;
export type Signature = Hex;
export type PublicKey = Hex;

// ----- Participation roles and the Signed mixin -----

/** The four stackable participation tiers. One person can run all of them. */
export type ParticipationRole = "node" | "provider" | "builder" | "anchor";

/**
 * Applied to every soft-state record that must carry verifiable authorship. The signature is over
 * the canonical encoding of the record with the `sig` field omitted (pubKey is included).
 */
export interface Signed {
  /** Hex Ed25519 public key of the record owner/publisher. */
  pubKey: PublicKey;
  /** Hex Ed25519 signature over canonical(record excluding the sig field). */
  sig: Signature;
}

/**
 * Published by a Provider (Tier 2) to advertise inference capabilities. Gossiped as soft state and
 * authenticated via the Signed mixin. ZTI, not self report, reflects real quality.
 */
export interface ProviderProfile extends Signed {
  address: Address;
  label: string;
  domains: Domain[];
  /** Average tokens/sec (self reported). */
  tokensPerSec: number;
  /** Max context window tokens the endpoint supports. */
  contextWindowTokens: number;
  supportsStreaming: boolean;
  /** Optional human readable model hint, e.g. "Mistral 7B Q4_K_M". */
  modelHint?: string;
  updatedAt: number;
}

/** Hardware snapshot, filled by the node on startup. Advisory only; ZIRA never uses it to load models. */
export interface HardwareGpu {
  name: string;
  vramMb: number | null;
  vendor?: "nvidia" | "amd" | "intel" | "apple" | "unknown";
  kind?: "discrete" | "integrated" | "unknown";
}
export interface HardwareProfile {
  gpuName: string | null;
  gpuVramMb: number | null;
  gpus?: HardwareGpu[];
  acceleratorSummary?: string;
  detectionSources?: string[];
  detectionWarnings?: string[];
  detectedAt?: number;
  scanMs?: number;
  capabilityTier?: "relay" | "cpu" | "gpu-basic" | "gpu-strong" | "gpu-heavy";
  cpuName?: string;
  arch?: string;
  cpuCores: number;
  ramMb: number;
  /** Suggested gpuLayers for a typical 7B Q4 model at this VRAM (for the user's own Ollama). */
  recommendedGpuLayers: number;
  /** Half of physical cores, minimum 2. */
  recommendedThreads: number;
  recommendedMode?: "relay" | "cpu" | "gpu" | "storage";
  recommendedRole?: "relay" | "observer" | "cpu-miner" | "gpu-miner" | "storage-gpu";
  miningHint?: string;
  platform: "win32" | "linux" | "darwin" | string;
}

/** NodeConfig controls Tier 1 (node participation) settings. Stored per network. */
export interface NodeConfig {
  /** Whether this node actively participates in PoR observation rounds. */
  observeEnabled: boolean;
}

/** ProviderConfig controls Tier 2 (inference serving). Independent of NodeConfig. */
export interface ProviderConfig {
  enabled: boolean;
  /** OpenAI-compatible endpoint URL, e.g. "http://localhost:11434/v1". */
  endpoint: string;
  /** Model identifier passed in API calls, e.g. "mistral". */
  endpointModel: string;
  /** Domains to specialise in; empty = serve all. */
  domains: Domain[];
  /** Price override in µZIR per query (0 = use QUERY_PRICE_UZIR). */
  priceUZIR: uZIR;
  label: string;
  supportsStreaming: boolean;
}

export const DEFAULT_NODE_CONFIG: NodeConfig = {
  observeEnabled: true,
};

export const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  enabled: false,
  endpoint: "http://localhost:11434/v1",
  endpointModel: "mistral",
  domains: [],
  priceUZIR: 0,
  label: "",
  supportsStreaming: false,
};

/** A founder published, advisory model configuration. Providers follow it voluntarily. */
export interface ModelRecommendation extends Signed {
  id: string;
  label: string;
  backendHint: string;   // e.g. "Ollama: mistral"
  domains: Domain[];
  notes: string;
  publishedAt: number;
}

export type ObservationType = "value" | "event" | "sensor" | "computation" | "judgment";
export interface ObservationBody {
  type: ObservationType; observer: PublicKey; timestamp: number;
  subject: string; domain: Domain; value?: number; proofRef?: Hex;
  confidence: number; sourceHashes: Hex[];
  // Optional self-reported authorized-model storage this observer is serving for the field, in GiB. Part
  // of the signed body (tamper-proof) and gossiped to every node, so the emission split can pay storage
  // hosts a bounded bonus deterministically (see storageRewardMultiplier). Absent on observations that
  // carry no storage; absent => no bonus, identical to the pre-storage canonical form.
  storageGiB?: number;
  // Master-only storage vouch: addresses this observer (a genesis master) has verified hold + serve the
  // authorized model via a random-chunk probe this window. Part of the signed body and gossiped to every
  // node, so runField can deterministically credit a vouched miner's work (set lastWorkEpoch) from the
  // CONVERGED observations — never from per-master ledger txs (those diverge and freeze finality). A miner
  // vouched by >= PROTOCOL.MIN_STORAGE_VOUCHERS distinct masters in the sealed Lock earns heartbeat emission.
  // Absent on non-master / no-vouch observations => identical canonical form to before.
  vouchedMiners?: Address[];
}
export interface SignedObservation extends ObservationBody { id: Hex; sig: Signature; }

export interface Lock {
  id: Hex; subject: string; domain: Domain; epoch: number;
  resonantValue: number; cv: number; observationCount: number;
  supportingTrust: number; supporters: PublicKey[]; sealedAt: number;
}

export type TxKind =
  | "transfer" | "reward" | "agent_spend" | "bond_post" | "bond_return" | "bond_burn" | "reserve_grant" | "founder_delegate" | "founder_revoke"
  | "anchor_claim" | "anchor_transfer" | "anchor_list" | "anchor_delist" | "anchor_code_edit"
  | "anchor_vest_start" | "anchor_vest_release" | "anchor_activate" | "anchor_position_transfer"
  | "anchor_set_contributions"
  | "storage_attest"
  // A single transaction that credits many recipients at once. The recipient list rides in `memo` as
  // {"o":[["zir1...",amountUZIR],...]} and `amountUZIR` is their exact sum. It lets the settler pay a whole
  // cycle's field-participation payout in ONE tx (one nonce) instead of one tx per miner, so a dropped
  // packet can't open a nonce gap that cascades and forks honest nodes. Deterministic: every recipient and
  // amount is in the signed body, applied in listed order.
  | "batch_transfer"
  // Decentralization cutover: a pool-funded, bucket-idempotent community payout. Same recipient memo as
  // batch_transfer plus a bucket id: {"b":<bucket>,"o":[["zir1...",amount],...]}. The OUTPUTS are debited
  // from the fixed emission POOL (not the sender), so ANY authorized settler — a genesis master OR a
  // committed validator — can keep miners paid when the primary settler (box1) is down. Rejected before the
  // decentralization activation epoch, only accepted from the root-committed {masters ∪ validators} set, and
  // idempotent per bucket via a root-committed watermark, so two racing settlers can never double-pay.
  | "pool_payout";
export interface TxBody {
  network: NetworkId; from: Address; fromPubKey: PublicKey; to: Address;
  amountUZIR: uZIR; feeUZIR: uZIR; nonce: number; kind: TxKind;
  memo?: string; parents: Hex[]; timestamp: number;
}
export interface SignedTx extends TxBody { id: Hex; sig: Signature; finalizedAt?: number; }

export type SignedEvent =
  | { kind: "tx"; data: SignedTx }
  | { kind: "observation"; data: SignedObservation }
  | { kind: "lock"; data: Lock };

export interface FieldNode {
  pubKey: PublicKey; zti: number; ztiByDomain: Partial<Record<Domain, number>>;
  estimate?: number; confidence?: number; online: boolean; isMaster: boolean;
}

export interface Stream {
  id: Hex; from: Address; to: Address; ratePerSecondUZIR: uZIR;
  startedAt: number; active: boolean; condition?: string;
}
export interface Bond {
  id: Hex; holder: Address; amountUZIR: uZIR; role: string;
  status: "active" | "returned" | "burned"; postedAt: number;
}

export interface SpendLimits {
  perTxUZIR: uZIR; perDayUZIR: uZIR; minCounterpartyZti: number; allowedDomains: Domain[];
}
export interface Resonator extends Signed {
  id: Hex; owner: Address; address: Address; name: string; purpose: string;
  systemPrompt: string; domains: Domain[]; modelPref: string;
  zti: number; ztiByDomain: Partial<Record<Domain, number>>;
  resonanceEnabled: boolean; balanceUZIR: uZIR; spendLimits: SpendLimits;
  totalEarnedUZIR: uZIR; totalSpentUZIR: uZIR; jobsDone: number;
  priceUZIR: uZIR; listed: boolean; createdAt: number; updatedAt: number;
  status: "idle" | "learning" | "working" | "paused";
}

/** Full task lifecycle. Reaper driven transitions: expired -> refunded, delivered -> released. */
export type TaskStatus =
  | "pending"    // created, awaiting resonator acceptance
  | "open"       // legacy alias for pending
  | "assigned"   // resonator accepted; working
  | "delivered"  // result submitted; awaiting hirer verification
  | "verified"   // hirer confirmed the task result
  | "released"   // task completed and counted for the resonator
  | "expired"    // resonator did not deliver in time
  | "disputed"   // hirer rejected delivery
  | "refunded";  // legacy task was closed without completion

// A hire on the marketplace. Current launch behavior pays the agent wallet when the task is created;
// the task record tracks assignment, delivery, verification, and trust scoring.
export interface Task {
  id: Hex; client: Address; resonatorId: Hex; domain: Domain;
  brief: string; budgetUZIR: uZIR; minZti: number;
  status: TaskStatus;
  resultRef?: Hex; createdAt: number;
  expiresAt: number;       // createdAt + TASK_DELIVER_TIMEOUT_MS
  assignedAt?: number;
  deliveredAt?: number;
  resolvedAt?: number;
}

// Marketplace listing, the rankable directory row.
export interface Listing extends Signed {
  resonatorId: Hex; name: string; owner: Address; purpose: string;
  domains: Domain[]; zti: number; ztiByDomain: Partial<Record<Domain, number>>;
  priceUZIR: uZIR; jobsDone: number; totalEarnedUZIR: uZIR; lastActiveAt: number;
}

export type AnchorStatus = "unclaimed" | "owned" | "listed" | "activation_pending" | "active";
export interface AnchorCodeCommitment {
  seatId: string;
  classCode: "A" | "B" | "C" | "D" | "E" | "F";
  seatIndex: number;
  codeHash: Hex;
}
export interface AnchorGenesisOwnership {
  seatId: string;
  owner: Address;
  txId?: Hex;
}
export interface Anchor {
  id: string;
  ring: "inner" | "outer";
  classCode: "A" | "B" | "C" | "D" | "E" | "F";
  className?: string;
  seatIndex: number;
  codeHash: Hex;
  owner?: Address;
  listedPriceUZIR?: uZIR;
  listedAt?: number;
  zirReserveUZIR: uZIR;
  /** Cumulative µZIR already released from this seat's vesting schedule to the beneficiary. */
  vestedUZIR: uZIR;
  // ---- one-year linear vesting of the class allocation, set up at assignment ----
  /** Total µZIR scheduled to vest to the beneficiary (the class allocation). 0/undefined = none. */
  vestTotalUZIR?: uZIR;
  /** Wall-clock time vesting began (the assignment time). */
  vestStartAt?: number;
  /** Vesting duration in ms (defaults to one year when the schedule is active). */
  vestDurationMs?: number;
  /** Address the vesting allocation is released to (the seat owner at assignment time). */
  vestBeneficiary?: Address;
  /** Wallet that funds and administers the schedule (the anchor-reserve wallet). Authors releases. */
  vestFunder?: Address;
  operator?: PublicKey;
  zti: number;
  routingWeight: number;
  status: AnchorStatus;
  claimedAt?: number;
  activatedAt?: number;
  /** Owner-controlled: when true, the owner has opened this position for user contributions (others may
   *  contribute compute/storage under it). Default closed. Toggled by the owner via anchor_set_contributions. */
  contributionsOpen?: boolean;
}
export interface AnchorClaimPayload { seatId: string; code: string; }
export interface AnchorTransferPayload { seatId: string; to: Address; }
export interface AnchorListPayload { seatId: string; priceUZIR: uZIR; }
export interface AnchorDelistPayload { seatId: string; }
export interface AnchorCodeEditPayload { seatId: string; codeHash: Hex; }
/** Owner opens or closes one or more of their anchor positions for user contributions. */
export interface AnchorSetContributionsPayload { seatIds: string[]; open: boolean; }
/** Begin a one-year linear vesting of `totalUZIR` to `beneficiary` for a seat. */
export interface AnchorVestStartPayload { seatId: string; beneficiary: Address; totalUZIR: uZIR; startAt: number; durationMs?: number; }
/** Record that `releasedUZIR` cumulative has now been released for a seat's vesting schedule. */
export interface AnchorVestReleasePayload { seatId: string; releasedUZIR: uZIR; }
/**
 * Transfer one or more anchor POSITIONS (resonator assets) from the current owner to `to`, in a single
 * owner-signed operation. Single transfer = a one-element `seatIds`; batch = many. Each position carries
 * its class/ZTI/weight and its ZIR allocation: vesting follows the new owner (a steward-owned position
 * starts a fresh one-year schedule; an already-vesting position redirects its remaining releases to `to`).
 * `vestStartAt`/`vestDurationMs` seed any newly-opened schedule (defaults: now / one year).
 */
export interface AnchorPositionTransferPayload {
  seatIds: string[];
  to: Address;
  vestStartAt?: number;
  vestDurationMs?: number;
}
export type AnchorTxPayload =
  | { anchor: "claim"; data: AnchorClaimPayload }
  | { anchor: "transfer"; data: AnchorTransferPayload }
  | { anchor: "list"; data: AnchorListPayload }
  | { anchor: "delist"; data: AnchorDelistPayload }
  | { anchor: "code_edit"; data: AnchorCodeEditPayload }
  | { anchor: "vest_start"; data: AnchorVestStartPayload }
  | { anchor: "vest_release"; data: AnchorVestReleasePayload }
  | { anchor: "position_transfer"; data: AnchorPositionTransferPayload }
  | { anchor: "set_contributions"; data: AnchorSetContributionsPayload }
  | { anchor: "activate"; data: { seatId: string } };

/**
 * ZRC-1 Resonance Object: immutable, content-addressed knowledge unit. Types are stable now;
 * the execution engine is coming soon (endpoints return 501).
 */
export interface ResonanceObject extends Signed {
  /** sha3-256 of canonical(content). */
  id: Hex;
  contentType: string;   // e.g. "application/zrc1+json"
  content: unknown;      // validated against contentType schema
  publisherAddress: Address;
  domains: Domain[];
  publishedAt: number;
  /** null = permanent. */
  ttlMs: number | null;
}

/**
 * Intelligent Agreement: a conditional µZIR stream between parties, triggered by PoR Locks.
 * Types are stable now; execution is coming soon.
 */
export interface IntelligentAgreement extends Signed {
  id: string;
  parties: Address[];
  /** JSON-logic expression over Lock fields. */
  triggerCondition: unknown;
  streamRateUZIR: uZIR;   // µZIR per settling epoch
  shares: number[];       // must sum to 1.0; one entry per party
  maxTotalUZIR: uZIR;     // escrow ceiling
  domain: Domain;
  status: "active" | "paused" | "completed" | "cancelled";
  createdAt: number;
  expiresAt: number | null;
}

/** A governance proposal. Voting/execution is coming soon; the type and constants are stable. */
export interface GovernanceProposal extends Signed {
  id: string;
  category: GovernanceCategory;
  title: string;
  description: string;
  change: unknown;        // typed diff per category; validated on execution
  proposerAddress: Address;
  proposerZTI: number;
  createdAt: number;
  endsAt: number;
  status: "active" | "approved" | "rejected" | "vetoed" | "expired";
  votes: Record<string, { weight: number; approve: boolean }>;
}

/** A point on an identity's ZTI history, for dashboard sparklines. */
export interface ZtiSnapshot { epoch: number; zti: number; domain: Domain }

/** The full breakdown behind a trust-weighted answer, for the Console coordination explorer. */
export interface QueryFusion {
  queryId: string;
  contributors: { address: Address; zti: number; weight: number; answerSnippet: string }[];
  fusedAnswer: string;
  confidenceScore: number;
  domain: Domain;
}

export interface AnswerReceipt {
  contributors: {
    provider: PublicKey; label: string; model: string;
    domainZti: number; weight: number; excerpt: string; sig: Signature;
    // The exact bytes the provider signed: queryId + "\n" + answer. Carried so the client can verify each
    // contributor's ed25519 signature against its public key, turning the receipt into checkable proof
    // rather than a decorative checkmark. excerpt stays for compact display; answer is the full signed text.
    queryId?: string; answer?: string;
  }[];
  domain: Domain; fusedConfidence: number;
  challengeOpenUntil: number; proofAvailable: boolean; costUZIR: uZIR;
}

export interface ChatMessage {
  id: string; role: "user" | "assistant" | "system";
  content: string; createdAt: number; receipt?: AnswerReceipt; streaming?: boolean;
}
export interface Conversation {
  id: string; title: string; messages: ChatMessage[]; agentId?: string; updatedAt: number;
}

export interface NetworkStats {
  network: NetworkId; phase: NetworkPhase;
  providersOnline: number; activeNodes: number; avgZti: number; locksPerMinute: number;
  circulatingUZIR: uZIR; emittedUZIR: uZIR; burnedUZIR: uZIR; reserveUZIR: uZIR;
  founderAddress?: Address;
  founderAddresses?: Address[];
}

// A query awaiting answers, used by provider mode.
export interface PendingQuery {
  id: Hex; domain: Domain; question: string;
  history: { role: "user" | "assistant"; content: string }[]; postedAt: number;
}
