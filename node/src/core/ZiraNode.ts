// node/src/core/ZiraNode.ts
// The orchestrator. It wires the deterministic ledger (State), Proof of Resonance finality
// (Checkpoints), the shared marketplace and relay (SoftState), durable storage (Store), and the
// peer to peer network together, and drives the epoch clock.
import {
  genesisId, type GenesisDoc, type Keypair, type SignedTx, type SignedObservation, type NetworkStats,
  type Resonator, type Task, type Domain, PROTOCOL,
  type HardwareProfile, type ProviderConfig, type ProviderProfile, type ModelRecommendation,
  DEFAULT_PROVIDER_CONFIG, TASK_DELIVER_TIMEOUT_MS, TASK_VERIFY_TIMEOUT_MS, adaptiveQueryPriceUZIR, adaptiveTaskPriceUZIR,
  hashHex, signTx, signRecord, keypairFromPrivate, canonical, buildObservationBody, sign as edSign, type TxBody,
  computeStateRoot, verifyCheckpointVote, type SignedCheckpointVote, type AccountLeaf,
  anchorVestingClaimableUZIR, ANCHOR_VESTING_DURATION_MS,
  NETWORK_RESONATOR_SPECS, MAINNET_NETWORK_RESONATOR_OWNER, type NetworkResonatorSpec,
  anchorResonatorSpec, anchorResonatorOperatingFloatUZIR, type AnchorResonatorSpec, type Anchor,
  settleCoordination, addressFromPubKey, verify as edVerify,
  convergenceAdjustedBudget, queryComplexityChars, queryTier, PRICING, type Address,
} from "@zira/protocol";
import { settlementWalletsFor, treasuryWalletsFor } from "../genesis-docs.js";
import { launchModelsFor } from "../launch-models.js";
import { verifyContribution, type WatchNetwork } from "../anchor/paymentWatcher.js";
import { State, epochOf, SETTLE_ROUNDS } from "./State.js";
import { weightedOutputs } from "./payout-split.js";
import { SoftState } from "./SoftState.js";
import { Checkpoints } from "./Checkpoints.js";
import { Store } from "./Store.js";
import { ModelService } from "../models/ModelService.js";
import type { MiningConfig } from "../models/types.js";
import { FounderServices } from "./FounderServices.js";
import { InferenceProvider } from "../provider/InferenceProvider.js";
import { startMiner } from "../provider/loop.js";
import { type Envelope, envelopeId, type ProviderAnnounce, type QueryMsg, type AnswerMsg } from "./types.js";
import type { ModelAnnounce } from "../models/types.js";
import type { ZiraNetwork } from "../p2p/Network.js";
import { topics as buildTopics, SNAPSHOT_PROTOCOL, LIVENESS_PROTOCOL } from "../p2p/topics.js";
import { detectHardware } from "../hardware/detect.js";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log.js";

export interface ZiraNodeOptions {
  observeEnabled?: boolean;
  hardwareDetect?: boolean;
  selfContained?: boolean;
  taskReapMs?: number;
  providerConfig?: ProviderConfig;
  fastSync?: boolean;
  // Transparent ecosystem events: a founder-held wallet that gives ZIR away in airdrops/grants.
  // Never a sale. The "+" surfaces only while active and the wallet holds at least the floor.
  eventsKey?: string;       // private key of the events/ecosystem wallet, founder-held
  eventsClaimZir?: number;  // ZIR sent per claim
  // Founder-mediated anchor seat assignment: a founder-held anchor-reserve wallet that claims an
  // unclaimed seat by its secret code, transfers the seat to the requester, and releases its ZIR.
  anchorReserveKey?: string;  // private key of the anchor-reserve wallet, founder-held
  // Decentralization cutover activation epoch. Overrides the protocol constant (0 = dormant). Tests pass a low
  // value to exercise the active path; ops may set ZIRA_DECENTRALIZATION_ACTIVATION_EPOCH to a coordinated
  // future epoch across ALL masters to schedule the live cutover without a rebuild (every node MUST agree).
  activationEpochOverride?: number;
}

// The events wallet must hold at least this much ZIR for the "+" to be offered; below it, events hide.
export const EVENTS_FLOOR_UZIR = 1000 * PROTOCOL.UZIR_PER_ZIR;

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name] ?? "");
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name] ?? "");
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
function envFrac(name: string, fallback: number): number {
  const n = Number(process.env[name] ?? "");
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

// Autonomous-coordination payouts are created by a SINGLE network settler (isNetworkSettler): the first
// genesis master on mainnet, the founder on devnet/test. One funder means one deterministic tx set per epoch,
// so masters never diverge and quorum finality stays byte-identical. If EVERY master minted payout txs from
// its own soft state, the per-epoch tx sets would differ and freeze finality — which is why settling is
// funnelled to one node rather than spread across the master set.
const AUTONOMOUS_RESONATOR_DELIVER_MS = envMs("ZIRA_AUTONOMOUS_RESONATOR_DELIVER_MS", 10_000);
const AUTONOMOUS_RESONANCE_CYCLE_MS = envMs("ZIRA_AUTONOMOUS_RESONANCE_CYCLE_MS", 5 * 60_000);
const AUTONOMOUS_RESONANCE_SETTLE_MS = envMs("ZIRA_AUTONOMOUS_RESONANCE_SETTLE_MS", 30_000);
const AUTONOMOUS_RESONANCE_MIN_ANSWERS = envInt("ZIRA_AUTONOMOUS_RESONANCE_MIN_ANSWERS", 2);
// Release version reported by /rpc/stats (feature negotiation + "which build am I on"). Bump per release.
const NODE_RELEASE_VERSION = "2.6.3";
// Per-cycle coordination batch. Every funded+listed resonator is eligible; autonomousResonanceBatch picks
// this many per 5-minute cycle by a DETERMINISTIC ZTI-WEIGHTED draw, so higher-trust resonators (anchors,
// seeded 0.95/0.85/… by class) are driven most often and earn the most, while every other funded resonator
// still rotates in proportional to its earned ZTI and earns its share of the 10% resonator pool. This cap
// only sets how many run per cycle. Settlement stays safe at this volume: each query settles as ONE
// batch_transfer (single nonce). Which resonators are driven is soft state (only the settler pays, via a
// deterministic signed tx applied identically), so this never touches the state root.
const AUTONOMOUS_RESONANCE_MAX_PER_CYCLE = envInt("ZIRA_AUTONOMOUS_RESONANCE_MAX_PER_CYCLE", 8);
// Safety ceiling on how many funded resonators the settler considers per cycle before the ZTI-weighted draw.
// Bounds the per-tick sort/sample cost on a very large field; sized well above the 512 anchors + expected
// user resonators so it never silently starves a funded resonator in practice. Env-tunable.
const AUTONOMOUS_RESONANCE_ELIGIBLE_CAP = envInt("ZIRA_AUTONOMOUS_RESONANCE_ELIGIBLE_CAP", 4096);
// Bootstrap floor added to every resonator's ZTI in the weighted draw, so a brand-new funded resonator
// (near-zero ZTI) still gets driven on a fair cadence — roughly once a day at the default — to earn its
// first coordination reward, grow ZTI through verified convergence, and ramp up. Without it a fresh
// resonator is near-starved (driven ~once every 3-4 days) and can never warm up. Anchors still lead ~6:1 by
// their seeded score. Env-tunable so the newcomer ramp can be tuned without a release.
const AUTONOMOUS_RESONANCE_ZTI_BOOTSTRAP = Number(process.env.ZIRA_AUTONOMOUS_RESONANCE_ZTI_BOOTSTRAP ?? 0.25);
// Community redistribution. Base emission is minted to the settler alone (see State.emitBaseThrough); each
// cycle the settler pays most of it out to the people running the network — a fixed per-cycle mining pool
// split among verified participants, plus a per-driven-resonator reward to owners. Sized so the settler
// redistributes the large majority of its per-cycle emission and keeps the rest as treasury. Env-tunable.
const FIELD_PARTICIPATION_BUDGET_UZIR = envInt("ZIRA_FIELD_PARTICIPATION_BUDGET_UZIR", 5_000_000_000); // 5000 ZIR/cycle mining pool
// Settler-nonce watchdog: if the settler's committed nonce has not advanced for this long while its later
// payouts have piled up as future-nonce gaps (provisionalNonce ran ahead of committed), the payout pipeline is
// wedged — there is no tx sitting at the committed nonce, so nothing applies and every gapped payout waits
// forever (the 2026-07-05 "pure gap" freeze the settle-drain skip could not reach). Well above the normal
// ~60s settle-lag so a healthy in-flight payout is never mistaken for a wedge.
const SETTLER_NONCE_STUCK_MS = envMs("ZIRA_SETTLER_NONCE_STUCK_MS", 120_000);
// Event-log compaction: once the log passes this size, drop persisted tx/observation/checkpoint events older
// than the snapshot's replay window (keepFrom below). Keeps events.jsonl bounded so it can never exceed Node's
// ~512MB max-string cap and brick the node on boot. Threshold well under 512MB; cushion is generous.
const EVENTS_COMPACT_THRESHOLD_BYTES = envInt("ZIRA_EVENTS_COMPACT_THRESHOLD_BYTES", 48 * 1024 * 1024);
const EVENTS_KEEP_CUSHION_EPOCHS = envInt("ZIRA_EVENTS_KEEP_CUSHION_EPOCHS", 2000);
const AUTONOMOUS_RESONANCE_TASK_UZIR = envInt("ZIRA_AUTONOMOUS_RESONANCE_TASK_UZIR", 200_000_000);     // 200 ZIR / driven resonator / cycle
// Real per-query coordination reward paid by the steward/founder funding wallet to the providers that
// contributed accepted answers to an autonomous-resonance query. This is the money path that makes a
// MINING node actually earn ZIR via Proof of Resonance + coordination: when its accepted work converges
// a query, its balance grows from this payout (split by domain ZTI x confidence, minus the small
// steward-ops share). It moves already-allocated founder-ops ZIR — it mints no new ZIR, so emission and
// the supply cap are untouched. Set to 0 to disable automatic coordination payouts.
const AUTONOMOUS_COORDINATION_REWARD_UZIR = envInt("ZIRA_AUTONOMOUS_COORDINATION_REWARD_UZIR", 500_000); // 0.5 ZIR default
// Field participation pool. Each cycle the network settler splits this budget among the miners it has
// VERIFIED are genuinely participating this window (a live, directly-reachable coordinating peer, or a
// storage-serving peer that passed a random-chunk challenge — see runStorageProbe), paying from the base
// emission it earns. This is what makes "mining is on" actually earn: a real, connected, contributing node
// is paid for participating even when it does not win a coordination answer. A FIXED per-cycle pool split
// among participants means more nodes dilute each share (so spinning up sybils just splits the same pool)
// and bounds the settler's spend. One settler funds it, so the payout txs are deterministic and finality
// holds. Answering coordination queries (the 77% split) still earns MORE, on top of this. Set 0 to disable.
const FIELD_PARTICIPATION_MAX_PAYEES = envInt("ZIRA_FIELD_PARTICIPATION_MAX_PAYEES", 64);
// Contribution weighting for the field pool (v2.0.2). The pool is no longer split equally: the settler
// weights each vouched miner by VERIFIABLE work it observed, so a stronger machine that serves storage and
// answers more coordination queries earns a larger share, while a bare live node keeps a real baseline. This
// is entirely settler-computed and issued in the SAME single signed batch_transfer, so every node applies it
// byte-identically — consensus-safe (like the union payee choice). All values are floats in "weight units":
//   weight = BASE + (storage-serving ? STORAGE_BONUS) + min(ANSWER_CAP, answerCredits*ANSWER_UNIT)
//                 + min(ZTI_CAP, zti*ZTI_UNIT), clamped to [BASE, CEILING].
const FIELD_WEIGHT_BASE = Number(process.env.ZIRA_FIELD_WEIGHT_BASE ?? 1);
const FIELD_WEIGHT_STORAGE_BONUS = Number(process.env.ZIRA_FIELD_WEIGHT_STORAGE_BONUS ?? 0.5);
// Bigger verified storage earns more: a per-GiB bonus (only for miners that PASSED the chunk challenge, so a
// self-reported size cannot be gamed), capped so a huge disk cannot dominate the pool.
const FIELD_WEIGHT_STORAGE_GIB_UNIT = Number(process.env.ZIRA_FIELD_WEIGHT_STORAGE_GIB_UNIT ?? 0.05);
const FIELD_WEIGHT_STORAGE_GIB_CAP = Number(process.env.ZIRA_FIELD_WEIGHT_STORAGE_GIB_CAP ?? 2);
const FIELD_WEIGHT_ANSWER_UNIT = Number(process.env.ZIRA_FIELD_WEIGHT_ANSWER_UNIT ?? 0.5);
const FIELD_WEIGHT_ANSWER_CAP = Number(process.env.ZIRA_FIELD_WEIGHT_ANSWER_CAP ?? 4);
const FIELD_WEIGHT_ZTI_CAP = Number(process.env.ZIRA_FIELD_WEIGHT_ZTI_CAP ?? 1);
// Wider range (was 6) so a strong, hard-working machine can earn many times a bare live node's share, while
// the BASE floor keeps a small honest miner from ever going to zero.
const FIELD_WEIGHT_CEILING = Number(process.env.ZIRA_FIELD_WEIGHT_CEILING ?? 8.5);
// Recency decay applied to a miner's accumulated coordination-answer credits once per paid cycle, so recent
// work dominates and stale credits fade (a rolling recency-weighted answer count).
const FIELD_ANSWER_DECAY = Number(process.env.ZIRA_FIELD_ANSWER_DECAY ?? 0.8);
// Field heartbeat: how often a contributing (mining or storage) node attests it is up + serving, so the
// PoR field forms Locks and the round emission flows to contributors. Frequent enough that every
// contributor always has a fresh in-window observation. This is the inference-free "mining/storage earns"
// path (the whitepaper's mining reward); paid inference coordination earns on top of it.
const FIELD_HEARTBEAT_INTERVAL_MS = envMs("ZIRA_FIELD_HEARTBEAT_MS", 30_000);
const FIELD_HEARTBEAT_SUBJECT = PROTOCOL.FIELD_HEARTBEAT_SUBJECT;  // shared so the work-gate matches exactly
// Push-liveness: a mining node proactively asserts liveness to each connected master over its OWN outbound
// connection (which works through any NAT/CGNAT), instead of relying on the master probing it back — a reverse
// probe that a churning residential connection keeps failing. INTERVAL is how often it pushes; MAX_AGE is how
// long a master honours a push (must exceed INTERVAL so a couple of missed pushes don't drop the vouch).
const PUSH_LIVENESS_INTERVAL_MS = envMs("ZIRA_PUSH_LIVENESS_MS", 20_000);
const PUSH_LIVENESS_MAX_AGE_MS = envMs("ZIRA_PUSH_LIVENESS_MAX_AGE_MS", 90_000);
// How many connected peers a miner pushes its liveness to per interval. A home node holds only a handful of
// connections (all of them masters); the cap only bounds a well-connected public node so it does not open an
// unreasonable number of best-effort streams each interval. Only masters record the push, so extra targets are
// harmless no-ops.
const PUSH_LIVENESS_MAX_TARGETS = Number(process.env.ZIRA_PUSH_LIVENESS_MAX_TARGETS ?? 32);
// A follower keeps this many recent per-epoch local roots to self-check against finalized consensus roots.
const LOCAL_ROOT_HISTORY = 512;
// How many recent per-root FINALIZED-consistent snapshots to retain for serving fast-sync. Only needs to
// exceed the finality lag (lastProcessedEpoch - lastFinalizedEpoch, normally a handful of epochs); 64 gives
// ~5 minutes of headroom. Each is a deep copy of the state snapshot (~a few hundred KB), so this is bounded.
const FINALIZED_SNAP_HISTORY = 64;
// Consecutive DISTINCT finalized epochs whose consensus root disagrees with our own recorded root before we
// conclude our applied state has diverged and re-adopt a verified master snapshot. >1 so a single off-by-one
// settle-timing sample never triggers a needless resync; the roots are deterministic, so real divergence persists.
const DIVERGENCE_STREAK_TRIGGER = Number(process.env.ZIRA_DIVERGENCE_STREAK_TRIGGER ?? 3);
const COORDINATION_FALLBACK_RE = /This node is mining in coordination mode|Full generative AI answers require/i;

/** Graded textual agreement in [0,1]: the mean Jaccard overlap of an answer's significant vocabulary with
 *  each of the other contributors' answers. Used to weight coordination pay toward the consensus answer so a
 *  divergent (likely wrong) answer earns little even with high self-confidence. Returns 1 with no others to
 *  compare against (a lone contributor), and 0 for an empty answer. */
function answerAgreement(answer: string, others: string[]): number {
  if (others.length === 0) return 1;
  const vocab = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  const self = vocab(answer);
  if (self.size === 0) return 0;
  const sim = (b: string): number => {
    const sb = vocab(b);
    if (sb.size === 0) return 0;
    let inter = 0;
    for (const w of self) if (sb.has(w)) inter++;
    const union = self.size + sb.size - inter;
    return union > 0 ? inter / union : 0;
  };
  return others.reduce((s, o) => s + sim(o), 0) / others.length;
}
// Query answer reliability (Task 3): a field query must never hang forever. awaitQueryAnswer polls soft
// state for a collected answer up to QUERY_ANSWER_TIMEOUT_MS (default 30s), capped at QUERY_ANSWER_MAX_WAIT_MS,
// and returns a clear timed-out result if none arrived. The poll is cheap (in-memory soft state read).
const QUERY_ANSWER_TIMEOUT_MS = envInt("ZIRA_QUERY_ANSWER_TIMEOUT_MS", 30_000);
const QUERY_ANSWER_MAX_WAIT_MS = envInt("ZIRA_QUERY_ANSWER_MAX_WAIT_MS", 120_000);
const QUERY_ANSWER_POLL_MS = envInt("ZIRA_QUERY_ANSWER_POLL_MS", 250);

/** The Console Mine page's mining view: one switch, plus what the field offers and what's running. */
export interface MiningStatus {
  enabled: boolean;
  mode: "auto" | "select";
  modelId: string | null;
  endpoint?: string;
  endpointModel?: string;
  gpuLayers: number;
  threads: number;
  useRecommendedHardware: boolean;
  engineAvailable: boolean;
  loadedModel: string | null;
  serving: boolean;
  answerLabel: string;
  recommendedModelId: string | null;
  answered: number;
  localTaskPermission: boolean;
  // own-task local inference: the user's own hardware for the user's own Console/Resonator tasks,
  // independent of mining (does not serve the field, does not earn).
  ownTaskInference: boolean;
  ownTaskReady: boolean;
  ownTaskLabel: string;
  storageEnabled: boolean;
  storageCapBytes: number;
  storageLimitGb: number;
  storageUsedBytes: number;
  storageDownloadingBytes: number;
  known: { meta: import("../models/types.js").ModelMeta; providers: number; targetHosts: number; distributionProgress: number; ready: boolean; local: boolean }[];
}

export interface BootstrapSeedCandidate {
  multiaddr: string;
  label: string;
  roles: string[];
  source: "self" | "connected" | "saved" | "storage";
  shareable: boolean;
  eligible: boolean;
  status: "ready" | "public-unchecked" | "local" | "unreachable";
  reason: string;
  score: number;
  priority: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// A peer snapshot offered to a joining node, with the finalized checkpoint and its finalizing votes.
type SnapAccount = { address: string; pubkey: string; zti: number; isMaster: boolean; balance: number; nonce: number };
type Snap = {
  snapshot: {
    lastProcessedEpoch: number;
    accounts: SnapAccount[];
    supply: { emitted: number; burned: number; reserve: number };
    founders?: string[];
    anchors?: import("@zira/protocol").Anchor[];
  };
  finalizedEpoch: number;
  finalizedRoot: string;
  votes: SignedCheckpointVote[];
};

/**
 * Verify a peer snapshot is cryptographically bound to a genuinely finalized checkpoint before a
 * joining node adopts it. The snapshot content must hash to the finalized root, and that root must
 * carry finalizing votes from master nodes (in the snapshot itself) summing to at least
 * FINALITY_THRESHOLD of the master trust, including at least one genesis master (or a genesis founder on
 * networks without an explicit master set). This makes
 * fast-sync consensus safe: a forged snapshot cannot be adopted because the votes are signed over
 * the root and the masters are part of the snapshot. Returns true only when all of that holds.
 * Exported as a pure function so the adversarial test can exercise it directly.
 */
export function verifyFastSyncSnapshot(best: Snap, genesis: GenesisDoc): boolean {
  if (!best.snapshot || best.finalizedEpoch < 0 || !best.finalizedRoot || best.finalizedRoot === "00") return false;
  if (!Array.isArray(best.votes) || best.votes.length === 0) return false;

  // The snapshot content must hash to the finalized root; binds the state to the checkpoint. Pass the SAME
  // six fields State.stateRoot() hashes (incl. validators + lastPoolPayoutBucket); both are empty/0 and
  // root-neutral while decentralization is dormant, but omitting them would silently mismatch once the
  // sealed validator registry or pool-payout watermark becomes non-empty.
  const root = computeStateRoot(
    best.snapshot.accounts as AccountLeaf[], best.snapshot.supply,
    best.snapshot.founders ?? [], best.snapshot.anchors ?? [],
    (best.snapshot as { validators?: string[] }).validators ?? [],
    (best.snapshot as { lastPoolPayoutBucket?: number }).lastPoolPayoutBucket ?? 0,
  );
  if (root !== best.finalizedRoot) return false;

  // Anchor: a finalized snapshot must be co-signed by at least one genesis-designated master, so a forged
  // checkpoint signed only by self-promoted accounts cannot be adopted. On mainnet that is the genesis master
  // quorum; on networks without an explicit master set it falls back to just the genesis founder — which is
  // the only account the constructor actually seeds as a bootstrap master there, so the anchor set matches
  // what can really sign.
  const gatedMasters = (genesis.masters?.length ?? 0) > 0;
  const genesisMasterAddrs = new Set<string>(
    genesis.masters?.length ? genesis.masters.map((m) => m.address) : [genesis.founder],
  );

  // Masters in the snapshot are the electorate; their ZTI is the finality denominator. Mirror live finality:
  // when the network has a genesis master set, ONLY those fixed masters are the electorate, so a checkpoint
  // finalized by 3 of 4 genesis masters (0.75) still verifies and a non-voting earned/anchor master cannot
  // inflate the denominator and make an honest 3-of-4 snapshot un-adoptable.
  // Single-finalizer: when it is active for this checkpoint's epoch, the electorate is EXACTLY the lead
  // finalizer, whose own vote is 100% of trust. Fast-sync verification must mirror live finality here, or a
  // fresh node computes the denominator as all four masters and rejects the leader's (single-vote, 25%)
  // checkpoint as under-quorum, so it can never adopt a snapshot and is stuck "syncing" forever. This is the
  // follower-side counterpart of State.masterZtiMap/totalMasterTrust.
  const sfaRaw = Number(process.env.ZIRA_SINGLE_FINALIZER_ACTIVATION_EPOCH);
  const sfa = Number.isFinite(sfaRaw) && sfaRaw > 0 ? Math.floor(sfaRaw) : PROTOCOL.SINGLE_FINALIZER_ACTIVATION_EPOCH;
  const singleFinalizer = sfa > 0 && best.finalizedEpoch >= sfa;
  const orderedMasters = genesis.masters?.length ? genesis.masters.map((m) => m.address) : [genesis.founder];
  const liRaw = Number(process.env.ZIRA_FINALITY_LEADER_INDEX);
  const leaderAddr = orderedMasters[Number.isFinite(liRaw) && liRaw >= 0 ? Math.min(Math.floor(liRaw), orderedMasters.length - 1) : 0];

  const masterByPub = new Map<string, SnapAccount>();
  let totalMaster = 0;
  for (const a of best.snapshot.accounts) {
    if (!a.isMaster || !a.pubkey) continue;
    if (gatedMasters && !genesisMasterAddrs.has(a.address)) continue;
    if (singleFinalizer && a.address !== leaderAddr) continue;   // only the lead finalizer is the electorate
    masterByPub.set(a.pubkey, a);
    totalMaster += a.zti;
  }
  if (totalMaster <= 0) return false;

  const counted = new Set<string>();
  let supporting = 0;
  let anchoredToGenesis = false;
  for (const v of best.votes) {
    if (v.epoch !== best.finalizedEpoch || v.stateRoot !== best.finalizedRoot) continue;
    if (!verifyCheckpointVote(v)) continue;
    const acct = masterByPub.get(v.voter);
    if (!acct) continue;
    if (counted.has(v.voter)) continue;
    counted.add(v.voter);
    supporting += acct.zti;
    if (genesisMasterAddrs.has(acct.address)) anchoredToGenesis = true;
  }
  return anchoredToGenesis && (supporting / totalMaster) >= PROTOCOL.FINALITY_THRESHOLD;
}

function normalizeSeedMultiaddr(addr: string): string {
  const trimmed = addr.trim();
  if (!trimmed || !trimmed.includes("/tcp/") || !trimmed.includes("/p2p/") || trimmed.includes("/ws")) return "";
  return trimmed;
}

function isPublicSeedMultiaddr(addr: string): boolean {
  if (!addr.includes("/tcp/") || !addr.includes("/p2p/") || addr.includes("/ws")) return false;
  if (/\/dns[46]\//.test(addr) && !/\/dns[46]\/localhost\//.test(addr)) return true;
  return /\/ip4\//.test(addr)
    && !/\/ip4\/(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|0\.0\.0\.0)/.test(addr);
}

export class ZiraNode {
  readonly genesis: GenesisDoc;
  readonly gid: string;
  readonly state: State;
  readonly soft = new SoftState();
  readonly checkpoints: Checkpoints;
  readonly models: ModelService;
  hardware: HardwareProfile | null = null;
  readonly opts: Required<ZiraNodeOptions>;
  founderServices: FounderServices | null = null;
  inferenceProvider: InferenceProvider | null = null;
  private modelAnnounceKeys = new Set<string>();
  private minerStop: (() => void) | null = null;
  private store: Store;
  private topics: ReturnType<typeof buildTopics>;
  private lastVotedEpoch = -1;
  private snapshotEvery = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private peerDialTimer: ReturnType<typeof setInterval> | null = null;
  private lastReapAt = 0;
  private eventsKp: Keypair | null = null;
  private eventsActive = false;
  private eventsClaimUZIR = 10 * PROTOCOL.UZIR_PER_ZIR;
  private eventsClaimed = new Map<string, number>();
  // Steward Anchor Event toggle (spec §2.1 / §6.2). ON by default since the public launch: the contribute
  // flow is live from first start, and the persisted anchor-state (loadAnchorState) still restores whatever
  // the steward last set — an explicit steward OFF survives restarts. Steward-gated at the RPC layer.
  // ZIRA_ANCHOR_EVENT=0 forces it off for private/dev deployments.
  private anchorEventEnabled = process.env.ZIRA_ANCHOR_EVENT !== "0";
  // Built-in defaults so the contribution flow is turnkey (the steward only flips the event ON). All public
  // values: the receiving addresses are meant to be shown to contributors, and a WalletConnect project id
  // is a public client identifier. The steward can still override any of them at runtime via setAnchorEvent.
  private anchorEventEvm = "0xA19af8f182D5ea55276F3Eb050B80Ec90635bF9B";   // USDT receiving (ETH/BSC/Polygon)
  private anchorEventTron = "TAoWupKVG5xivDnPqMGk9A5x5bLfUTietE";          // USDT receiving (TRON TRC-20)
  private anchorEventWcProjectId = "6ddd349a106a434236f6ae183ac8f62e";    // WalletConnect/Reown project id (public)
  // Anchor contributions: a contributor's wallet posts its tx hash after paying, and the payment watcher
  // verifies it ON-CHAIN (status confirmed/failed, confirmations, the real sender) so the steward assigns
  // a seat only against a confirmed payment. Bounded.
  private anchorContributionLog: { zirAddress: string; network: string; amountUsdt: number; txHash: string; classCode: string; quantity: number; ts: number; status: "pending" | "confirmed" | "failed"; confirmations: number; sender: string; reason?: string; checkedAt: number }[] = [];
  private paymentWatchTimer: ReturnType<typeof setInterval> | null = null;
  private paymentWatchBusy = false;
  private anchorReserveKp: Keypair | null = null;
  // Seats with a vesting-release pair already submitted but not yet settled, keyed seatId -> released
  // high-water mark we are driving to. Prevents re-submitting the same release every 1s tick before the
  // 5s epoch settles and advances seat.vestedUZIR. Cleared once the committed vestedUZIR catches up.
  private anchorVestInFlight = new Map<string, number>();

  private dataDir: string;
  private decentralizationActivationEpoch?: number;
  // SETTLER_PAUSE: an ops recovery lever. When ZIRA_SETTLER_PAUSE=1, this node issues NO settler payout,
  // coordination, or nonce-filler txs — so the masters advance on pure-epoch emission ONLY. A diverged fleet
  // (a stuck settler-nonce fork) can then be walked deterministically past the stuck epoch: with no settler tx
  // there is no per-node divergence source, every master computes the identical emission-only root, finality
  // crosses, and payouts are re-enabled (pause cleared) once the chain is live again. Off by default. Declared
  // BEFORE the constructor so its field initializer runs before restoreSettlerProgress (a field declared after
  // the ctor initializes AFTER the ctor body under this build's emit, clobbering the restored value).
  private readonly settlerPaused = process.env.ZIRA_SETTLER_PAUSE === "1";
  // Idempotent nonce-filler bookkeeping (see unstickSettlerNonce): the timestamp chosen ONCE per stuck committed
  // nonce, persisted so a restart rebuilds the byte-identical filler instead of a fresh tx id at the same nonce.
  // MUST be declared before the ctor (see settlerPaused note) so restoreSettlerProgress is not overwritten.
  private stuckFiller: { nonce: number; ts: number } | null = null;

  constructor(
    genesis: GenesisDoc,
    private identity: Keypair,
    private net: ZiraNetwork,
    dataDir: string,
    options: ZiraNodeOptions = {},
  ) {
    this.genesis = genesis;
    this.gid = genesisId(genesis);
    this.dataDir = dataDir;
    this.opts = {
      observeEnabled: options.observeEnabled ?? true,
      hardwareDetect: options.hardwareDetect ?? false,
      selfContained: options.selfContained ?? false,
      taskReapMs: options.taskReapMs ?? 30_000,
      providerConfig: options.providerConfig ?? { ...DEFAULT_PROVIDER_CONFIG },
      // Fast-sync is hardened (verifyFastSyncSnapshot binds the snapshot to a finalized checkpoint
      // backed by >= 67% of master trust including a genesis founder), so it is on by default.
      // ZIRA_FULL_SYNC=1 still forces a full replay from genesis.
      fastSync: options.fastSync ?? true,
      eventsKey: options.eventsKey ?? "",
      eventsClaimZir: options.eventsClaimZir ?? 0,
      anchorReserveKey: options.anchorReserveKey ?? "",
      activationEpochOverride: options.activationEpochOverride ?? 0,   // unused in opts; the live value is the field below
    };
    // Decentralization cutover activation epoch: option override, else env (coordinated ops lever), else
    // UNDEFINED so State falls back to the compiled protocol constant. NOTE: `Number(undefined)` is NaN, but
    // `Number(process.env.X ?? "")` would be Number("")===0 when unset — which would silently pin activation
    // to 0 and make the compiled constant dead on this path. So read the raw env and only treat it as a real
    // value when the var is actually SET to a non-negative integer; otherwise leave it undefined.
    const envRaw = process.env.ZIRA_DECENTRALIZATION_ACTIVATION_EPOCH;
    const envAct = envRaw !== undefined && envRaw !== "" ? Number(envRaw) : NaN;
    this.decentralizationActivationEpoch = options.activationEpochOverride ?? (Number.isInteger(envAct) && envAct >= 0 ? envAct : undefined);
    if (this.decentralizationActivationEpoch !== undefined) log.info(`decentralization cutover activation epoch = ${this.decentralizationActivationEpoch} (source: ${options.activationEpochOverride !== undefined ? "option" : "env"}); MUST be identical on every node`);
    this.state = new State(genesis, this.decentralizationActivationEpoch);
    this.checkpoints = new Checkpoints(genesis.network);
    this.store = new Store(dataDir);
    this.topics = buildTopics(this.gid);
    this.models = new ModelService(dataDir, net, identity, () => this.founderAddresses(), (a) => this.publishModelAnnounce(a), launchModelsFor(genesis.network));
    if (genesis.network !== "mainnet") this.state.setAuthorizedFounders([...this.state.activeFounderAddresses(), ...this.founderBackups()]);
    // Model management is isolated: only a founder node (or advanced self-contained mode) ever wires it in.
    if (this.isFounder() || this.opts.selfContained) {
      this.founderServices = new FounderServices(this.models, identity, (rec) => this.publishRecommendation(rec));
    }
    // Finality bootstrap. When the genesis defines an explicit master set (mainnet), finality rests on
    // those keyless coordinator nodes — seeded in State.seedGenesisMasters and signing with their own node
    // keys — and the founder is deliberately NOT a master. That way finality never stalls when the local
    // steward is offline, and the founder key need never run on the VPS. Without a genesis master set
    // (devnet/test), the steward is the sole bootstrap master so a single running node finalizes at once.
    // The other founders keep full founder permissions but are not genesis masters: they and the community
    // earn master standing by serving accurately over time, and finality decentralizes from there.
    if (!(genesis.masters && genesis.masters.length)) {
      const steward = this.state.accounts.get(genesis.founder) ?? null;
      if (steward) { steward.isMaster = true; steward.zti = Math.max(steward.zti, 1.0); steward.ztiByDomain.general = 1.0; }
    }
    if (options.eventsKey) {
      try { this.eventsKp = keypairFromPrivate(options.eventsKey.trim()); }
      catch { log.warn("ZIRA_EVENTS_KEY is not a valid key, events disabled"); }
      if (options.eventsClaimZir && options.eventsClaimZir > 0) this.eventsClaimUZIR = Math.round(options.eventsClaimZir * PROTOCOL.UZIR_PER_ZIR);
    }
    if (options.anchorReserveKey) {
      try { this.anchorReserveKp = keypairFromPrivate(options.anchorReserveKey.trim()); }
      catch { log.warn("ZIRA_ANCHOR_RESERVE_KEY invalid, anchor assignment disabled"); }
    }
    // The anchor steward authority that may mint/move the 512 anchor Resonators is the wallet that owns
    // the anchor positions at genesis. Prefer the genesis anchor ownership (the canonical steward of the
    // active network); fall back to the anchor-reserve key's address. SoftState authenticates anchor
    // resonators against this address, so devnet/test networks use their own steward, not the mainnet one.
    const genesisAnchorOwner = genesis.anchorOwnership?.find((o) => o.owner)?.owner;
    if (genesisAnchorOwner) this.soft.anchorStewardAddress = genesisAnchorOwner;
    else if (this.anchorReserveKp) this.soft.anchorStewardAddress = this.anchorReserveKp.address;

    // Materialize the 512 anchor Resonators deterministically from the loaded anchor seats AT
    // CONSTRUCTION, on every node, with no signing key — exactly like the anchor positions + class ZTI,
    // which every node derives from genesis with no signer. This is what makes the anchor-reserve wallet
    // list all 512 anchor resonators even on a node WITHOUT the steward key and before start(). The
    // start()/tick() paths re-run it to re-key resonators whose positions transfer. Consensus-neutral.
    this.materializeAnchorResonators();
  }

  // ---- transparent ecosystem events: airdrops/grants from a founder-held events wallet (never a sale) ----
  eventsStatus(): { configured: boolean; active: boolean; claimUZIR: number; walletUZIR: number; visible: boolean } {
    const walletUZIR = this.eventsKp ? this.state.balanceOf(this.eventsKp.address) : 0;
    const visible = Boolean(this.eventsKp) && this.eventsActive && walletUZIR >= EVENTS_FLOOR_UZIR;
    return { configured: Boolean(this.eventsKp), active: this.eventsActive, claimUZIR: this.eventsClaimUZIR, walletUZIR, visible };
  }
  // Founder-gated at the RPC layer.
  setEventsConfig(patch: { active?: boolean; claimZir?: number }): ReturnType<ZiraNode["eventsStatus"]> {
    if (typeof patch.active === "boolean") this.eventsActive = patch.active;
    if (patch.claimZir !== undefined && patch.claimZir > 0) this.eventsClaimUZIR = Math.round(patch.claimZir * PROTOCOL.UZIR_PER_ZIR);
    return this.eventsStatus();
  }

  // ---- steward Anchor Event toggle (spec §2.1 / §6.2) ----
  // Public read: every client uses this to decide whether to show the anchor contribute section, and which
  // USDT receiving address to display. The addresses are steward-set at runtime (from local-private), never
  // hardcoded in source, so they can move to a multisig without a code change.
  anchorEventStatus(): { enabled: boolean; evm: string; tron: string; wcProjectId: string } {
    return { enabled: this.anchorEventEnabled, evm: this.anchorEventEvm, tron: this.anchorEventTron, wcProjectId: this.anchorEventWcProjectId };
  }
  // Steward-gated at the RPC layer. Off hides the contribute section for all users with no trace.
  setAnchorEvent(patch: { enabled?: boolean; evm?: string; tron?: string; wcProjectId?: string }): { enabled: boolean; evm: string; tron: string; wcProjectId: string } {
    // Apply addresses BEFORE the enabled check so a single call that sets both an address and enabled:true
    // still succeeds. The event cannot go live with NO receiving address — otherwise every user sees a
    // contribute card that is permanently disabled ("steward is finalizing the address"). This guards a raw
    // POST as well as the Console (which also disables the Turn-ON button until an address is entered).
    if (typeof patch.evm === "string") this.anchorEventEvm = patch.evm.trim();
    if (typeof patch.tron === "string") this.anchorEventTron = patch.tron.trim();
    if (typeof patch.wcProjectId === "string") this.anchorEventWcProjectId = patch.wcProjectId.trim();
    if (typeof patch.enabled === "boolean") this.anchorEventEnabled = patch.enabled && !!(this.anchorEventEvm || this.anchorEventTron);
    this.persistAnchorState();
    return this.anchorEventStatus();
  }
  // Public, best-effort: a contributor's app reports its USDT payment so the steward sees it pending.
  // Fields are clamped; on-chain detection is the authoritative confirmation before a seat is assigned.
  recordAnchorContribution(c: { zirAddress?: string; network?: string; amountUsdt?: number; txHash?: string; classCode?: string; quantity?: number }): { ok: boolean } {
    const s = (v: unknown, n: number) => String(v ?? "").slice(0, n);
    this.anchorContributionLog.push({
      zirAddress: s(c.zirAddress, 80), network: s(c.network, 24), amountUsdt: Math.max(0, Number(c.amountUsdt) || 0),
      txHash: s(c.txHash, 100), classCode: s(c.classCode, 4), quantity: Math.max(1, Math.floor(Number(c.quantity) || 1)), ts: Date.now(),
      status: "pending", confirmations: 0, sender: "", checkedAt: 0,
    });
    if (this.anchorContributionLog.length > 500) this.anchorContributionLog.splice(0, this.anchorContributionLog.length - 500);
    this.persistAnchorState();
    return { ok: true };
  }
  anchorContributions(): typeof this.anchorContributionLog { return [...this.anchorContributionLog].reverse(); }

  // Persist the anchor event + contribution queue (non-consensus, steward-run) so a node/gateway restart
  // does not silently switch the event off or lose the queue the steward still has to fulfill.
  private persistAnchorState(): void {
    try {
      this.store.saveAnchorState({
        event: { enabled: this.anchorEventEnabled, evm: this.anchorEventEvm, tron: this.anchorEventTron, wcProjectId: this.anchorEventWcProjectId },
        contributions: this.anchorContributionLog,
      });
    } catch { /* best effort; in-memory state still serves until next restart */ }
  }
  // Re-hydrate the anchor event + contributions from disk on start (called by start() after the snapshot).
  private restoreAnchorState(): void {
    const saved = this.store.loadAnchorState();
    if (!saved) return;
    const e = (saved.event ?? {}) as { enabled?: boolean; evm?: string; tron?: string; wcProjectId?: string };
    if (typeof e.evm === "string" && e.evm) this.anchorEventEvm = e.evm;
    if (typeof e.tron === "string" && e.tron) this.anchorEventTron = e.tron;
    if (typeof e.wcProjectId === "string" && e.wcProjectId) this.anchorEventWcProjectId = e.wcProjectId;
    if (typeof e.enabled === "boolean") this.anchorEventEnabled = e.enabled && !!(this.anchorEventEvm || this.anchorEventTron);
    if (Array.isArray(saved.contributions)) this.anchorContributionLog = saved.contributions.slice(-500) as typeof this.anchorContributionLog;
  }

  /**
   * Restore the settler payout watermarks so a RESTART does not re-issue a payout for a bucket it already
   * settled. Without this, a restarted settler re-pays the current bucket with a DIFFERENT live-peer-derived
   * payee set (fewer miners reconnected), and the conflicting txs diverge the masters and freeze quorum — a
   * real production incident (2026-07-04). Only the settler ever writes this file; on other nodes it is inert.
   */
  private restoreSettlerProgress(): void {
    const saved = this.store.loadSettlerProgress();
    if (!saved) return;
    if (typeof saved.lastParticipationBucket === "number") this.lastParticipationBucket = saved.lastParticipationBucket;
    if (typeof saved.lastAutonomousResonanceBucket === "number") this.lastAutonomousResonanceBucket = saved.lastAutonomousResonanceBucket;
    if (Array.isArray(saved.paidResonatorRewards)) this.paidResonatorRewards = new Set(saved.paidResonatorRewards.slice(-5000));
    if (Array.isArray(saved.settledCoordinationQueries)) this.settledCoordinationQueries = new Set(saved.settledCoordinationQueries.slice(-5000));
    if (saved.minerAnswerCredits && typeof saved.minerAnswerCredits === "object") {
      this.minerAnswerCredits = new Map(Object.entries(saved.minerAnswerCredits).filter(([, v]) => typeof v === "number") as [string, number][]);
    }
    if (saved.pendingQueryCharges && typeof saved.pendingQueryCharges === "object") {
      // Durable paid-query charges observed but not yet settled: rebuild so a restart never loses an asker's
      // funded query (and never re-scans a charge that has already scrolled out of the bounded ledger history).
      this.pendingQueryCharges = new Map(Object.entries(saved.pendingQueryCharges)
        .filter(([, v]) => v && typeof (v as { amountUZIR?: unknown }).amountUZIR === "number" && typeof (v as { ts?: unknown }).ts === "number") as [string, { amountUZIR: number; ts: number }][]);
    }
    if (saved.stuckFiller && typeof saved.stuckFiller.nonce === "number" && typeof saved.stuckFiller.ts === "number") {
      this.stuckFiller = { nonce: saved.stuckFiller.nonce, ts: saved.stuckFiller.ts };   // rebuild the identical filler after a restart
    }
    log.info(`settler progress restored: participationBucket=${this.lastParticipationBucket} resonanceBucket=${this.lastAutonomousResonanceBucket} paidRewards=${this.paidResonatorRewards.size} settledQueries=${this.settledCoordinationQueries.size} answerCredits=${this.minerAnswerCredits.size}`);
  }

  /** Settler role right now (diagnostics + tests): whether this node is the ACTIVE settler and the failover
   *  index it computed from live master heartbeats. */
  settlerStatus(): { isSettler: boolean; activeIndex: number; liveMasters: number } {
    return {
      isSettler: this.isNetworkSettler(),
      activeIndex: this.activeSettlerIndex(),
      liveMasters: this.state.liveGenesisMasters(Date.now(), ZiraNode.SETTLER_FAILOVER_MS).size,
    };
  }

  /** Current settler payout watermarks (diagnostics + tests). Reflects what this node has already settled. */
  settlerProgress(): { lastParticipationBucket: number; lastAutonomousResonanceBucket: number; paidResonatorRewards: number; settledCoordinationQueries: number; stuckFiller: { nonce: number; ts: number } | null } {
    return {
      lastParticipationBucket: this.lastParticipationBucket,
      lastAutonomousResonanceBucket: this.lastAutonomousResonanceBucket,
      paidResonatorRewards: this.paidResonatorRewards.size,
      settledCoordinationQueries: this.settledCoordinationQueries.size,
      stuckFiller: this.stuckFiller,
    };
  }

  /** Persist the settler payout watermarks after each payout so a restart is idempotent (atomic write). */
  private persistSettlerProgress(): void {
    try {
      this.store.saveSettlerProgress({
        lastParticipationBucket: this.lastParticipationBucket,
        lastAutonomousResonanceBucket: this.lastAutonomousResonanceBucket,
        paidResonatorRewards: [...this.paidResonatorRewards],
        settledCoordinationQueries: [...this.settledCoordinationQueries],
        minerAnswerCredits: Object.fromEntries(this.minerAnswerCredits),
        pendingQueryCharges: Object.fromEntries(this.pendingQueryCharges),
        stuckFiller: this.stuckFiller ?? undefined,
      });
    } catch { /* best effort; in-memory guard still holds until next restart */ }
  }

  /**
   * Payment watcher (spec §2.5). Verifies each still-pending contribution ON-CHAIN by its tx hash: it must
   * be a USDT transfer to the steward's receiving address for exactly the class x quantity amount, with
   * enough confirmations. Confirmed ones flip to "confirmed" (with the real sender) so the steward assigns
   * the seat against a verified payment. RPC/network errors leave the entry pending to retry next tick.
   * Runs only while the anchor event is on and a receiving address is set, and never overlaps itself.
   */
  private async runPaymentWatch(): Promise<void> {
    if (this.paymentWatchBusy) return;
    if (!this.anchorEventEnabled || !(this.anchorEventEvm || this.anchorEventTron)) return;
    const pending = this.anchorContributionLog.filter((c) => c.status === "pending" && c.txHash);
    if (pending.length === 0) return;
    this.paymentWatchBusy = true;
    try {
      for (const c of pending.slice(0, 20)) {     // bound work per tick
        try {
          const r = await verifyContribution({ network: c.network as WatchNetwork, txHash: c.txHash, classCode: c.classCode, quantity: c.quantity, evm: this.anchorEventEvm, tron: this.anchorEventTron });
          c.checkedAt = Date.now();
          c.confirmations = r.confirmations;
          c.sender = r.sender || c.sender;
          if (r.confirmed) {
            c.status = "confirmed";
            c.reason = undefined;
            log.info(`anchor payment CONFIRMED: ${c.classCode} x${c.quantity} ${c.amountUsdt} USDT on ${c.network} from ${c.sender.slice(0, 12)} for ${c.zirAddress.slice(0, 12)} (tx ${c.txHash.slice(0, 12)})`);
          } else if (r.reason && /failed on-chain/.test(r.reason)) {
            c.status = "failed"; c.reason = r.reason;
          } else {
            c.reason = r.reason;      // still pending (not found / awaiting confirmations / mismatch)
          }
        } catch (e) {
          c.checkedAt = Date.now(); c.reason = `check failed: ${(e as Error).message}`;   // transient; retry next tick
        }
      }
      this.persistAnchorState();   // confirmations/senders/status may have changed; keep the queue durable
    } finally {
      this.paymentWatchBusy = false;
    }
  }
  claimEvent(address: string): { ok: boolean; amountUZIR?: number; reason?: string } {
    if (!this.eventsKp) return { ok: false, reason: "events are not configured on this node" };
    if (!/^zir1[0-9a-z]{6,}$/.test(address)) return { ok: false, reason: "enter a valid ZIR address" };
    if (address === this.eventsKp.address) return { ok: false, reason: "the events wallet cannot claim from itself" };
    const status = this.eventsStatus();
    if (!status.active) return { ok: false, reason: "events are not active right now" };
    if (status.walletUZIR < EVENTS_FLOOR_UZIR) return { ok: false, reason: "the events reserve is below its floor" };
    if (this.eventsClaimed.has(address)) return { ok: false, reason: "this wallet has already claimed" };
    const body: TxBody = {
      network: this.genesis.network,
      from: this.eventsKp.address,
      fromPubKey: this.eventsKp.publicKey,
      to: address,
      amountUZIR: this.eventsClaimUZIR,
      feeUZIR: PROTOCOL.BASE_FEE_UZIR,
      nonce: this.state.provisionalNonce(this.eventsKp.address),
      kind: "transfer",
      parents: [],
      timestamp: Date.now(),
      memo: "ZIRA events airdrop",
    };
    const r = this.submitTx(signTx(body, this.eventsKp.privateKey));
    if (r.accepted) { this.eventsClaimed.set(address, 1); this.persistEventsClaimed(); }
    return { ok: r.accepted, amountUZIR: r.accepted ? this.eventsClaimUZIR : undefined, reason: r.reason };
  }

  // ---- anchor seats are acquired by CONTRIBUTION, not by code. A contributor pays USDT to the steward's
  // receiving address (anchor event); once the payment-watcher confirms it, the steward assigns a seat to
  // the contributor's ZIR address with transferAnchorPositions() below, which transfers a reserve-held seat
  // and opens its one-year vesting. There is no user-facing code redemption. ----

  /**
   * Release any anchor-vesting that has linearly accrued since the last release. For every seat with an
   * active schedule whose beneficiary is owed a positive claimable delta, submit a real transfer from
   * the anchor-reserve wallet (so the reserve account is debited and supply stays exact) plus an
   * anchor_vest_release record (so every node's vested high-water mark advances in lockstep). Runs only
   * on the node holding the reserve key; idempotent and safe to call every tick.
   */
  releaseAnchorVesting(now: number): void {
    const kp = this.anchorReserveKp;
    if (!kp) return;
    let nonce = this.state.provisionalNonce(kp.address);
    const sign = (body: TxBody) => signTx(body, kp.privateKey);
    for (const seat of this.state.anchorSeats()) {
      if (!seat.vestTotalUZIR || !seat.vestBeneficiary || seat.vestStartAt === undefined) continue;
      if (seat.vestFunder !== kp.address) continue; // only the funding reserve wallet advances releases
      // Clear an in-flight marker once the committed high-water mark has caught up to it.
      const inFlight = this.anchorVestInFlight.get(seat.id);
      if (inFlight !== undefined) {
        if (seat.vestedUZIR >= inFlight) this.anchorVestInFlight.delete(seat.id);
        else continue; // a release for this seat is still pending settlement; do not double-submit
      }
      const claimable = anchorVestingClaimableUZIR(
        { totalUZIR: seat.vestTotalUZIR, startAt: seat.vestStartAt, durationMs: seat.vestDurationMs },
        seat.vestedUZIR, now,
      );
      if (claimable <= 0) continue;
      // The reserve must afford the payout plus two base fees; otherwise skip this seat this tick.
      if (this.state.balanceOf(kp.address) < claimable + 2 * PROTOCOL.BASE_FEE_UZIR) continue;
      const baseBody = { network: this.genesis.network, from: kp.address, fromPubKey: kp.publicKey, parents: [] as string[], timestamp: now };
      const release = seat.vestedUZIR + claimable;
      const accounting = sign({ ...baseBody, to: kp.address, amountUZIR: 0, feeUZIR: PROTOCOL.BASE_FEE_UZIR, nonce, kind: "anchor_vest_release", memo: JSON.stringify({ anchor: "vest_release", data: { seatId: seat.id, releasedUZIR: release } }) });
      const payout = sign({ ...baseBody, to: seat.vestBeneficiary, amountUZIR: claimable, feeUZIR: PROTOCOL.BASE_FEE_UZIR, nonce: nonce + 1, kind: "transfer", memo: "anchor vesting release " + seat.id });
      if (!this.submitTx(accounting).accepted) continue;
      if (!this.submitTx(payout).accepted) continue;
      this.anchorVestInFlight.set(seat.id, release);
      nonce += 2;
    }
  }

  /**
   * Founder-gated at the RPC layer. The steward transfers one or more anchor POSITIONS (resonator
   * assets) it owns to a chosen ZIR address in a single signed operation. Single = one seatId, batch =
   * many. Each position carries its class/ZTI/weight and its ZIR allocation; on transfer a fresh one-year
   * linear vesting of the allocation opens to the new owner, funded by the steward reserve wallet (which
   * holds the backing ZIR). The allocation is NOT paid out instantly — releaseAnchorVesting() pays the
   * claimable delta over ~12 months. Consensus rules are unchanged; this is a single anchor_position_transfer.
   */
  transferAnchorPositions(seatIds: string[], to: string, vestStartAt?: number, vestDurationMs?: number):
    { ok: boolean; reason?: string; seatIds?: string[]; vestingUZIR?: number; vestStartAt?: number; vestEndAt?: number } {
    if (!this.anchorReserveKp) return { ok: false, reason: "anchor reserve key not configured on this node" };
    if (!Array.isArray(seatIds) || seatIds.length === 0) return { ok: false, reason: "select at least one position" };
    if (typeof to !== "string" || !/^zir1[0-9a-z]{6,}$/.test(to)) return { ok: false, reason: "enter a valid ZIR address" };
    const kp = this.anchorReserveKp;
    const ids = [...new Set(seatIds.map(String))];
    let vestingUZIR = 0;
    for (const id of ids) {
      const seat = this.state.anchorSeat(id);
      if (!seat) return { ok: false, reason: `unknown seat ${id}` };
      if (seat.owner !== kp.address) return { ok: false, reason: `seat ${id} is not owned by the steward reserve wallet` };
      if (!seat.vestTotalUZIR) vestingUZIR += seat.zirReserveUZIR;
    }
    const startAt = Number.isFinite(vestStartAt) ? (vestStartAt as number) : Date.now();
    const body: TxBody = {
      network: this.genesis.network, from: kp.address, fromPubKey: kp.publicKey, to: kp.address,
      amountUZIR: 0, feeUZIR: PROTOCOL.BASE_FEE_UZIR, nonce: this.state.provisionalNonce(kp.address),
      kind: "anchor_position_transfer", parents: [], timestamp: startAt,
      memo: JSON.stringify({ anchor: "position_transfer", data: { seatIds: ids, to, vestStartAt: startAt, ...(vestDurationMs ? { vestDurationMs } : {}) } }),
    };
    const r = this.submitTx(signTx(body, kp.privateKey));
    if (!r.accepted) return { ok: false, reason: r.reason };
    return { ok: true, seatIds: ids, vestingUZIR, vestStartAt: startAt, vestEndAt: startAt + (vestDurationMs && vestDurationMs > 0 ? vestDurationMs : ANCHOR_VESTING_DURATION_MS) };
  }

  get topicList(): string[] { return this.topics.all(); }

  async start(): Promise<void> {
    // replay durable events, then catch up the epoch clock
    const persisted = this.store.loadSnapshot();
    if (persisted) this.state.loadSnapshot(persisted);
    // Compact BEFORE replay: on top of a snapshot only the recent window is needed, and replaying a bloated
    // log (verifying every stale tx signature) can stall startup for minutes before RPC ever binds. Guarded
    // to the snapshot path — a fresh node replaying from genesis keeps its full history.
    if (persisted) this.compactEventLog(true);
    let replayed = 0;
    for (const env of this.store.readEvents()) { this.ingest(env, false); replayed++; }
    if (replayed) log.info(`replayed ${replayed} durable events`);
    // Re-hydrate the steward-run anchor event + contribution queue (non-consensus), so a gateway restart
    // does not switch the event off for everyone or drop contributions the steward still owes seats for.
    this.restoreAnchorState();
    // Re-hydrate the settler payout watermarks so a restart never re-issues a divergent duplicate payout.
    this.restoreSettlerProgress();
    // Re-hydrate the events-airdrop already-claimed guard so a restart cannot let every address claim again.
    this.restoreEventsClaimed();
    // a brand new node (no snapshot, no durable events) is eligible to fast sync from a peer
    this.startedFresh = persisted === null && replayed === 0;
    this.state.advance(Date.now());

    // network wiring
    this.net.onMessage((topic, data, from) => this.onWire(topic, data, from));
    this.net.setSyncProvider(() => this.syncFrames());
    this.net.onSyncFrame((data) => {
      try { this.ingest(JSON.parse(dec.decode(data)), false); } catch { /* skip */ }
    });
    // fast sync: a joining node adopts a finalized snapshot from a peer instead of replaying history
    this.net.handle(SNAPSHOT_PROTOCOL, () => this.serveSnapshot());
    this.net.handle(LIVENESS_PROTOCOL, (req, from) => this.serveLiveness(req, from));
    this.net.onPeerConnect((peer) => {
      this.models.announceLocal();
      void this.models.reconcileStorage();
      // Return the fast-sync promise so the network layer awaits snapshot adoption + floor arming
      // before pulling this peer's event tail (F2). Other work above is fire-and-forget.
      return this.maybeFastSync(peer);
    });

    await this.net.start();
    // The model field runs on every node: it tracks authorized models, serves their chunks
    // peer to peer, and (when mining is on) runs the recommended model to answer the field. Only the
    // launch authority may introduce a model (provide/provideByUrl enforce that); everyone else just relays
    // and, optionally, mines.
    this.models.init();
    void this.dialSavedPeers();
    // Keep dialing saved peers until we have a small healthy spread of connections, not just one. The
    // libp2p layer also actively discovers peers via bootstrap + DHT; this is the node-level complement
    // that re-dials previously-seen peers. The target stays well under the F7 maxConnections cap.
    const redialTarget = envInt("ZIRA_PEER_REDIAL_TARGET", 6);
    this.peerDialTimer = setInterval(() => {
      if (this.net.peerCount() < redialTarget) void this.dialSavedPeers();
    }, 30_000);

    // hardware detection is advisory: it sizes the recommended GPU layers / threads for mining and
    // helps the user understand what their machine can run. It never gates participation.
    if (this.opts.hardwareDetect) {
      this.detectingHardware = detectHardware().then((h) => { this.hardware = h; this.applyHardwareToMining(h); }).catch(() => {});
    }

    // The miner answers the field with the distributed model whenever mining is enabled. It is a
    // no-op until the user flips mining on in the Console (or ZIRA_MINE=1), so it is safe to always run.
    this.minerStop = startMiner(this, this.identity, { domains: [], label: this.opts.providerConfig.label || "miner" });

    // Advanced: an explicit OpenAI-compatible endpoint provider (Tier 2). Off by default; most users
    // never need a local provider, mining covers coordination. Console settings survive restarts.
    const persistedProvider = this.loadProviderConfig();
    if (persistedProvider) this.opts.providerConfig = persistedProvider;
    if (this.opts.providerConfig.enabled) this.startProvider(this.opts.providerConfig);

    // Seed the founder-owned network Resonators (general-purpose operating coordinators across model
    // types) once, on the node that holds the network-resonator owner key. Idempotent and soft-state,
    // so it never touches the genesis hash, consensus state root, or supply beyond the existing reserve.
    this.seedNetworkResonators();

    // Materialize the 512 anchor Resonators on EVERY node, deterministically from the anchor seats —
    // exactly like the anchor positions + class ZTI, which every node derives from genesis with no signer.
    // This is what makes the anchor-reserve wallet show all 512 resonators even on a node WITHOUT the
    // steward key. Idempotent soft-state, mints no ZIR, consensus-neutral.
    this.materializeAnchorResonators();

    // On the steward node (holds the anchor-reserve key) ALSO publish steward-signed anchor Resonators so
    // they gossip to peers running older code that authenticate by signature. Idempotent, consensus-neutral.
    this.seedAnchorResonators();

    // the epoch clock: advance state, vote checkpoints, prune, snapshot
    this.timer = setInterval(() => this.tick(), 1000);
    // payment watcher (§2.5): verify pending anchor contributions on-chain. Self-guards when the event is
    // off or there is nothing pending, so it is cheap when idle. Slow cadence (chain confirmations are slow).
    this.paymentWatchTimer = setInterval(() => { void this.runPaymentWatch(); }, 45_000);
    log.info(`ZIRA node up. network=${this.genesis.network} genesis=${this.gid.slice(0, 12)} identity=${this.identity.address}`);
  }

  /**
   * Seed the steward/founder-owned "network" Resonators: general-purpose coordinating intelligences,
   * one per model TYPE plus a cross-domain field coordinator, owned by the main steward wallet. These
   * are transferable Resonator positions (standing), NOT newly minted ZIR — each agent wallet is seeded
   * with a small operating balance from the owner's already-allocated founder-ops funds. Resonators are
   * soft state (not in the consensus state root / genesis hash), so seeding them is consensus-neutral.
   * Runs only on the node whose identity owns these positions; idempotent (skips already-present ids).
   */
  private seedNetworkResonators(): void {
    // Seed only on mainnet (the launch network) plus advanced self-contained mode. Plain devnet/test
    // nodes do not seed, so their deterministic founder-nonce sequences (used by the p2p/fastsync
    // tests) are untouched. The owner is the fixed steward wallet.
    if (this.genesis.network !== "mainnet" && !this.opts.selfContained) return;
    const owner = MAINNET_NETWORK_RESONATOR_OWNER;
    if (this.identity.address !== owner) return;        // only the owning node seeds and signs
    const now = Date.now();
    const seedUZIR = 25 * PROTOCOL.UZIR_PER_ZIR;        // small operating float per Resonator agent wallet
    for (const spec of NETWORK_RESONATOR_SPECS) {
      if (this.soft.resonators.has(spec.id)) continue;  // already seeded (replayed soft state)
      const agent = keypairFromPrivate(hashHex(`${this.identity.privateKey}:network-resonator:${spec.id}`));
      // Fund the agent wallet from the owner's funds if it has nothing yet. This moves already-allocated
      // ZIR (founder-ops), it does not mint: supply is unchanged. Best-effort; the record still seeds.
      if (this.state.balanceOf(agent.address) <= 0 && this.state.balanceOf(owner) > seedUZIR + PROTOCOL.BASE_FEE_UZIR) {
        const body: TxBody = {
          network: this.genesis.network, from: owner, fromPubKey: this.identity.publicKey, to: agent.address,
          amountUZIR: seedUZIR, feeUZIR: PROTOCOL.BASE_FEE_UZIR, nonce: this.state.provisionalNonce(owner),
          kind: "transfer", parents: [], timestamp: now, memo: `network resonator fund ${spec.name}`,
        };
        this.submitTx(signTx(body, this.identity.privateKey));
      }
      const record = this.buildNetworkResonator(spec, owner, agent.address, now);
      this.publishResonator(record);
    }
    log.info(`seeded ${NETWORK_RESONATOR_SPECS.length} network Resonators owned by ${owner}`);
  }

  /**
   * Seed the 512 ANCHOR Resonators: one operating coordinating intelligence per anchor POSITION, owned
   * by the anchor-reserve steward wallet at genesis and seeded with the position's class ZTI (A 0.95,
   * B 0.85, C 0.75, D 0.65, E 0.55, F 0.45). The anchor record (consensus state) is the structural seat;
   * this resonator is the working agent the position's owner operates and lists. Runs only on the node
   * holding the anchor-reserve key (which IS the steward wallet). Each resonator is signed by the steward
   * key with owner = the position's current on-chain owner, so it follows the position through transfers.
   * Soft state, mints no ZIR (the position allocation is the existing reserve-backed amount that vests on
   * transfer), so seeding is consensus-neutral and never touches the genesis hash. Idempotent.
   */
  /**
   * Steward capability: (re)seed the steward/founder network Resonators and the 512 anchor Resonators,
   * and re-key any anchor resonator whose position has changed owner. Idempotent and consensus-neutral
   * (soft state, no minting). Exposed for the RPC steward surface and tests; the start/tick paths call
   * the same seeders automatically. Returns how many resonators are now present.
   */
  seedStewardResonators(): { networkResonators: number; anchorResonators: number } {
    this.seedNetworkResonators();
    this.materializeAnchorResonators();
    this.seedAnchorResonators();
    let anchor = 0;
    for (const r of this.soft.resonators.values()) if (r.id.startsWith("anchor-")) anchor++;
    return { networkResonators: NETWORK_RESONATOR_SPECS.length, anchorResonators: anchor };
  }

  /**
   * Materialize the 512 anchor Resonators on THIS node, deterministically from the anchor seats. Runs on
   * EVERY node (no steward key required): the anchor positions and their class ZTI are already derived by
   * every node from genesis with no signer, and the anchor resonators now materialize the same way. This
   * is what makes the anchor-reserve wallet list all 512 anchor resonators on a node that holds no steward
   * key. Idempotent (skips seats already materialized for their current owner), and it re-keys a resonator
   * when its position transfers. Soft state, mints no ZIR, consensus-neutral.
   */
  private materializeAnchorResonators(): void {
    const seats = this.state.anchorSeats().map((s) => ({ id: s.id, classCode: s.classCode, owner: s.owner }));
    const n = this.soft.materializeAnchorResonators(seats, Date.now());
    if (n > 0) log.info(`materialized ${n} anchor Resonators (deterministic, no signing key required)`);
  }

  private seedAnchorResonators(): void {
    const kp = this.anchorReserveKp;
    if (!kp) return;                                    // only the steward (anchor-reserve key holder) seeds
    const now = Date.now();
    let seeded = 0;
    for (const seat of this.state.anchorSeats()) {
      const id = `anchor-${seat.id}`;
      const existing = this.soft.resonators.get(id);
      if (!existing) {
        // Seed positions the steward currently owns. (Positions already transferred out before this node
        // first ran are seeded/followed by whichever steward node authored the transfer.)
        if (seat.owner !== kp.address) continue;
        const spec = anchorResonatorSpec(seat.id, seat.classCode);
        this.publishResonator(this.buildAnchorResonator(spec, seat, kp, now));
        seeded++;
      } else if (seat.owner && existing.owner !== seat.owner) {
        // The position changed owner (a settled position_transfer): re-publish so the operating resonator
        // follows its position to the new owner. Standing/jobs/earnings carry (SoftState keeps them for
        // an existing id). Re-keyed by the steward authority.
        const spec = anchorResonatorSpec(seat.id, seat.classCode);
        this.publishResonator(this.buildAnchorResonator(spec, seat, kp, Math.max(now, (existing.updatedAt ?? 0) + 1)));
      }
    }
    if (seeded > 0) log.info(`seeded ${seeded} anchor Resonators owned by the steward ${kp.address}`);
  }

  private buildAnchorResonator(spec: AnchorResonatorSpec, seat: Anchor, steward: Keypair, now: number): Resonator {
    // The agent wallet is deterministically derived from the steward key + seat id; it carries no float
    // (anchor resonators draw on the position's vesting allocation, not a seeded operating balance).
    const agent = keypairFromPrivate(hashHex(`${steward.privateKey}:anchor-resonator:${seat.id}`));
    const draft = {
      id: spec.id,
      owner: seat.owner!,                          // follows the position's on-chain owner
      address: agent.address,
      name: spec.name,
      purpose: spec.purpose,
      systemPrompt: spec.systemPrompt,
      domains: spec.domains,
      modelPref: spec.modelType,
      zti: spec.zti,                               // seeded at the position's class ZTI (preserved by SoftState)
      ztiByDomain: Object.fromEntries(spec.domains.map((d) => [d, spec.zti])) as Record<string, number>,
      resonanceEnabled: true,
      balanceUZIR: anchorResonatorOperatingFloatUZIR(spec.classCode),
      spendLimits: { perTxUZIR: PROTOCOL.UZIR_PER_ZIR, perDayUZIR: 8 * PROTOCOL.UZIR_PER_ZIR, minCounterpartyZti: 0, allowedDomains: spec.domains },
      totalEarnedUZIR: 0,
      totalSpentUZIR: 0,
      jobsDone: 0,
      priceUZIR: PROTOCOL.UZIR_PER_ZIR,
      listed: true,
      createdAt: now,
      updatedAt: now,
      status: "learning" as const,
    };
    // Signed by the STEWARD authority (not the owner): SoftState authenticates anchor resonators by the
    // steward signer so the steward can mint them and move them with their positions.
    return signRecord(draft, steward.privateKey);
  }

  private buildNetworkResonator(spec: NetworkResonatorSpec, owner: string, agentAddress: string, now: number): Resonator {
    const draft = {
      id: spec.id,
      owner,
      address: agentAddress,
      name: spec.name,
      purpose: spec.purpose,
      systemPrompt: spec.systemPrompt,
      domains: spec.domains,
      modelPref: spec.modelType,                 // route alongside the matching model modality
      zti: spec.zti,                             // seeded structural standing (preserved by SoftState for the node)
      ztiByDomain: Object.fromEntries(spec.domains.map((d) => [d, spec.zti])) as Record<string, number>,
      resonanceEnabled: true,
      balanceUZIR: 25 * PROTOCOL.UZIR_PER_ZIR,
      spendLimits: { perTxUZIR: PROTOCOL.UZIR_PER_ZIR, perDayUZIR: 8 * PROTOCOL.UZIR_PER_ZIR, minCounterpartyZti: 0, allowedDomains: spec.domains },
      totalEarnedUZIR: 0,
      totalSpentUZIR: 0,
      jobsDone: 0,
      priceUZIR: PROTOCOL.UZIR_PER_ZIR,
      listed: true,
      createdAt: now,
      updatedAt: now,
      status: "learning" as const,
    };
    return signRecord(draft, this.identity.privateKey);
  }

  /** The node's operational role. CONSENSUS nodes (genesis masters + the read gateway) stay deliberately LEAN:
   *  they never run heavy inference/compute, so the box's event loop cannot be saturated into a finality stall
   *  (the recurring incident). WORKER nodes (miners) use full hardware. `ZIRA_NODE_ROLE=consensus|worker`
   *  overrides; auto-detect makes founders/masters/gateway consensus and everyone else a worker. */
  nodeRole(): "consensus" | "worker" {
    const env = (process.env.ZIRA_NODE_ROLE || "").toLowerCase();
    if (env === "consensus" || env === "worker") return env;
    if (process.env.ZIRA_GATEWAY === "1" || this.isFounder() || this.state.isGenesisMaster(this.identity.address)) return "consensus";
    return "worker";
  }

  /** Start or restart the Tier 2 inference provider with the given config. */
  startProvider(config: ProviderConfig): void {
    // Anti-saturation: a consensus node (master/gateway) never serves heavy inference, so it stays lean and
    // the box can't be pinned into a finality stall. Heavy compute belongs on worker (miner) nodes.
    if (this.nodeRole() === "consensus") {
      log.info(`consensus-role node ${this.identity.address.slice(0, 10)} stays lean: inference serving disabled (heavy compute runs on worker nodes)`);
      this.opts.providerConfig = { ...config, enabled: false };
      return;
    }
    this.inferenceProvider?.stop();
    this.opts.providerConfig = config;
    this.inferenceProvider = new InferenceProvider(config, this, this.identity);
    this.inferenceProvider.start();
  }
  /** Stop serving inference. */
  stopProvider(): void {
    this.inferenceProvider?.stop();
    this.inferenceProvider = null;
    this.opts.providerConfig = { ...this.opts.providerConfig, enabled: false };
  }

  /** True when a Tier 2 endpoint provider is already answering for this identity. */
  endpointProviderReady(): boolean {
    return Boolean(this.inferenceProvider?.status().reachable);
  }

  // The events-airdrop already-claimed guard, persisted so a node restart cannot reset it and let every
  // address re-claim (which would drain the events reserve to its floor faster than intended).
  private eventsClaimedPath(): string { return join(this.dataDir, "claimed-events.json"); }
  private restoreEventsClaimed(): void {
    try { if (existsSync(this.eventsClaimedPath())) for (const a of JSON.parse(readFileSync(this.eventsClaimedPath(), "utf8")) as string[]) this.eventsClaimed.set(a, 1); } catch { /* best effort */ }
  }
  private persistEventsClaimed(): void {
    try { writeFileSync(this.eventsClaimedPath(), JSON.stringify([...this.eventsClaimed.keys()])); } catch { /* best effort */ }
  }

  private providerCfgPath(): string { return join(this.dataDir, "provider.json"); }
  private loadProviderConfig(): ProviderConfig | null {
    try { if (existsSync(this.providerCfgPath())) return { ...DEFAULT_PROVIDER_CONFIG, ...JSON.parse(readFileSync(this.providerCfgPath(), "utf8")) }; } catch { /* */ }
    return null;
  }
  private saveProviderConfig(): void {
    try { writeFileSync(this.providerCfgPath(), JSON.stringify(this.opts.providerConfig, null, 2)); } catch { /* */ }
  }

  /** Apply a patch from POST /rpc/status: update node/mining/provider settings, persist, (re)start serving. */
  async applyStatusPatch(patch: { nodeConfig?: Partial<{ observeEnabled: boolean }>; mining?: Partial<MiningConfig>; providerConfig?: Partial<ProviderConfig> }): Promise<void> {
    if (patch.nodeConfig && typeof patch.nodeConfig.observeEnabled === "boolean") {
      this.opts.observeEnabled = patch.nodeConfig.observeEnabled;
    }
    // Mining (mining.enabled: serve the field + earn) and "use my machine" (mining.ownTaskInference:
    // local inference for the user's OWN tasks only) are two INDEPENDENT switches. A patch sets only the
    // field(s) it carries, so toggling one never flips the other: own-task-only never serves/earns
    // (canServe() and the miner loop both require mining.enabled), and mining never runs the user's own
    // tasks (generateOwnTask/ownTaskEnabled require mining.ownTaskInference). Keep them decoupled here.
    if (patch.mining) await this.models.setMining(patch.mining);
    if (patch.providerConfig) {
      const next = { ...this.opts.providerConfig, ...patch.providerConfig };
      this.opts.providerConfig = next;
      this.saveProviderConfig();
      if (next.enabled) this.startProvider(next); else this.stopProvider();
    }
  }

  private detectingHardware: Promise<void> | null = null;
  /** Await an in-flight hardware detection (used by the RPC on first request). */
  async ensureHardware(): Promise<HardwareProfile | null> {
    if (this.detectingHardware) { await this.detectingHardware; this.detectingHardware = null; }
    if (!this.hardware) {
      try {
        this.hardware = await detectHardware();
        this.applyHardwareToMining(this.hardware);
      } catch { /* best effort */ }
    }
    return this.hardware;
  }

  /** Force a fresh hardware scan. Used by the Console when drivers wake up after app launch. */
  async refreshHardware(): Promise<HardwareProfile | null> {
    try {
      this.hardware = await detectHardware();
      this.applyHardwareToMining(this.hardware);
    } catch { /* best effort */ }
    return this.hardware;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.peerDialTimer) clearInterval(this.peerDialTimer);
    if (this.paymentWatchTimer) clearInterval(this.paymentWatchTimer);
    this.minerStop?.();
    this.inferenceProvider?.stop();
    this.persistSnapshot();
    await this.net.stop();
  }

  /** GET /rpc/status: the node + mining + provider view used by the Console Mine page. */
  async statusInfo(): Promise<{
    nodeConfig: { observeEnabled: boolean };
    providerConfig: ProviderConfig;
    providerStatus: { active: boolean; endpoint: string; reachable: boolean; queriesAnswered: number; earnedTodayUZIR: number };
    mining: MiningStatus;
    hardware: HardwareProfile | null;
    isFounder: boolean;
    founderAddresses: string[];
    address: string;
    balanceUZIR: number;
  }> {
    const hw = await this.ensureHardware();
    const ps = this.inferenceProvider?.status() ?? { active: false, endpoint: this.opts.providerConfig.endpoint, reachable: false, queriesAnswered: 0 };
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const since = startOfDay.getTime();
    let earnedTodayUZIR = 0;
    for (const e of this.state.recentHistory(this.identity.address, 1000)) {
      const launchMiningSettlement = e.kind === "transfer" && /launch mining settlement/i.test(e.memo ?? "");
      // recentHistory surfaces each pooled payout as a per-recipient row (to === us, amount === our slice), so
      // field-participation and coordination income counts toward "earned today" like direct rewards do.
      const isEarning = e.kind === "reward" || e.kind === "agent_spend" || e.kind === "pool_payout" || e.kind === "batch_transfer" || launchMiningSettlement;
      if (e.to === this.identity.address && isEarning && e.timestamp >= since) earnedTodayUZIR += e.amountUZIR;
    }
    return {
      nodeConfig: { observeEnabled: this.opts.observeEnabled },
      providerConfig: this.opts.providerConfig,
      providerStatus: { ...ps, earnedTodayUZIR },
      mining: await this.miningStatus(),
      hardware: hw,
      isFounder: this.isFounder(),
      founderAddresses: this.founderAddresses(),
      address: this.identity.address,
      balanceUZIR: this.myBalance(),
    };
  }

  /** Mining view: the single enable/disable switch most users ever touch, plus the field's models. */
  async miningStatus(): Promise<MiningStatus> {
    const s = await this.models.status();
    return {
      enabled: s.mining.enabled,
      mode: s.mining.mode,
      modelId: s.mining.modelId ?? null,
      endpoint: s.mining.endpoint,
      endpointModel: s.mining.endpointModel,
      gpuLayers: s.mining.gpuLayers,
      threads: s.mining.threads,
      useRecommendedHardware: s.mining.useRecommendedHardware ?? true,
      engineAvailable: s.engineAvailable,
      loadedModel: s.loadedModel,
      serving: s.serving,
      answerLabel: this.models.answerLabel(),
      recommendedModelId: this.models.recommendedModelId(),
      answered: this.minerAnswered,
      localTaskPermission: Boolean(s.mining.localTaskPermission),
      ownTaskInference: Boolean(s.mining.ownTaskInference),
      ownTaskReady: s.ownTaskReady,
      ownTaskLabel: s.ownTaskLabel,
      storageEnabled: Boolean(s.mining.storageEnabled),
      storageCapBytes: this.models.storageCapBytes(),
      storageLimitGb: s.mining.storageLimitGb ?? Math.max(1, Math.round(this.models.storageCapBytes() / 1024 ** 3)),
      storageUsedBytes: s.storageBytes,
      storageDownloadingBytes: s.storageDownloadingBytes,
      known: s.known,
    };
  }

  /** Flip mining on/off (and optionally set an advanced endpoint). Persists across restarts. */
  async setMining(patch: Partial<MiningConfig>): Promise<MiningStatus> {
    await this.models.setMining(patch);
    return this.miningStatus();
  }

  /** GET /storage: the user-controllable peer-to-peer storage state (soft infra, not ledger state). */
  storageState(): { enabled: boolean; capBytes: number; usedBytes: number } {
    return this.models.storageState();
  }

  /** POST /storage: toggle storage and/or set the byte cap. Persists across restarts; enforced immediately. */
  async setStorage(patch: { enabled?: boolean; capBytes?: number }): Promise<{ enabled: boolean; capBytes: number; usedBytes: number }> {
    return this.models.setStorage(patch);
  }

  /**
   * Own-task local inference: generate an answer for the USER'S OWN task on the user's own hardware
   * (native engine if a model is loaded locally, otherwise the configured local endpoint). This is the
   * "My tasks only" path. It is fully decoupled from mining: the field provider/answer loop is not
   * involved, nothing is published to the field, no one else is answered, and nothing is earned.
   */
  async generateOwnTask(messages: { role: "user" | "assistant"; content: string }[], system: string): Promise<string> {
    return this.models.generateOwnTask(messages, system);
  }
  /** Whether own-task local inference can answer right now (engine loaded or endpoint set). */
  ownTaskReady(): Promise<boolean> { return this.models.ownTaskReady(); }

  /** Live, decentralized prices every node computes the same way from observed network state. */
  pricing(): { queryUZIR: number; taskBaseUZIR: number; resonatorCreationUZIR: number; resonatorCreationOpen: boolean; openQueries: number; providersOnline: number } {
    const now = Date.now();
    const providersOnline = this.soft.onlineProviders(now).length;
    const openQueries = this.soft.openQueries([], now).length;
    return {
      queryUZIR: adaptiveQueryPriceUZIR({ openQueries, providersOnline }),
      taskBaseUZIR: adaptiveTaskPriceUZIR({ openQueries, providersOnline }),
      // Cost to create (fund) a new Resonator, surfaced so the Console shows the same canonical floor.
      resonatorCreationUZIR: PROTOCOL.RESONATOR_CREATION_COST_UZIR,
      // Whether creating a new Resonator is currently accepted (Case B freeze reflects to the UI so the
      // create action can be disabled with a reason instead of failing on publish).
      resonatorCreationOpen: !this.resonatorCreationFrozen(),
      openQueries,
      providersOnline,
    };
  }

  /** Use detected hardware to size mining defaults (advisory): GPU layers and CPU threads. */
  private applyHardwareToMining(h: HardwareProfile): void {
    try {
      const mining = this.models.currentMining();
      if (mining.useRecommendedHardware === false) return;
      const patch: Partial<MiningConfig> = {};
      if (h.recommendedGpuLayers && h.recommendedGpuLayers > 0) patch.gpuLayers = h.recommendedGpuLayers;
      if (h.recommendedThreads && h.recommendedThreads > 0) patch.threads = h.recommendedThreads;
      if (Object.keys(patch).length) void this.models.setMining({ ...patch, useRecommendedHardware: true });
    } catch { /* advisory only */ }
  }

  // ---- the clock ----

  private regossipEvery = 0;
  private unfinalizedRegossipEvery = 0;
  // Hard ceiling on how many unfinalized txs are re-broadcast per pass, so a deep finality freeze (huge
  // unfinalized window) can never turn the re-gossip into a CPU-saturating flood on a co-located master box.
  private static readonly REGOSSIP_UNFINALIZED_MAX = 150;

  private tick(): void {
    const now = Date.now();
    const advanced = this.state.advance(now);
    if (advanced > 0) this.voteCheckpoints(now);
    this.maybeResyncOnStall(now);   // finality watchdog: self-heal if finalizedEpoch freezes behind the mesh
    this.maybeResyncOnDivergence(now); // state watchdog: self-heal if our applied state stops matching consensus
    this.soft.prune(now);
    // periodically re-gossip pending events so peers converge despite gossipsub mesh races and
    // late joiners. Cheap: the pool is small and drains every epoch.
    this.regossipEvery = (this.regossipEvery + 1) % 4;
    if (this.regossipEvery === 0) {
      const pool = this.state.poolEvents(200);
      for (const tx of pool.txs) this.publish(this.topics.events, { t: "tx", data: tx });
      for (const o of pool.observations) this.publish(this.topics.events, { t: "observation", data: o });
      // Backfill: also re-broadcast recently-APPLIED txs, not only pooled ones. Once a tx is applied it leaves
      // the pool, so a master that missed it during its brief pool lifetime would otherwise never receive it and
      // would sit behind a permanent nonce gap (every later tx from that sender is then dropped), diverging its
      // state root and stalling quorum finality. Re-gossiping the recent applied window lets a lagging master
      // fill the gap and converge. Idempotent: a node that already has a tx de-dupes it by id, and the wide
      // settle window (SETTLE_ROUNDS) gives these backfills time to land before their epoch finalizes anywhere.
      for (const tx of this.state.recentHistory(null, 150)) this.publish(this.topics.events, { t: "tx", data: tx });
      // Re-gossip recent UNFINALIZED votes so a vote lost to a gossipsub mesh race still reaches quorum. Each
      // epoch's vote is cast exactly once (voteCheckpoints), so without this a single lost vote permanently
      // splits that epoch's votes and freezes finality — no master ever re-sends, so the split never heals.
      // This was the 2026-07-11 box1 freeze: masters diverged/lost votes on an epoch and never re-converged.
      // Signed + de-duped by isVoteKnown; consensus-neutral (only re-sends existing votes, never a new root).
      for (const vote of this.checkpoints.recentUnfinalizedVotes(200)) this.publish(this.topics.consensus, { t: "checkpoint", data: vote });
      // Re-gossip the latest finalized checkpoint so followers converge finality even when the
      // one-shot vote at finalization time lost a gossipsub mesh race (common on a fresh single-peer
      // join). Without this a late joiner advances its currentEpoch by wall clock but its
      // finalizedEpoch freezes at the fast-sync point, so the Console renders stale anchors/supply
      // and never shows the live model field. The vote carries master signatures and is de-duped by
      // isVoteKnown on the receiver, so re-broadcasting is idempotent and trustless.
      const finEpoch = this.checkpoints.lastFinalizedEpoch;
      if (finEpoch >= 0) {
        const votes = this.checkpoints.finalizingVotes(finEpoch, this.checkpoints.lastFinalizedRoot);
        for (const vote of votes) this.publish(this.topics.consensus, { t: "checkpoint", data: vote });
      }
      // Re-gossip pending field queries. publishQuery broadcasts a query only ONCE; if that single
      // gossipsub publish loses a mesh race, no serving miner ever hears it and the Console silently
      // gets no answer (intermittent "not answering" even when providers are online). Re-broadcasting
      // open queries within their TTL gives every live provider a reliable chance to pick them up.
      // Soft-state, consensus-neutral, idempotent (peers de-dupe by query id; providers skip answered).
      for (const q of this.soft.openQueries([], Date.now()).slice(0, 30)) this.publish(this.topics.app, { t: "query", data: q });
    }
    // FINALITY DETERMINISM FIX (2026-07-10 hard-wedge at 356724426): re-broadcast the txs in the UNFINALIZED
    // window (committedEpoch > lastFinalizedEpoch). A tx that reaches some masters later than the settle window
    // makes them vote that epoch a DIFFERENT root; the finality vote then splits with no re-vote
    // (voteCheckpoints votes each epoch once), so the split is permanent. Re-gossiping unfinalized txs lets a
    // lagging master fill the gap. Idempotent (peers de-dupe by id), soft-state, fork-safe.
    // CPU GUARD (2026-07-11 box1 crush): when finality is FROZEN, the unfinalized window balloons and
    // re-broadcasting all of it every single tick pegs the co-located masters' event loops, which is the very
    // thing that stops them processing the votes that would unfreeze finality — a self-reinforcing crush. So
    // this now runs every 3rd tick and is BOUNDED to REGOSSIP_UNFINALIZED_MAX txs (newest first). Convergence is
    // slightly slower under a deep freeze but the loop can never saturate the CPU, so the masters stay
    // responsive enough to finalize their way out of it.
    this.unfinalizedRegossipEvery = (this.unfinalizedRegossipEvery + 1) % 3;
    if (this.unfinalizedRegossipEvery === 0) {
      const finE = this.checkpoints.lastFinalizedEpoch;
      let sent = 0;
      for (const tx of this.state.recentHistory(null, 800)) {
        if ((tx.committedEpoch ?? 0) > finE) {
          this.publish(this.topics.events, { t: "tx", data: tx });
          if (++sent >= ZiraNode.REGOSSIP_UNFINALIZED_MAX) break;
        }
      }
    }
    // any mining node: keep the built-in engine running the authorized field model (auto mode). Re-announce
    // and reconcile every ~5s so a freshly-serving miner is discovered (and storage-credited) quickly.
    this.autoEvery = (this.autoEvery + 1) % 5;
    if (this.autoEvery === 0) {
      this.models.announceLocal(); this.models.reannounceField(); void this.models.reconcileAuto(); void this.models.reconcileStorage();
      // Keep anchor Resonators in lockstep with their positions: re-materialize (re-key) any whose
      // position has changed owner since last tick. Runs on every node, no steward key required.
      this.materializeAnchorResonators();
      // On the steward node, also re-publish steward-signed records for peers on older code. No-op otherwise.
      this.seedAnchorResonators();
    }
    // task reaper: expire undelivered tasks, auto-release silently-verified ones.
    if (now - this.lastReapAt >= this.opts.taskReapMs) {
      this.lastReapAt = now; this.reapTasks(now);
      // Skip ALL settler payout/coordination/filler issuance while paused (ops recovery: pure-emission-only
      // advancement walks a diverged fleet past a stuck fork). Reaping tasks above is safe (no balance txs).
      if (!this.settlerPaused) { this.coordinateAutonomousResonance(now); this.settleRealUserCoordination(now); this.settleFieldParticipation(now); this.unstickSettlerNonce(now); }
    }
    // Field heartbeat: contributing (mining/storage) nodes attest participation so PoR Locks form and the
    // round emission flows to them (storage-weighted). Self-throttled to FIELD_HEARTBEAT_INTERVAL_MS.
    this.contributeFieldHeartbeat(now);
    void this.contributePushLiveness(now);   // push liveness to masters over our own connection (NAT-proof vouch)
    // Storage proof: a master that holds the model periodically probes peers serving it and attests the ones
    // that prove they hold the bytes (a random-chunk probe), so genuine storage/serving miners earn the
    // heartbeat emission, not only paid coordination.
    this.storageProbeEvery = (this.storageProbeEvery + 1) % 20;     // ~ every 20s
    if (this.storageProbeEvery === 0) void this.runStorageProbe();
    // anchor vesting: release any class-allocation that has linearly accrued to seat owners since the
    // last tick. No-op on nodes without the reserve key, and when nothing new has vested.
    this.releaseAnchorVesting(now);
    // roll a ZTI snapshot for active identities so the Console can draw history.
    this.ztiSnapEvery = (this.ztiSnapEvery + 1) % 12;
    if (this.ztiSnapEvery === 0) this.snapshotZti();
    this.snapshotEvery = (this.snapshotEvery + 1) % 30;
    if (this.snapshotEvery === 0) this.persistSnapshot();
  }
  private autoEvery = 0;
  private ztiSnapEvery = 0;
  private storageProbeEvery = 0;
  private storageProbeBusy = false;

  /**
   * Storage-proof attestation. Runs on a MASTER that holds the model: it probes each peer serving that model
   * for a random chunk and verifies the bytes against its own copy. Peers that pass demonstrably hold the
   * model (a real storage cost), so the master attests them on-ledger with a storage_attest tx, which credits
   * their verifiable work and makes the heartbeat emission earnable by genuine storage/serving miners. Only a
   * master's attestation is honored by consensus; the attest tx gossips so every node credits the same miners.
   */
  // Miners this master has verified (random-chunk probe) hold + serve the model, with the wall-clock ms of
  // the last successful probe. A master VOUCHES for the fresh ones inside its signed heartbeat observation;
  // runField credits any miner vouched by enough masters in the converged Lock. No ledger tx is created, so
  // this is consensus-safe (the credit derives from converged observations, not divergent per-master txs).
  private verifiedMiners = new Map<string, number>();
  // Push-vouched miners (this master only): peerId -> {address it asserted, when}. A miner pushes a signed
  // liveness assertion over its own outbound connection; keying by peerId bounds it to one address per live
  // connection (the same sybil property as the reverse probe) and lets a NAT'd miner stay vouched even when
  // the master cannot probe it back. Consumed by freshVouchedMiners while the connection is still live.
  private pushVouch = new Map<string, { address: string; ts: number }>();
  // Which vouched miners passed the STORAGE chunk challenge this window (address -> last-verified ms). A
  // subset of verifiedMiners; used to give storage-servers the payout bonus. Settler-local, consensus-safe.
  private storageServingMiners = new Map<string, number>();
  // Recency-weighted count of accepted coordination answers the settler has settled per miner (address ->
  // credits). Grows in settleAutonomousCoordination, decays once per paid cycle, persisted in
  // settler-progress.json so weighting is restart-stable. Feeds the "answers more -> earns more" weight.
  private minerAnswerCredits = new Map<string, number>();
  // Vouch a peer for a full cycle after a successful probe. This must be >= the participation cycle
  // (AUTONOMOUS_RESONANCE_CYCLE_MS) so a peer probed anywhere in a cycle is still fresh when the settler pays
  // at the cycle boundary; otherwise a continuously-connected miner probed early in the cycle would silently
  // fall out of the payout. A disconnected peer stops being re-probed and ages out within one cycle.
  private static VOUCH_FRESH_MS = 300_000;

  private async runStorageProbe(): Promise<void> {
    if (this.storageProbeBusy) return;
    const me = this.state.accounts.get(this.identity.address);
    if (!(this.state.isGenesisMaster(this.identity.address) || (me?.isMaster ?? false))) return;  // only masters vouch
    this.storageProbeBusy = true;
    try {
      const now = Date.now();
      let live = 0, stored = 0;
      // 1) COORDINATION baseline. Any directly-connected peer that answers a fresh liveness challenge is a
      //    real, reachable, participating node. Mining/coordination alone earns the baseline emission (no
      //    model download required), so a new user starts earning the moment they are a live peer of the
      //    field. Bounded per round; each probe is timeout-guarded so a stalled peer never blocks the set.
      // Probe connected peers with BOUNDED CONCURRENCY. A purely sequential walk (the prior approach) let a
      // handful of slow/dead peers each burn the full 8s request timeout, so on a busy public master the loop
      // ran for minutes and real, synced mining nodes late in the list were never probed, never vouched, never
      // paid — bare mining looked like it earned nothing. An UNBOUNDED concurrent burst (the approach before
      // that) opened too many liveness streams at once and starved the connection. A small fixed pool is the
      // stable middle: every connected miner gets probed each round in seconds, so mining alone earns the
      // baseline the moment a node is a live peer (no model bytes required). Consensus-safe: it only changes
      // which miners this master vouches for, which rides on its SIGNED observation / settled payout tx and is
      // applied byte-identically by every node (old builds included).
      const probeCap = Number(process.env.ZIRA_VOUCH_PROBE_CAP ?? 128);
      const probeConc = Math.max(1, Number(process.env.ZIRA_VOUCH_PROBE_CONCURRENCY ?? 8));
      const livePeers = this.net.peers().slice(0, probeCap);
      let li = 0, liveFail = 0;
      const liveWorker = async (): Promise<void> => {
        while (li < livePeers.length) {
          const peerId = livePeers[li++]!;
          const addr = await this.verifyPeerLive(peerId);
          if (addr && addr !== this.identity.address) { this.verifiedMiners.set(addr, now); live++; }
          else if (!addr) liveFail++;
        }
      };
      await Promise.all(Array.from({ length: Math.min(probeConc, livePeers.length) }, () => liveWorker()));
      // 2) STORAGE serving (earns MORE via storageRewardMultiplier). Peers advertising the model that pass a
      //    random-chunk challenge prove they actually hold+serve the bytes. Same freshness stamp; the extra
      //    reward comes from their storage weight in the split. Only when we hold a model to probe against.
      const modelId = this.models.localHeldModelId();
      if (modelId) {
        const servers = this.models.peersServing(modelId).slice(0, probeCap);
        let si = 0;
        const storeWorker = async (): Promise<void> => {
          while (si < servers.length) {
            const { peerId, address } = servers[si++]!;
            try { if (await this.models.verifyPeerStorage(peerId, modelId)) { this.verifiedMiners.set(address, now); this.storageServingMiners.set(address, now); stored++; } }
            catch { /* unreachable peer: skip */ }
          }
        };
        await Promise.all(Array.from({ length: Math.min(probeConc, servers.length) }, () => storeWorker()));
      }
      // prune stale entries so the vouch set stays current and bounded
      for (const [a, ts] of this.verifiedMiners) if (now - ts > ZiraNode.VOUCH_FRESH_MS) this.verifiedMiners.delete(a);
      for (const [a, ts] of this.storageServingMiners) if (now - ts > ZiraNode.VOUCH_FRESH_MS) this.storageServingMiners.delete(a);
      if (live > 0 || stored > 0 || liveFail > 0 || this.pushVouch.size > 0) log.info(`vouch probe: ${livePeers.length} peers, ${live} live, ${liveFail} unreachable, ${stored} storage-serving, ${this.pushVouch.size} push-vouched -> vouching ${this.freshVouchedMiners(now).length} in heartbeat`);
    } finally {
      this.storageProbeBusy = false;
    }
  }

  /** The miners this master currently vouches for (verified within the freshness window), for the heartbeat. */
  private freshVouchedMiners(now: number): string[] {
    const out: string[] = [];
    for (const [a, ts] of this.verifiedMiners) if (now - ts <= ZiraNode.VOUCH_FRESH_MS) out.push(a);
    // Push-vouched miners: honour a fresh signed push for its full freshness window, regardless of whether the
    // connection happens to be up at THIS instant — that is the whole point, because a churning NAT'd link is
    // rarely up at the exact payout tick. Keying by peerId already caps this at one address per connection (the
    // node must have pushed over a real connection within the last PUSH_LIVENESS_MAX_AGE_MS, and must keep
    // reconnecting to re-push), so there is no extra sybil surface beyond the reverse probe. Prune only on age.
    for (const [peerId, v] of this.pushVouch) {
      if (now - v.ts > PUSH_LIVENESS_MAX_AGE_MS) { this.pushVouch.delete(peerId); continue; }
      out.push(v.address);
    }
    return [...new Set(out)];
  }

  /**
   * The field-pool weight for one vouched miner: a baseline every live node earns, plus a bonus for serving
   * storage (chunk-challenge verified), plus its recent coordination-answer contribution, plus its on-ledger
   * ZTI, clamped to a ceiling so no single miner can take the whole pool. All inputs are settler-observed and
   * verifiable, so the weighting is deterministic on the settler and rides its one signed batch_transfer.
   * "Better hardware earns more" falls out naturally: a stronger machine serves storage and wins more
   * answers, so it accrues a higher weight.
   */
  private fieldPayoutWeight(addr: string, now: number): number {
    let w = FIELD_WEIGHT_BASE;
    const st = this.storageServingMiners.get(addr);
    if (st !== undefined && now - st <= ZiraNode.VOUCH_FRESH_MS) {
      // Verified storage server: a flat bonus plus more for serving more bytes (gated by the passed challenge).
      w += FIELD_WEIGHT_STORAGE_BONUS;
      const gib = this.state.minerStorageGiB(addr, now, ZiraNode.VOUCH_FRESH_MS);
      w += Math.min(FIELD_WEIGHT_STORAGE_GIB_CAP, gib * FIELD_WEIGHT_STORAGE_GIB_UNIT);
    }
    w += Math.min(FIELD_WEIGHT_ANSWER_CAP, (this.minerAnswerCredits.get(addr) ?? 0) * FIELD_WEIGHT_ANSWER_UNIT);
    const zti = this.state.accounts.get(addr)?.zti ?? 0;
    w += Math.min(FIELD_WEIGHT_ZTI_CAP, Math.max(0, zti));
    return Math.max(FIELD_WEIGHT_BASE, Math.min(FIELD_WEIGHT_CEILING, w));
  }
  private lastAutonomousResonanceBucket = -1;
  private lastParticipationBucket = -1;
  private lastParticipationDeferLog = -1;
  private loggedSettlerGate = false;
  private lastHeartbeatBucket = -1;
  /** The reward a single driven resonator's owner earns per cycle (fixed pool, funded from the settler's base
   *  emission). Used for BOTH the owner payment and the task's displayed totalEarned, so they match. */
  private cycleResonatorReward(_now: number): number {
    return AUTONOMOUS_RESONANCE_TASK_UZIR;
  }

  /**
   * Field participation payout. Once per cycle the network settler splits a fixed mining pool among the miners
   * it has VERIFIED are genuinely participating (freshVouchedMiners: a live, reachable coordinating peer, or a
   * storage-serving peer that passed a chunk challenge). This is what makes turning mining ON actually earn: a
   * real, connected, contributing node is paid for taking part even when it does not win a coordination answer.
   * Funded from the settler's base emission as ordinary transfers. One settler funds it, so the txs are a single
   * deterministic set and finality never diverges. Genesis masters and the settler itself are excluded.
   */
  private settleFieldParticipation(now: number): void {
    // One-time observability at first invocation: which gate applies. A silent early return here once hid a
    // paused payout pipeline for a whole evening — never let this function go quiet without saying why.
    if (!this.loggedSettlerGate) {
      this.loggedSettlerGate = true;
      const masters0 = (this.genesis.masters ?? [])[0]?.address ?? this.genesis.founder;
      log.info(`field participation gate: budget=${FIELD_PARTICIPATION_BUDGET_UZIR} settler=${masters0.slice(0, 20)} me=${this.identity.address.slice(0, 20)} isSettler=${this.isNetworkSettler()}`);
    }
    if (FIELD_PARTICIPATION_BUDGET_UZIR <= 0) return;
    // Superseded by the pure-epoch distribution (State.distributeFieldParticipation) once it activates: that path
    // credits miners deterministically in processEpoch with NO gossiped tx, so this classic gossiped batch_transfer
    // must stand down or the bucket would be paid twice.
    if (this.state.fieldPayoutPureActiveNow()) return;
    // Decentralization cutover: when active, the payout is funded from the POOL via pool_payout and ANY
    // authorized settler (genesis master OR sealed validator) may issue it, so miners keep earning when box1
    // is down. While dormant, the classic path applies: only the active genesis-master settler pays, from its
    // own balance, via batch_transfer.
    const cutover = this.state.decentralizationActiveNow();
    if (cutover ? !this.shouldIssuePoolPayout() : !this.isNetworkSettler()) return;
    const bucket = Math.floor(now / AUTONOMOUS_RESONANCE_CYCLE_MS);
    // Watermark (<=), not equality: once a bucket is paid, NEVER pay it (or any earlier bucket) again — even
    // across a restart, where lastParticipationBucket is restored from disk. Buckets are monotonic wall-clock
    // time, so this only skips already-settled work. This is the guard that stops a restarted settler from
    // re-paying a bucket with a different live-peer payee set (the 2026-07-04 finality freeze).
    if (bucket <= this.lastParticipationBucket) return;
    const pool = FIELD_PARTICIPATION_BUDGET_UZIR;
    // Pay the UNION of miners vouched by ANY master (from their gossiped heartbeats), not just the settler's
    // own directly-connected peers. Earning must not hinge on which master a miner happens to connect to, nor
    // collapse if the settler briefly loses peers (e.g. after a restart) while node2/3/4 still hold the mesh.
    // Consensus-safe: this is the settler's own payee choice for its signed batch payout, applied identically
    // by every node. Genesis masters and the settler itself are excluded.
    const payees = [...new Set([...this.freshVouchedMiners(now), ...this.state.aggregateVouchedMiners(now, ZiraNode.VOUCH_FRESH_MS)])]
      .filter((a) => /^zir1[0-9a-z]{6,}$/.test(a) && a !== this.identity.address && !this.state.isGenesisMaster(a))
      .sort()
      .slice(0, FIELD_PARTICIPATION_MAX_PAYEES);
    // Deferred paths below must NOT consume the payment bucket: if there are no payees yet or the settler is
    // briefly underfunded early in a cycle, we want to retry on a later tick and still pay once conditions are
    // met. We only throttle the diagnostic log to once per cycle via a separate marker.
    if (payees.length === 0) {
      if (this.lastParticipationDeferLog !== bucket) { this.lastParticipationDeferLog = bucket; log.info("field participation: no fresh vouched miners this cycle yet (0 payees)"); }
      return;
    }
    if (Math.floor(pool / payees.length) <= 0) return;
    // ONE batched tx covers the whole pool plus a single base fee (not one fee per payee). Paying every miner
    // in a single transaction is the fix for the fork: N separate transfers meant one dropped packet opened a
    // nonce gap that dropped every later settler tx on that node, so honest nodes diverged and finality
    // stalled. A single tx has a single nonce, so there is no gap to cascade.
    const needed = pool + PROTOCOL.BASE_FEE_UZIR;
    // The FUNDER is the emission pool when the cutover is active (pool_payout debits the pool, not the issuer),
    // else the settler's own balance (batch_transfer). Use the PROVISIONAL balance (nets txs already pooled
    // this tick: resonator rewards + coordination payouts run before this in the same reap). Checking committed
    // balanceOf let the funder pool more than it could afford; at apply time the tx would then drop for
    // overspend WITHOUT consuming its nonce, yet the bucket watermark had already advanced, so that cycle's
    // miners were never paid and never retried. Gating on the funder's provisionalBalance defers (does not
    // submit, does not advance the watermark) so it retries next tick.
    const funder = cutover ? this.state.poolAddress() : this.identity.address;
    if (this.state.provisionalBalance(funder) < needed) {
      if (this.lastParticipationDeferLog !== bucket) { this.lastParticipationDeferLog = bucket; log.warn(`field participation deferred: funder provisional balance ${this.state.provisionalBalance(funder)} < needed ${needed} (base emission still accruing)`); }
      return; // not enough base emission accrued yet; retry on a later tick this cycle
    }
    // WEIGHTED split (v2.0.2): each payee's share is proportional to the verifiable work the settler observed
    // for it (storage-serving bonus + recent coordination answers + on-ledger ZTI), so a stronger machine
    // earns more while a bare live node keeps a baseline. Deterministic on the settler; the resulting outputs
    // ride the SAME single signed batch_transfer and are applied byte-identically by every node (fork-safe).
    const weights = payees.map((a) => this.fieldPayoutWeight(a, now));
    // Deterministic largest-remainder split so the outputs sum EXACTLY to `pool` (see payout-split.ts).
    const outputs = weightedOutputs(payees, weights, pool);
    // Recency-decay the answer credits once per paid cycle so recent work dominates and stale credits fade.
    for (const [a, c] of this.minerAnswerCredits) { const nc = c * FIELD_ANSWER_DECAY; if (nc < 0.05) this.minerAnswerCredits.delete(a); else this.minerAnswerCredits.set(a, nc); }
    // Active: pool_payout (funded by the pool, `to` names the pool, memo carries the idempotency bucket) so any
    // authorized settler can pay and double-pay is impossible. Dormant: the classic self-funded batch_transfer.
    const tx = cutover
      ? signTx({
          network: this.genesis.network, from: this.identity.address, fromPubKey: this.identity.publicKey,
          to: this.state.poolAddress(), amountUZIR: pool, feeUZIR: PROTOCOL.BASE_FEE_UZIR,
          nonce: this.state.provisionalNonce(this.identity.address), kind: "pool_payout",
          parents: [], timestamp: now, memo: JSON.stringify({ b: bucket, o: outputs }),
        }, this.identity.privateKey)
      : signTx({
          network: this.genesis.network, from: this.identity.address, fromPubKey: this.identity.publicKey,
          to: this.identity.address, amountUZIR: pool, feeUZIR: PROTOCOL.BASE_FEE_UZIR,
          nonce: this.state.provisionalNonce(this.identity.address), kind: "batch_transfer",
          parents: [], timestamp: now, memo: JSON.stringify({ o: outputs }),
        }, this.identity.privateKey);
    const res = this.submitTx(tx);
    if (res.accepted) {
      this.lastParticipationBucket = bucket;
      this.persistSettlerProgress(); // survive restart: never re-pay this bucket with a different payee set
      const hi = Math.max(...outputs.map(([, v]) => v)), lo = Math.min(...outputs.map(([, v]) => v));
      log.info(`field participation payout: ${payees.length} miner(s), weighted ${lo}..${hi} uZIR in ONE batch (bucket ${bucket})`);
    } else if (this.lastParticipationDeferLog !== bucket) {
      // A rejected payout would otherwise retry silently forever — surface WHY so it can be fixed.
      this.lastParticipationDeferLog = bucket;
      log.warn(`field participation payout REJECTED (${payees.length} payees, bucket ${bucket}): ${res.reason ?? "no reason"}`);
    }
  }

  private settlerNonceMark = -1;
  private settlerNonceMarkAt = 0;
  private lastNonceUnstickAt = 0;
  /**
   * Settler-nonce watchdog. The settler builds each payout at provisionalNonce = committed + (its pooled txs).
   * If a tx at the committed nonce is dropped and never re-filled (e.g. it was deleted on an old build, or a
   * predecessor was lost), every later payout the settler issues lands at a FUTURE nonce (a gap) and can never
   * apply — the committed nonce is empty, so nothing advances it, and the pipeline is wedged forever with NO tx
   * sitting at the committed nonce for the settle-drain to skip. This is the "pure gap" variant of the
   * 2026-07-05 payout freeze. Recovery must come from the settler itself (the single authority on its payouts):
   * when its committed nonce has been stuck for SETTLER_NONCE_STUCK_MS while later payouts have piled up above
   * it, re-issue a minimal payout at EXACTLY the committed nonce. That is a normal signed tx — it gossips and
   * applies byte-identically on every node (no consensus rule change, fork-safe) — so it fills the hole, the
   * nonce advances, and the queued payouts drain in order. Idempotent and self-throttled.
   */
  private unstickSettlerNonce(_now: number): void {
    // SUPERSEDED and DISABLED — inert shim. This reactive filler was the 2026-07-10 fork source: it minted a
    // signed tx at the empty committed nonce whose timestamp varied per issuing node and per restart, so
    // masters applied different fillers at the same nonce and forked the head root, a divergence no realign
    // could reconcile. A pure-epoch gap-close in State.processEpoch now advances a settle-lagged stuck nonce
    // deterministically with NO gossiped tx, so there is nothing to diverge on. The method (and its persisted
    // stuckFiller bookkeeping) is retained only so restored settler-progress and the tick caller stay valid;
    // it must never issue a tx again.
  }

  /**
   * Field heartbeat (the network-liveness beacon). A contributing node — a genesis master, or any node that
   * is mining OR serving storage — periodically submits a signed observation attesting that the field is
   * operational and it is participating, carrying its served-storage size and (for masters) the miners it has
   * verified. When >= MIN_OBSERVATIONS contributors converge, the PoR field seals the heartbeat Lock. Base
   * per-epoch emission is credited to the fixed genesis-master set on epochs where a Lock seals (see
   * State.runField): it is deliberately NOT split among the live-observed contributors, because that made
   * emission depend on gossip propagation and diverged the state root across masters, stalling quorum
   * finality. Miners and resonators earn from coordination settlement and tasks (real paid work), never from
   * base emission. The steward/founder never beacons. Mints nothing beyond the emission curve.
   */
  private contributeFieldHeartbeat(now: number): void {
    if (this.isFounder()) return;                                   // the launch authority does not farm emission
    // Genesis masters are the base infrastructure: they ALWAYS beacon, independent of any mining/storage flag,
    // so the heartbeat Lock reliably seals every epoch. Base per-epoch emission is credited to the fixed
    // master set only on epochs where that Lock seals, and finality liveness rests on the masters converging,
    // so a master must never fall silent just because its MINE flag is off. A regular (non-master) node still
    // contributes the heartbeat only when it is mining OR serving storage.
    const isMaster = this.state.isGenesisMaster(this.identity.address);
    if (!isMaster && !this.models.miningEnabled() && !this.models.storageState().enabled) return;
    const bucket = Math.floor(now / FIELD_HEARTBEAT_INTERVAL_MS);
    if (bucket === this.lastHeartbeatBucket) return;                // one heartbeat per interval
    if (this.lastHeartbeatBucket === -1) {
      log.info(`mining/storage active -> contributing field heartbeats; earns PoR emission once >= ${PROTOCOL.MIN_OBSERVATIONS} contributors converge (you + peers). Stay connected to the field.`);
    }
    this.lastHeartbeatBucket = bucket;
    const storageGiB = Math.round((this.models.storageUsedBytes() / 1024 ** 3) * 100) / 100;
    // A genesis master vouches (in this signed heartbeat) for the miners it has verified hold + serve the
    // model. runField credits any miner vouched by >= MIN_STORAGE_VOUCHERS masters in the converged Lock,
    // unlocking its heartbeat emission — deterministically, with no per-master ledger tx.
    const vouchedMiners = this.state.isGenesisMaster(this.identity.address) ? this.freshVouchedMiners(now) : undefined;
    const body = buildObservationBody({
      type: "value", observer: this.identity.publicKey, timestamp: now,
      subject: FIELD_HEARTBEAT_SUBJECT, domain: "data", confidence: 0.9,
      sourceHashes: ["field-heartbeat"], value: 1, storageGiB, vouchedMiners,
    });
    const c = canonical(body);
    this.submitObservation({ ...body, id: hashHex(c), sig: edSign(c, this.identity.privateKey) });
  }

  /** Record current ZTI per domain for accounts with trust, capped for cost. */
  private snapshotZti(): void {
    const epoch = this.state.lastProcessedEpoch;
    let n = 0;
    for (const a of this.state.accounts.values()) {
      if (a.zti <= 0 || !a.address) continue;
      for (const [domain, zti] of Object.entries(a.ztiByDomain)) {
        this.store.appendZtiSnapshot(a.address, domain as Domain, zti as number, epoch);
      }
      if (++n >= 200) break;
    }
  }

  /** Drive task lifecycle fallbacks. Undelivered past expiry refunds; delivered-but-silent releases. */
  reapTasks(now: number): void {
    for (const task of this.soft.listTasks()) {
      if (task.status === "assigned" && this.canAutonomouslyDeliverTask(task, now)) {
        this.publishTask({
          ...task,
          status: "delivered",
          deliveredAt: now,
          resultRef: hashHex(`autonomous-resonator:${task.id}:${task.resonatorId}:${task.brief}`),
        });
      } else if (task.status === "assigned" && task.expiresAt && now > task.expiresAt) {
        this.publishTask({ ...task, status: "refunded", resolvedAt: now });
      } else if (task.status === "delivered" && task.deliveredAt && now > task.deliveredAt + TASK_VERIFY_TIMEOUT_MS) {
        this.publishTask({ ...task, status: "released", resolvedAt: now });
      }
    }
  }

  private canAutonomouslyDeliverTask(task: Task, now: number): boolean {
    const resonator = this.soft.resonators.get(task.resonatorId);
    if (!resonator || !resonator.resonanceEnabled || resonator.status === "paused") return false;
    if ((resonator.balanceUZIR ?? 0) <= 0) return false;
    if (task.expiresAt && now > task.expiresAt) return false;
    const assignedAt = task.assignedAt ?? task.createdAt;
    return now - assignedAt >= AUTONOMOUS_RESONATOR_DELIVER_MS;
  }

  /**
   * Autonomous resonance lets mining feed the agent layer without waiting for a human marketplace
   * hire. The field asks model-backed providers to converge on each funded Resonator's next useful
   * coordination step. When at least two independent providers answer, the node records a zero-budget
   * released task. That grows Resonator ZTI through verified AI-to-AI convergence, but does not invent
   * ZIR earnings because no ledger payment happened.
   */
  coordinateAutonomousResonance(now = Date.now()): { queries: number; released: number } {
    const bucket = Math.floor(now / AUTONOMOUS_RESONANCE_CYCLE_MS);
    const eligible = this.autonomousResonanceEligible();
    if (eligible.length === 0) return { queries: 0, released: 0 };

    // Only a FUNDING node drives autonomous coordination: the founder/steward (drives every resonator) or
    // a genesis master (drives its own shard, paying from the emission it earns). A plain miner does not
    // drive — it EARNS by answering these queries. This is what lets miners earn coordination pay on a
    // keyless network with no steward online.
    const mine = this.autonomousResonanceDriven(eligible);
    if (mine.length === 0) return { queries: 0, released: 0 };

    let queries = 0;
    if (this.lastAutonomousResonanceBucket !== bucket) {
      this.lastAutonomousResonanceBucket = bucket;
      for (const resonator of this.autonomousResonanceBatch(mine, bucket)) {
        const query = this.autonomousResonanceQuery(resonator, bucket, now);
        if (!this.soft.queries.has(query.id)) { this.publishQuery(query); queries++; }
      }
      if (queries > 0) log.info(`autonomous coordination: published ${queries} resonance ${queries === 1 ? "query" : "queries"} this cycle (driving ${mine.length} of ${eligible.length} eligible resonators)`);
    }

    // Tasks carry the resonator reward budget, so ONLY the settler publishes + settles them: one deterministic
    // funder means the reward amount (and every resonator's displayed totalEarned, credited from the gossiped
    // task) is identical on every node. Non-settler masters only publish queries above (idempotent, free).
    let released = 0;
    if (!this.isNetworkSettler()) return { queries, released };
    for (const settleBucket of [bucket, bucket - 1]) {
      if (settleBucket < 0) continue;
      const bucketStart = settleBucket * AUTONOMOUS_RESONANCE_CYCLE_MS;
      if (now < bucketStart + AUTONOMOUS_RESONANCE_SETTLE_MS) continue;
      for (const resonator of this.autonomousResonanceBatch(mine, settleBucket)) {
        const task = this.autonomousResonanceTask(resonator, settleBucket, now);
        if (task && this.publishTask(task)) released++;
        // Pay the resonator's OWNER for this cycle of autonomous work (real ZIR from the settler's base
        // emission). The gossiped task grows the resonator's displayed totalEarned by the same amount, so the
        // owner's balance and the resonator's earnings stay in step. Settler-only, once per (resonator,bucket).
        this.payResonatorReward(resonator, settleBucket, now);
        // Real coordination payout: the funding wallet (this master/steward node, the query asker) pays the
        // providers whose accepted answers converged this query, so a MINING contributor's balance actually
        // grows from Proof of Resonance + coordination. Run EVERY cycle (not only when the task first
        // publishes): answers can arrive after the task is created, and settle is idempotent per query, so
        // retrying each cycle until >= 2 answers exist is what makes the payout reliable.
        this.settleAutonomousCoordination(resonator.id, settleBucket);
      }
    }
    return { queries, released };
  }

  private paidResonatorRewards = new Set<string>();
  /**
   * Pay a resonator's OWNER for one cycle of autonomous coordination work, from the network settler's base
   * emission. One deterministic funder (the settler), once per (resonator, bucket), so the payout txs never
   * diverge across masters. The amount equals the autonomous task budget, so the owner's real balance and the
   * resonator's displayed totalEarned (credited by the gossiped task) move together. Excludes the settler and
   * genesis masters (they already earn base emission).
   */
  private payResonatorReward(resonator: Resonator, bucket: number, now: number): void {
    if (!this.isNetworkSettler()) return;
    const amt = this.cycleResonatorReward(now);
    if (amt <= 0) return;
    const key = `${resonator.id}:${bucket}`;
    if (this.paidResonatorRewards.has(key)) return;
    const owner = resonator.owner;
    // Pay only genuine third-party (user) owners. The settler, genesis masters, and the steward/founder are
    // network infrastructure — paying them is a pointless self-transfer that only adds settle-window tx load,
    // so skip it. The resonator's DISPLAYED totalEarned still grows for every driven resonator (via the
    // gossiped, tx-free task), so anchor resonators visibly earn even though no ZIR moves to the steward.
    if (!/^zir1[0-9a-z]{6,}$/.test(owner) || owner === this.identity.address
      || owner === this.genesis.founder || this.state.isGenesisMaster(owner)) {
      this.paidResonatorRewards.add(key); return; // nothing to pay, but don't retry
    }
    if (this.state.provisionalBalance(this.identity.address) < amt + PROTOCOL.BASE_FEE_UZIR) return; // fund next cycle (provisional: net txs already pooled this tick, else a later overspend drop leaves the watermark advanced)
    const tx = signTx({
      network: this.genesis.network, from: this.identity.address, fromPubKey: this.identity.publicKey, to: owner,
      amountUZIR: amt, feeUZIR: PROTOCOL.BASE_FEE_UZIR, nonce: this.state.provisionalNonce(this.identity.address),
      kind: "agent_spend", parents: [], timestamp: now, memo: `resonator reward ${bucket}`,
    }, this.identity.privateKey);
    if (this.submitTx(tx).accepted) {
      this.paidResonatorRewards.add(key);
      if (this.paidResonatorRewards.size > 5000) this.paidResonatorRewards = new Set([...this.paidResonatorRewards].slice(-2500));
      this.persistSettlerProgress(); // survive restart: never re-pay this (resonator, bucket)
    }
  }

  private settledCoordinationQueries = new Set<string>();
  /**
   * Pay the providers who contributed accepted answers to an autonomous-resonance query. Only the
   * funding wallet (the founder/steward node whose identity is the query asker) can fund it, and only
   * once per query. The payout is the configured per-query coordination reward, drawn from the founder's
   * already-allocated balance via settleQueryCoordination — no new ZIR is minted.
   */
  private settleAutonomousCoordination(resonatorId: string, bucket: number): void {
    if (AUTONOMOUS_COORDINATION_REWARD_UZIR <= 0) return;
    // Exactly ONE node settles autonomous coordination — the network settler — so the payout transactions are
    // created by a single funder and never diverge across masters (which would freeze quorum finality). On
    // mainnet that funder is the first genesis master (an always-on, keyless coordinator that pays from the
    // base emission it earns); on devnet/test it is the founder. Every other node earns by ANSWERING these
    // queries, never by settling. This is what lets miners earn coordination pay with no steward online.
    if (!this.isNetworkSettler()) return;
    const queryId = this.autonomousResonanceQueryId(resonatorId, bucket);
    if (this.settledCoordinationQueries.has(queryId)) return;
    const raw = this.soft.answers.get(queryId) ?? [];
    const answers = this.modelBackedProviderAnswers(raw);
    if (answers.length < AUTONOMOUS_RESONANCE_MIN_ANSWERS) {
      if (raw.length > 0) log.debug(`autonomous coordination: ${queryId.slice(0, 16)} has ${raw.length} answer(s), ${answers.length} model-backed; need ${AUTONOMOUS_RESONANCE_MIN_ANSWERS} to pay`);
      return;
    }
    // The resonator that drove this query is autonomous AI-to-AI work owned by a user, so its owner earns the
    // resonator-pool slice of the settlement (instead of the shared pool wallet). Miners still earn the 77%.
    const owner = this.soft.resonators.get(resonatorId)?.owner;
    const result = this.settleQueryCoordination(queryId, AUTONOMOUS_COORDINATION_REWARD_UZIR, { poolBeneficiary: owner });
    if (result.ok) {
      this.settledCoordinationQueries.add(queryId);
      // Credit each contributor an answer point (recency-weighted via the per-cycle decay in
      // settleFieldParticipation). This is what makes "answers more -> earns a bigger field share": a
      // stronger machine that wins more coordination answers accumulates more credits. Settler-local +
      // persisted, so it is deterministic on the settler and rides its signed payout tx. Bound the map.
      for (const p of result.payouts ?? []) if (/^zir1[0-9a-z]{6,}$/.test(p.address)) {
        this.minerAnswerCredits.set(p.address, (this.minerAnswerCredits.get(p.address) ?? 0) + 1);
      }
      if (this.minerAnswerCredits.size > 5000) {
        const top = [...this.minerAnswerCredits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2500);
        this.minerAnswerCredits = new Map(top);
      }
      // bound the dedup set: keep only the most recent ids (autonomous queries are bucketed, so this is
      // ample headroom and prevents unbounded growth on a long-running node).
      if (this.settledCoordinationQueries.size > 5000) {
        const keep = [...this.settledCoordinationQueries].slice(-2500);
        this.settledCoordinationQueries = new Set(keep);
      }
      this.persistSettlerProgress(); // survive restart: never re-settle this query with a different answer set
      log.info(`coordination payout for query ${queryId.slice(0, 12)}: ${result.payouts?.length ?? 0} contributors, network ${result.networkUZIR ?? 0}, pool ${result.resonatorPoolUZIR ?? 0}, burn ${result.burnUZIR ?? 0}`);
    }
  }

  // Memo an asker's paid-query charge carries so the settler can tie a real on-chain payment to the query it
  // funds. Kept as a stable, parseable prefix: `query-charge <queryId>`. Used by the /query ingress (to build
  // the charge) and by settleRealUserCoordination (to read it back deterministically from the ledger).
  static QUERY_CHARGE_MEMO_PREFIX = "query-charge ";
  static queryChargeMemo(queryId: string): string { return ZiraNode.QUERY_CHARGE_MEMO_PREFIX + queryId; }

  /**
   * Pay the miners who answered PAID real-user queries. The asker funds the query at ask time with a charge tx
   * to the network coordination wallet (see the /query ingress), and here the network settler reads those
   * charges straight from the ledger (deterministic, on-chain — never a self-reported query field) and pays the
   * converged answerers via settleQueryCoordination with the convergence policy: >= REAL_USER_QUERY_CONVERGENCE
   * answers earn the full charged budget, a lone answerer earns REAL_USER_LONE_ANSWER_FACTOR of it. Exactly ONE
   * funder (the settler) issues the payout as a single signed batch_transfer, so it applies byte-identically on
   * every node — same fork-safe shape as autonomous coordination. Idempotent per query (settledCoordinationQueries
   * + persisted watermark). Dormant until REAL_USER_QUERY_PAYOUT_ACTIVATION_EPOCH, so this is a no-op today.
   *
   * The charged ZIR accrues to the network wallet (protocol treasury) while the settler funds the payout from its
   * base emission; the two are equal in magnitude (budget = charged amount), so the treasury nets out and the
   * asker's payment genuinely sizes the answerers' budget, with the single-funder payout kept fork-safe.
   */
  // Durable set of paid-query charges the settler has OBSERVED on-chain but not yet settled. Decouples payout
  // from the bounded ledger-history scan window: once a charge is seen it is remembered (and persisted) until it
  // is paid or ages out, so a high settlement volume that scrolls the charge out of history — or a settler
  // restart — never loses an asker's funded query. queryId -> { amountUZIR (the funded budget), ts (charge time) }.
  private pendingQueryCharges = new Map<string, { amountUZIR: number; ts: number }>();

  /** Ops/diagnostics + test entry point: run one pass of the paid real-user settlement now (the settler tick
   *  calls the private path on its own schedule). No-op unless this node is the active settler and the feature
   *  is armed, so calling it on a non-settler or while dormant does nothing. */
  settleRealUserQueriesNow(now = Date.now()): void { this.settleRealUserCoordination(now); }

  private settleRealUserCoordination(now = Date.now()): void {
    if (!this.realUserPayoutActive(now)) return;            // dormant: byte-identical to today (no charge, no payout)
    if (!this.isNetworkSettler()) return;                   // one deterministic funder only
    const revenue = settlementWalletsFor(this.genesis.network).network;
    const minTs = now - ZiraNode.REAL_USER_SETTLE_WINDOW_MS; // charges older than this are past the answer window
    // 1. OBSERVE: fold any NEW on-chain charges into the durable pending map. A charge is an asker->revenue
    //    transfer whose memo is `query-charge <queryId>`; the entry amount IS the budget the asker funded.
    for (const e of this.state.recentHistory(revenue, 400)) {
      if (e.to !== revenue) continue;
      if (typeof e.memo !== "string" || !e.memo.startsWith(ZiraNode.QUERY_CHARGE_MEMO_PREFIX)) continue;
      const ts = e.timestamp ?? 0;
      if (ts < minTs) continue;
      const queryId = e.memo.slice(ZiraNode.QUERY_CHARGE_MEMO_PREFIX.length).trim();
      // Only the reserved real-user namespace settles here. A charge crafted for an autonomous (hashed) id — even
      // one submitted directly to the mempool to bypass the ingress check — is ignored, so it can never pre-empt
      // or double-settle autonomous coordination. The stray ZIR simply stays in the network wallet (treasury).
      if (!queryId || !queryId.startsWith(ZiraNode.REAL_USER_QUERY_ID_PREFIX)) continue;
      if (this.settledCoordinationQueries.has(queryId) || this.pendingQueryCharges.has(queryId)) continue;
      const amountUZIR = Math.max(0, Math.floor(e.amountUZIR ?? 0));
      if (amountUZIR > 0) this.pendingQueryCharges.set(queryId, { amountUZIR, ts });
    }
    // 2. SETTLE: pay each answered charge (convergence policy applied), drop settled + aged-out. One signed
    //    batch_transfer per query, applied byte-identically on every node — same fork-safe shape as autonomous.
    let changed = false;
    for (const [queryId, charge] of [...this.pendingQueryCharges]) {
      if (charge.ts < minTs) { this.pendingQueryCharges.delete(queryId); changed = true; continue; } // aged out, never answered
      const answers = this.modelBackedProviderAnswers(this.soft.answers.get(queryId) ?? []);
      if (answers.length === 0) continue;                   // no eligible answer yet; retry a later cycle
      const result = this.settleQueryCoordination(queryId, charge.amountUZIR, { convergencePolicy: true });
      if (!result.ok) continue;                             // insufficient settler balance etc.; retry next cycle
      this.settledCoordinationQueries.add(queryId);
      this.pendingQueryCharges.delete(queryId);
      changed = true;
      for (const p of result.payouts ?? []) if (/^zir1[0-9a-z]{6,}$/.test(p.address)) {
        this.minerAnswerCredits.set(p.address, (this.minerAnswerCredits.get(p.address) ?? 0) + 1);
      }
      log.info(`real-user coordination payout for query ${queryId.slice(0, 12)}: ${result.payouts?.length ?? 0} answerer(s), budget ${charge.amountUZIR}, ${answers.length >= PROTOCOL.REAL_USER_QUERY_CONVERGENCE ? "converged" : "lone (reduced)"}`);
    }
    // Bound every settler-local map so a long-running node never grows unbounded.
    if (this.minerAnswerCredits.size > 5000) this.minerAnswerCredits = new Map([...this.minerAnswerCredits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2500));
    if (this.settledCoordinationQueries.size > 5000) this.settledCoordinationQueries = new Set([...this.settledCoordinationQueries].slice(-2500));
    if (this.pendingQueryCharges.size > 5000) this.pendingQueryCharges = new Map([...this.pendingQueryCharges.entries()].sort((a, b) => b[1].ts - a[1].ts).slice(0, 2500));
    if (changed) this.persistSettlerProgress();             // survive restart: never re-pay a settled query, never lose a pending one
  }
  // A charge older than this is no longer paid (the query has aged out of the answer window); bounds settler work.
  private static REAL_USER_SETTLE_WINDOW_MS = Number(process.env.ZIRA_REAL_USER_SETTLE_WINDOW_MS ?? 30 * 60_000);

  private autonomousResonanceEligible(): Resonator[] {
    // Every funded, listed, resonance-enabled resonator is eligible — NOT just the 12 alphabetically-first
    // (the old `.slice(0, 12)` sorted by id starved every user-created resonator and ~500 anchors, so only
    // anchor-A-001..012 ever earned). Ordered by ZTI desc (deterministic id tiebreak) so if the safety cap
    // ever bites it keeps the highest-trust resonators; the per-cycle ZTI-weighted draw in
    // autonomousResonanceBatch does the actual prioritization.
    return [...this.soft.resonators.values()]
      .filter((r) => r.listed && r.resonanceEnabled && r.status !== "paused" && (r.balanceUZIR ?? 0) > 0)
      .sort((a, b) => (b.zti ?? 0) - (a.zti ?? 0) || a.id.localeCompare(b.id))
      .slice(0, AUTONOMOUS_RESONANCE_ELIGIBLE_CAP);
  }

  /**
   * The single node that funds and settles payouts THIS instant. Still ONE funder at a time (deterministic
   * payout txs, no divergence), but with ORDERED FAILOVER (v2.0.2): the active settler is the LOWEST-index
   * genesis master that is currently live (has beaconed a field heartbeat within the failover window). Normally
   * that is masters[0] (box1). If box1 goes offline its heartbeat ages out of every node's obsPool, so
   * masters[1] becomes the active settler and keeps miners + resonators paid — box1 is no longer a hard single
   * point of failure. Base emission is untouched (still credited only to masters[0]); a failover settler pays
   * from its own pre-funded balance, so this covers box1 OUTAGES, not permanent removal. Who-settles is soft
   * state, so failover never affects the state root; the persisted settler-progress watermark plus the
   * deterministic lowest-live-index rule bound any brief split-brain to at most one already-paid bucket.
   */
  private isNetworkSettler(): boolean {
    const masters = this.genesis.masters ?? [];
    if (masters.length === 0) return this.identity.address === this.genesis.founder;
    return masters[this.activeSettlerIndex()]?.address === this.identity.address;
  }

  // 180s = 6 heartbeat intervals. Wide enough that a heartbeat flapping at the boundary (or a ~90s GC pause)
  // does not promote masters[1] while masters[0] still self-settles — which would double-pay a bucket from two
  // wallets (state-root-safe but an economic double-pay). A genuine outage past 180s still fails over.
  private static SETTLER_FAILOVER_MS = Number(process.env.ZIRA_SETTLER_FAILOVER_MS ?? 180_000);
  /** Index of the lowest-index genesis master that is live now; falls back to 0 so the network keeps a settler
   *  even in the (transient) case where no master heartbeat is visible yet. Soft state; consensus-neutral. */
  private activeSettlerIndex(): number {
    const masters = this.genesis.masters ?? [];
    if (masters.length === 0) return 0;
    const live = this.state.liveGenesisMasters(Date.now(), ZiraNode.SETTLER_FAILOVER_MS);
    // masters[0] is treated as live during the initial window before any heartbeat is observed, so a fresh
    // network does not briefly promote masters[1]. After that, real liveness drives it.
    for (let i = 0; i < masters.length; i++) {
      if (live.has(masters[i]!.address) || (i === 0 && live.size === 0)) return i;
    }
    return 0;
  }

  /**
   * Decentralization cutover: may THIS node issue the pool-funded community payout right now? Only authorized
   * settlers (root-committed {genesis masters ∪ sealed validators}) qualify. A genesis master issues per the
   * existing ordered failover (the lowest live master). A sealed validator issues ONLY when no genesis master
   * is live at all — i.e. box1 is fully down — so the community keeps miners paid. Several validators may
   * attempt it at once; the root-committed pool_payout bucket watermark makes every attempt after the first a
   * no-op, so this soft, liveness-based selection can never double-pay (that guarantee lives in consensus, not
   * here). When the masters come back, they resume as the ordered settler and validators stand down.
   */
  private shouldIssuePoolPayout(): boolean {
    if (!this.state.isAuthorizedSettler(this.identity.address)) return false;
    if (this.state.isGenesisMaster(this.identity.address)) return this.isNetworkSettler();
    const anyMasterLive = this.state.liveGenesisMasters(Date.now(), ZiraNode.SETTLER_FAILOVER_MS).size > 0;
    return !anyMasterLive;   // a validator settles only during a full genesis-master outage
  }

  /**
   * The subset of eligible resonators THIS node drives (publishes resonance queries for). The network settler
   * drives all of them (it is the sole settler); every other genesis master drives only its own shard so the
   * queries keep flowing even when the settler is briefly busy. Publishing is idempotent (queries dedupe by
   * id), and only the settler pays, so redundant driving never double-settles. Non-master nodes drive none.
   */
  private autonomousResonanceDriven(eligible: Resonator[]): Resonator[] {
    if (this.isNetworkSettler()) return eligible;
    const masters = (this.genesis.masters ?? []).map((m) => m.address);
    const idx = masters.indexOf(this.identity.address);
    if (idx < 0 || masters.length === 0) return [];
    return eligible.filter((r) => {
      let h = 0; for (let i = 0; i < r.id.length; i++) h = (h * 31 + r.id.charCodeAt(i)) >>> 0;
      return h % masters.length === idx;
    });
  }

  // Pick this cycle's driven resonators by a DETERMINISTIC ZTI-weighted draw (Efraimidis-Spirakis weighted
  // sampling, made reproducible by hashing id+bucket instead of using an RNG): each resonator gets a key
  // u^(1/weight) with weight = its ZTI and u a hash-derived unit value, and we take the top
  // AUTONOMOUS_RESONANCE_MAX_PER_CYCLE keys. Higher ZTI ⇒ key nearer 1 ⇒ selected far more often, so anchors
  // (0.95/0.85/…) lead and earn the most, yet every funded resonator is drawn with probability rising in its
  // ZTI and rotates in across buckets (the bucket term reshuffles the draw each cycle, so equal-ZTI
  // resonators take turns rather than the same ids always winning). Pure function of (id, bucket, zti): no
  // RNG, identical on every node, restart-stable. Soft state — only the settler pays, via a signed tx applied
  // byte-identically — so the selection never affects the state root.
  private autonomousResonanceBatch(resonators: Resonator[], bucket: number): Resonator[] {
    if (resonators.length <= AUTONOMOUS_RESONANCE_MAX_PER_CYCLE) return resonators;
    const hashUnit = (id: string): number => {
      let h = 2166136261 >>> 0;
      const s = `${id}:${bucket}`;
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
      return ((h >>> 0) + 1) / 4294967297; // in (0, 1)
    };
    return resonators
      .map((r) => {
        // Weight = ZTI + a bootstrap floor, so a brand-new (near-zero ZTI) resonator still draws a fair
        // baseline and can warm up, while a high-ZTI anchor still leads. Clamped to a sane positive range.
        const w = Math.min(2, Math.max(0.05, (r.zti ?? 0) + AUTONOMOUS_RESONANCE_ZTI_BOOTSTRAP));
        return { r, key: Math.pow(hashUnit(r.id), 1 / w) };
      })
      .sort((a, b) => b.key - a.key || a.r.id.localeCompare(b.r.id))
      .slice(0, AUTONOMOUS_RESONANCE_MAX_PER_CYCLE)
      .map((x) => x.r);
  }

  private autonomousResonanceQuery(resonator: Resonator, bucket: number, now: number): QueryMsg {
    const domain = this.autonomousResonanceDomain(resonator, bucket);
    const knownModels = this.models.knownModels();
    const providerCount = this.soft.onlineProviders(Date.now()).length;
    const marketplaceCount = this.soft.marketplace({ sort: "zti", limit: 100 }).length;
    const question = [
      `ZIRA autonomous AI-to-AI coordination cycle ${bucket}.`,
      `Resonator: ${resonator.name} (${resonator.id}).`,
      `Purpose: ${resonator.purpose}`,
      `Domain: ${domain}. Field models: ${knownModels.length}. Online providers: ${providerCount}. Field Exchange Resonators: ${marketplaceCount}.`,
      `Model field: ${knownModels.slice(0, 3).map((m) => m.meta.name).join(", ") || "checking"}.`,
      "Act as part of ZIRA, a shared AI network that people run together: coordinate models, miners, storage, Resonators, tasks, trust, and continuity.",
      "Return a concise coordination proposal that helps this Resonator improve the field through model, storage, task, mining, or resonance coordination. Do not claim human payment or token earnings.",
    ].join("\n");
    return {
      id: this.autonomousResonanceQueryId(resonator.id, bucket),
      domain,
      question,
      history: [],
      asker: this.genesis.founder,
      postedAt: now,
    };
  }

  private autonomousResonanceTask(resonator: Resonator, bucket: number, now: number): Task | null {
    const taskId = this.autonomousResonanceTaskId(resonator.id, bucket);
    if (this.soft.tasks.has(taskId)) return null;
    const queryId = this.autonomousResonanceQueryId(resonator.id, bucket);
    const answers = this.modelBackedProviderAnswers(this.soft.answers.get(queryId) ?? []);
    if (answers.length < AUTONOMOUS_RESONANCE_MIN_ANSWERS) return null;
    const bucketStart = bucket * AUTONOMOUS_RESONANCE_CYCLE_MS;
    const domain = this.autonomousResonanceDomain(resonator, bucket);
    const convergence = this.autonomousConvergenceScore(answers);
    const resultRef = hashHex(answers.map((a) => `${a.provider}:${a.answer}`).sort().join("\n"));
    // The network (settler) funds this reward from base emission, so it is NOT capped by the resonator's own
    // operating float — the resonator EARNS this, it does not spend it. The same amount is paid to the owner
    // (payResonatorReward), so the displayed totalEarned (credited from this gossiped task) matches the payout.
    const budgetUZIR = this.cycleResonatorReward(now);
    return {
      id: taskId,
      client: this.genesis.founder,
      resonatorId: resonator.id,
      domain,
      brief: `Autonomous AI-to-AI convergence for ${resonator.name}; source query ${queryId}.`,
      budgetUZIR,
      minZti: Number(convergence.toFixed(3)),
      status: "released",
      createdAt: bucketStart,
      assignedAt: bucketStart,
      deliveredAt: bucketStart + AUTONOMOUS_RESONANCE_SETTLE_MS,
      resolvedAt: bucketStart + AUTONOMOUS_RESONANCE_SETTLE_MS,
      expiresAt: bucketStart + TASK_DELIVER_TIMEOUT_MS,
      resultRef,
    };
  }

  private autonomousResonanceDomain(resonator: Resonator, bucket: number): Domain {
    const domains = resonator.domains.length ? resonator.domains : (["general"] as Domain[]);
    return domains[bucket % domains.length] ?? "general";
  }

  private autonomousResonanceQueryId(resonatorId: string, bucket: number): string {
    return hashHex(`zira-autonomous-query:${this.gid}:${bucket}:${resonatorId}`);
  }

  private autonomousResonanceTaskId(resonatorId: string, bucket: number): string {
    return hashHex(`zira-autonomous-task:${this.gid}:${bucket}:${resonatorId}`);
  }

  private modelBackedProviderAnswers(answers: AnswerMsg[]): AnswerMsg[] {
    const byProvider = new Map<string, AnswerMsg>();
    for (const answer of [...answers].sort((a, b) => a.ts - b.ts)) {
      if (byProvider.has(answer.provider)) continue;
      if (COORDINATION_FALLBACK_RE.test(answer.answer)) continue;
      if (answer.answer.trim().length < 24) continue;
      if (answer.confidence < 0.4) continue;
      byProvider.set(answer.provider, answer);
    }
    return [...byProvider.values()];
  }

  private autonomousConvergenceScore(answers: AnswerMsg[]): number {
    const confidence = answers.reduce((s, a) => s + Math.max(0, Math.min(1, a.confidence)), 0) / Math.max(1, answers.length);
    const wordSets = answers.map((a) => new Set(a.answer.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3)));
    const shared = wordSets.length >= 2
      ? [...wordSets[0]!].filter((w) => wordSets.slice(1).every((set) => set.has(w))).length
      : 0;
    const vocabulary = new Set(wordSets.flatMap((set) => [...set])).size || 1;
    const alignment = Math.min(1, shared / Math.max(3, vocabulary * 0.2));
    const diversity = Math.min(1, vocabulary / 60);
    return Math.min(0.95, 0.2 + answers.length * 0.1 + confidence * 0.25 + alignment * 0.15 + diversity * 0.1);
  }

  /** Domain-aware provider selection: specialists first (ranked by domain ZTI), then generalists. */
  selectProviders(query: { domain: Domain }, count = 3): ProviderProfile[] {
    const all = this.soft.listProviderProfiles();
    const me = this.identity.address;
    const zti = (addr: string) => this.state.accounts.get(addr)?.ztiByDomain[query.domain] ?? this.state.accounts.get(addr)?.zti ?? 0;
    const byZti = (a: ProviderProfile, b: ProviderProfile) => zti(b.address) - zti(a.address);
    const specialists = all.filter((p) => p.domains.includes(query.domain) && p.address !== me).sort(byZti);
    const generals = all.filter((p) => (p.domains.length === 0 || p.domains.includes("general")) && p.address !== me && !specialists.includes(p)).sort(byZti);
    return [...specialists, ...generals].slice(0, count);
  }

  ztiHistory(address: string, domain?: Domain, limit = 100) { return this.store.getZtiHistory(address, domain, limit); }

  private voteCheckpoints(now: number): void {
    const epoch = this.state.lastProcessedEpoch;
    if (epoch <= this.lastVotedEpoch) return;
    this.lastVotedEpoch = epoch;
    // EVERY node records its OWN state root for this settle epoch. A master additionally signs+gossips it as its
    // finality vote; a follower keeps it only to self-check later (see maybeResyncOnDivergence). If a follower's
    // applied state ever stops hashing to the finalized consensus root, it has silently diverged (typically a
    // missed gossiped payout tx) and must re-adopt a verified master snapshot, or balanceOf reads a stale balance
    // forever — a mining node then looks like it earns nothing even though every master has credited it.
    const root = this.state.stateRoot();
    this.localRootByEpoch.set(epoch, root);
    if (this.localRootByEpoch.size > LOCAL_ROOT_HISTORY) {
      const cutoff = epoch - LOCAL_ROOT_HISTORY;
      for (const e of this.localRootByEpoch.keys()) if (e <= cutoff) this.localRootByEpoch.delete(e);
    }
    // Cache the FINALIZED-consistent snapshot keyed by this epoch's root, taken at the exact moment the
    // applied state hashes to `root`. serveSnapshot() serves the copy whose root == lastFinalizedRoot so a
    // joiner's verifyFastSyncSnapshot (which recomputes computeStateRoot over the served accounts) matches the
    // checkpoint. Without this, serveSnapshot sent the drifting HEAD state paired with the LAGGED finalized
    // root, so computeStateRoot(head) != finalizedRoot and every fast-sync attempt was rejected (ROOT
    // MISMATCH) — fresh nodes then fell back to genesis replay and ran with wrong local balances. Deep-copied
    // (JSON round-trip) so later balance mutations to the live account objects never corrupt a cached root.
    this.finalizedSnapByRoot.set(root, JSON.parse(JSON.stringify(this.state.snapshot())));
    if (this.finalizedSnapByRoot.size > FINALIZED_SNAP_HISTORY) {
      const oldest = this.finalizedSnapByRoot.keys().next().value as string | undefined;
      if (oldest !== undefined) this.finalizedSnapByRoot.delete(oldest);
    }
    const me = this.state.accounts.get(this.identity.address);
    if (!me || !me.isMaster) return;
    const vote = this.checkpoints.createVote(epoch, root, this.state.supply, this.identity, me.zti, now);
    const fin = this.checkpoints.receiveVote(vote, this.state.totalMasterTrust(), this.state.masterZtiMap());
    void fin;
    this.publish(this.topics.consensus, { t: "checkpoint", data: vote });
  }

  // ---- inbound ----

  private onWire(topic: string, data: Uint8Array, _from: string): void {
    let env: Envelope;
    try { env = JSON.parse(dec.decode(data)); } catch { return; }
    this.ingest(env, true);
  }

  /** Validate and apply an envelope. Persists ledger and consensus events. */
  ingest(env: Envelope, _fromWire: boolean): { ok: boolean; isNew: boolean; reason?: string } {
    const id = envelopeId(env);
    switch (env.t) {
      case "tx": {
        const r = this.state.ingestTx(env.data);
        if (r.isNew) this.store.appendEvent(env);
        return { ok: r.ok, isNew: r.isNew, reason: r.reason };
      }
      case "observation": {
        const r = this.state.ingestObservation(env.data);
        if (r.isNew) this.store.appendEvent(env);
        return { ok: r.ok, isNew: r.isNew, reason: r.reason };
      }
      case "checkpoint": {
        if (this.checkpoints.isVoteKnown(env.data.id)) return { ok: true, isNew: false };
        // Drop votes for an epoch that is already finalized (well behind the head). They can no longer change
        // finality, and each re-vote of an already-settled epoch carries a fresh prevRoot -> a new vote id, so
        // the id-dedup above does not catch them. Persisting every such vote is what bloated events.jsonl into
        // a startup hot-loop ("could not start / node not reachable"). Local persistence decision, made
        // identically by every node, so it never affects consensus.
        if (env.data.epoch <= this.checkpoints.lastFinalizedEpoch) return { ok: true, isNew: false };
        const fin = this.checkpoints.receiveVote(env.data, this.state.totalMasterTrust(), this.state.masterZtiMap());
        this.store.appendEvent(env);
        void fin;
        return { ok: true, isNew: true };
      }
      case "resonator": {
        // Derive the resonator's operating float from THIS node's ledger (consensus-shared), never from the
        // gossiped record, so the creation-cost gate and the displayed balance are consistent everywhere.
        const isNew = this.soft.upsertResonator(env.data, this.state.balanceOf(env.data.address), this.resonatorCreationFrozen(), this.resonatorFreezeActivationEpoch());
        if (_fromWire && isNew) this.store.appendEvent(env);
        return { ok: true, isNew };
      }
      case "task": {
        const isNew = this.soft.upsertTask(env.data);
        if (_fromWire && isNew) this.store.appendEvent(env);
        return { ok: true, isNew };
      }
      case "provider": return { ok: this.soft.upsertProvider(env.data, Date.now()), isNew: true };
      case "providerProfile": {
        const isNew = this.soft.upsertProviderProfile(env.data);
        if (_fromWire && isNew) this.store.appendEvent(env);
        return { ok: isNew, isNew };
      }
      case "recommendation": {
        const isNew = this.soft.upsertRecommendation(env.data);
        if (_fromWire && isNew) this.store.appendEvent(env);
        return { ok: isNew, isNew };
      }
      case "query": return { ok: true, isNew: this.soft.addQuery(env.data) };
      case "answer": return { ok: this.soft.addAnswer(env.data), isNew: true };
      case "model": {
        const isNew = this.models.onAnnounce(env.data);
        if (_fromWire && isNew) this.store.appendEvent(env);
        return { ok: true, isNew };
      }
      default: { void id; return { ok: false, isNew: false, reason: "unknown envelope" }; }
    }
  }

  private *syncFrames(): Iterable<Uint8Array> {
    // Hand a joining peer our durable events. A peer that adopted a VERIFIED finalized snapshot
    // (fast-sync) only needs the tail to fill the post-snapshot gap, and that is the scalable default.
    // But a peer that could NOT fast-sync replays from genesis, and for that replay to converge on the
    // SAME committed state — crucially the same supply.burned and the same state root — it must see
    // EVERY fee-bearing event from genesis. A fixed tail (we previously capped at 1500) silently drops
    // early query-fee burns, so a late joiner reconstructed a different burned total (e.g. it diverged on
    // the burn of early query fees) and forked the state root. Serving the complete log makes the
    // genesis-replay path exact and deterministic; fast-sync remains the cheap path for large histories.
    const all = this.store.readEvents();
    const cap = Number(process.env.ZIRA_SYNC_FRAME_CAP ?? "");
    const events = Number.isInteger(cap) && cap > 0 ? all.slice(-cap) : all;
    for (const env of events) yield enc.encode(JSON.stringify(env));
  }

  private fastSynced = false;
  private fastSyncStarted = false;
  private fastSyncFailedAttempts = 0;
  private static FAST_SYNC_MAX_ATTEMPTS = 12;
  private startedFresh = false;
  // Finality watchdog (auto-resync). If finalizedEpoch freezes while the chain clock keeps moving, the node
  // re-adopts a current, verified peer snapshot, the same self-heal a fresh node uses on join. Conservative
  // thresholds avoid false triggers during normal brief settling.
  private lastFinalizedSeen = -1;
  private finalizedProgressAt = 0;
  private resyncInFlight = false;
  private lastResyncAt = 0;
  // Consecutive stall-resyncs that found NO advanced peer. Drives an exponential backoff so a whole cluster
  // stuck at the same epoch does not resync-thrash in lockstep (the 2026-07-10 box1 CPU-saturation stall).
  private resyncFailStreak = 0;
  // State-divergence watchdog bookkeeping (see maybeResyncOnDivergence). Our own recorded root per settle epoch,
  // a streak of finalized epochs whose consensus root disagreed with ours, and rate-limit stamps.
  private localRootByEpoch = new Map<number, string>();
  // root -> deep-copied state snapshot taken when the applied state hashed to that root. serveSnapshot()
  // serves the entry for lastFinalizedRoot so the served state matches the finalized checkpoint it is paired
  // with (see voteCheckpoints). Bounded by FINALIZED_SNAP_HISTORY.
  private finalizedSnapByRoot = new Map<string, object>();
  private divergentFinalizedStreak = 0;
  private lastDivergenceCheckedEpoch = -1;
  private lastDivergenceResyncAt = 0;
  // Thresholds sit ABOVE the normal finality lag or the watchdog false-alarms every cycle: finality trails the
  // processed head by the settle window (SETTLE_ROUNDS=8 epochs + GRACE 20s ~= 60-70s, ~12-18 epochs at
  // EPOCH_MS=5s) even when perfectly healthy. A REAL stall (the 2026-07-04 freeze) leaves finality frozen for
  // MINUTES while the processed head runs hundreds of epochs ahead, so these looser bounds still catch it fast
  // while no longer firing spurious "stalled" warnings + no-op resyncs during ordinary settle lag.
  private readonly resyncStallMs = 120_000;    // finalizedEpoch must stay frozen this long to count as stalled
  private readonly resyncMinGap = 40;          // and the processed head must be at least this far ahead
  private readonly resyncCooldownMs = 90_000;  // and at most one resync attempt per this window

  private liveNonce = 0;
  /** Answer a liveness/coordination challenge: return our address + a signature over the master's nonce, so
   * the master can confirm we are a real, directly-reachable, participating peer (the baseline coordination
   * work that earns even without holding model bytes). */
  private async *serveLiveness(req: Uint8Array, from: string): AsyncIterable<Uint8Array> {
    let msg: { nonce?: unknown; push?: unknown; address?: unknown; pubKey?: unknown; ts?: unknown; sig?: unknown } = {};
    try { msg = JSON.parse(dec.decode(req)) as typeof msg; } catch { /* empty */ }
    // PUSH: a miner proactively asserts liveness over its OWN outbound connection (churn/NAT-resilient). Only a
    // MASTER records it, binding the pushed address to THIS connection's peer id — one address per live
    // connection, the same sybil bound as the reverse probe — so the miner stays vouched and paid without the
    // master ever having to probe it back. Verified by the miner's own signature + a fresh timestamp.
    if (msg.push === true && typeof msg.address === "string" && typeof msg.pubKey === "string" && typeof msg.sig === "string" && typeof msg.ts === "number") {
      const now = Date.now();
      const isMaster = this.state.isGenesisMaster(this.identity.address) || (this.state.accounts.get(this.identity.address)?.isMaster ?? false);
      if (isMaster && from && Math.abs(now - msg.ts) <= PUSH_LIVENESS_MAX_AGE_MS &&
          /^zir1[0-9a-z]{6,}$/.test(msg.address) && msg.address !== this.identity.address && !this.state.isGenesisMaster(msg.address) &&
          addressFromPubKey(msg.pubKey) === msg.address && edVerify("zira-live-push:" + msg.ts, msg.sig, msg.pubKey)) {
        this.pushVouch.set(from, { address: msg.address, ts: now });
      }
      yield enc.encode(JSON.stringify({ ok: true }));
      return;
    }
    // CHALLENGE (reverse probe, backward compatible): sign the master's nonce so it can confirm we are live.
    // COMMITMENT GATE (invariant I1: earning is pay for lending the machine, not for merely being reachable).
    // Only a node that actually contributes answers with its address: mining or storage on (a committed
    // community miner), OR a consensus node (genesis or earned master, which participates through finality and
    // must always answer so master-to-master liveness and settler failover keep working). An idle community
    // node that has NOT committed replies with an address-less ack, so verifyPeerLive treats it as "no vouch"
    // and the settler never pays it. Backward compatible: the frame shape is unchanged; older masters simply
    // read no address and skip it. Consensus-safe: this only narrows which peers a master vouches, and payouts
    // still ride the settler's single signed batch_transfer applied identically by every node.
    const isMasterSelf = this.state.isGenesisMaster(this.identity.address) || (this.state.accounts.get(this.identity.address)?.isMaster ?? false);
    const committed = this.models.miningEnabled() || this.models.storageState().enabled || isMasterSelf;
    const nonce = String(msg.nonce ?? "").slice(0, 96);
    if (!committed) { yield enc.encode(JSON.stringify({ ok: true, committed: false })); return; }
    yield enc.encode(JSON.stringify({
      address: this.identity.address,
      pubKey: this.identity.publicKey,
      sig: edSign("zira-live:" + nonce, this.identity.privateKey),
    }));
  }

  /** Push a fresh signed liveness assertion to each connected master over our own outbound connection. This is
   *  the reliable, NAT-proof half of vouching: the master cannot always probe a churning home node back, but
   *  the node can always reach out to the master it dialed. Self-throttled; best-effort per master. */
  private lastPushLivenessBucket = -1;
  private async contributePushLiveness(now: number): Promise<void> {
    if (this.isFounder()) return;
    if (this.state.isGenesisMaster(this.identity.address)) return;   // masters vouch on push; they do not push
    if (!this.models.miningEnabled() && !this.models.storageState().enabled) return;
    const bucket = Math.floor(now / PUSH_LIVENESS_INTERVAL_MS);
    if (bucket === this.lastPushLivenessBucket) return;
    this.lastPushLivenessBucket = bucket;
    // Push to EVERY connected peer, not only those whose peer id matches a configured seed multiaddr. A home/NAT
    // node usually reaches the masters via discovery or a relay rather than an exact "/p2p/<id>" seed entry, so
    // seedPeers() is empty for it and the old code returned here without ever pushing — the node stayed connected
    // and syncing yet was never vouched or paid. Only a master RECORDS the push (serveLiveness verifies isMaster +
    // the signature, binding one address per connection), so pushing to non-master peers is a harmless no-op and
    // adds no sybil surface. Seeds first so masters stay within the cap even on a node with many peers.
    const seeded = this.net.seedPeers?.() ?? [];
    const targets = [...new Set([...seeded, ...this.net.peers()])].slice(0, PUSH_LIVENESS_MAX_TARGETS);
    if (!targets.length) return;
    const body = enc.encode(JSON.stringify({
      push: true, address: this.identity.address, pubKey: this.identity.publicKey, ts: now,
      sig: edSign("zira-live-push:" + now, this.identity.privateKey),
    }));
    for (const peerId of targets) void this.net.request(peerId, LIVENESS_PROTOCOL, body, 8_000).catch(() => { /* best effort; retry next bucket */ });
  }

  /** Probe a directly-connected peer's liveness. Returns its verified ZIR address, or null if it did not
   * answer a fresh signed challenge. Bounded by the request timeout so a stalled peer never blocks. */
  private async verifyPeerLive(peerId: string): Promise<string | null> {
    // A single bounded, env-tunable probe. This is now the SECONDARY vouch path: a churning NAT/home node that
    // the master cannot reliably reach back is carried instead by push liveness (contributePushLiveness ->
    // serveLiveness -> pushVouch), so the reverse probe is kept deliberately light — one attempt, no retry
    // storm — to avoid piling concurrent streams onto the settler (which itself worsens the connection churn
    // it is trying to measure). Consensus-safe: this only widens which miners this master vouches for, which
    // rides on its own signed observation/payout.
    const timeout = Number(process.env.ZIRA_LIVENESS_PROBE_TIMEOUT_MS ?? 10_000);
    const nonce = `${Date.now()}:${this.liveNonce++}:${peerId.slice(0, 10)}`;
    try {
      const frames = await this.net.request(peerId, LIVENESS_PROTOCOL, enc.encode(JSON.stringify({ nonce })), timeout);
      if (!frames[0]) return null;
      const r = JSON.parse(dec.decode(frames[0])) as { address?: string; pubKey?: string; sig?: string };
      if (!r.address || !r.pubKey || !r.sig) return null;
      if (addressFromPubKey(r.pubKey) !== r.address) return null;
      if (!edVerify("zira-live:" + nonce, r.sig, r.pubKey)) return null;
      return r.address;
    } catch { return null; }
  }

  /** Serve our finalized state snapshot to a joining peer, with the finalized checkpoint it sits on. */
  private async *serveSnapshot(): AsyncIterable<Uint8Array> {
    const finRoot = this.checkpoints.lastFinalizedRoot;
    // Serve the snapshot whose root == the finalized root, NOT the drifting head. If the finalized snapshot
    // is not cached (e.g. finality lag briefly exceeded FINALIZED_SNAP_HISTORY, or right after boot), fall
    // back to the head snapshot — the joiner's verifier simply rejects it and retries the next peer, exactly
    // as before, so this is never worse than the old behaviour and normally strictly correct.
    const finalizedSnap = this.finalizedSnapByRoot.get(finRoot) ?? this.state.snapshot();
    yield enc.encode(JSON.stringify({
      snapshot: finalizedSnap,
      finalizedEpoch: this.checkpoints.lastFinalizedEpoch,
      finalizedRoot: finRoot,
      votes: this.checkpoints.finalizingVotes(this.checkpoints.lastFinalizedEpoch, finRoot),
    }));
  }

  /**
   * Verify a peer snapshot is cryptographically bound to a genuinely finalized checkpoint before
   * adopting it. Delegates to the pure verifyFastSyncSnapshot using this node's genesis.
   */
  private verifyFastSyncSnapshot(best: Snap): boolean {
    return verifyFastSyncSnapshot(best, this.genesis);
  }

  /**
   * On joining, a brand new node adopts a snapshot instead of recomputing the whole chain. To avoid
   * trusting peers, it asks several connected ones, takes the most advanced snapshot, and adopts it
   * only after verifyFastSyncSnapshot proves the snapshot hashes to a finalized checkpoint backed by
   * >= 67% of master trust including a genesis founder. If that proof fails, it does NOT adopt and
   * stays on the state it already replayed from genesis (correct, just slower). It then validates
   * every event from there. Run with ZIRA_FULL_SYNC=1 to skip fast-sync and replay from genesis.
   * Nodes that already have their own state never adopt one.
   */
  private async maybeFastSync(_peer: string): Promise<void> {
    // F2: only one fast-sync negotiation may run at a time. Several peers can connect simultaneously;
    // without this guard each would race to adopt a snapshot. `caller` (Libp2pNetwork) AWAITS this
    // before pulling the event tail, so the snapshot is adopted and the convergence floor is armed
    // before any backfilled event is ingested — otherwise finalized coordination events land on
    // pre-snapshot state and the joiner's root diverges from the mesh by a fixed offset.
    if (this.fastSynced || !this.startedFresh || this.fastSyncStarted) return;
    this.fastSyncStarted = true;
    try {
      if (!this.opts.fastSync) { this.fastSynced = true; log.info("fast sync disabled; validating from local history/genesis"); return; }
      if (process.env.ZIRA_FULL_SYNC === "1") { this.fastSynced = true; return; }
      const got: Snap[] = [];
      for (const p of this.net.peers().slice(0, 5)) {
        try {
          const frames = await this.net.request(p, SNAPSHOT_PROTOCOL, enc.encode("{}"));
          if (frames[0]) got.push(JSON.parse(dec.decode(frames[0])) as Snap);
        } catch { /* try the next peer */ }
      }
      if (got.length === 0) return; // no snapshot yet; a later peer connect retries (see finally)
      // most advanced first
      got.sort((a, b) => (b.finalizedEpoch ?? -1) - (a.finalizedEpoch ?? -1));
      const best = got[0]!;
      if (!best.snapshot || !Array.isArray(best.snapshot.accounts) || best.snapshot.accounts.length === 0) return;
      if (!this.verifyFastSyncSnapshot(best)) {
        // Do NOT give up after one failed verification. A snapshot fails exactly this check whenever the
        // serving peer's live state has moved past its finalized root (finality jitter, catch-up windows) —
        // a TRANSIENT condition. Giving up permanently ("replaying from genesis") stranded joining nodes at
        // epoch -1 forever (the mainnet clock is hundreds of millions of epochs ahead of genesis), which
        // users saw as a stuck 0 balance. Retry on later peer connects, bounded so a genuinely
        // incompatible network still degrades to the old behavior instead of retrying forever.
        this.fastSyncFailedAttempts++;
        if (this.fastSyncFailedAttempts >= ZiraNode.FAST_SYNC_MAX_ATTEMPTS) {
          log.warn(`fast-sync: snapshot verification failed ${this.fastSyncFailedAttempts} times; replaying from genesis`);
          this.fastSynced = true;
          return;
        }
        log.warn(`fast-sync: snapshot failed checkpoint verification (attempt ${this.fastSyncFailedAttempts} of ${ZiraNode.FAST_SYNC_MAX_ATTEMPTS}); retrying on the next peer`);
        return; // finally() re-arms fastSyncStarted so a later peer connect retries
      }
      // Adopt the snapshot AND arm the fast-sync convergence floor: any backfilled event already covered
      // by the adopted epoch is dropped and never reprocessed, so the joiner converges exactly to the mesh
      // state root instead of carrying a small offset from re-running the field over events the snapshot
      // already counted. Events strictly after the adopted epoch are still applied forward as normal.
      const dropped = this.state.adoptFastSyncSnapshot(best.snapshot);
      this.fastSynced = true;
      log.info(`fast synced to epoch ${this.state.lastProcessedEpoch}, finalized ${best.finalizedEpoch} verified against master checkpoint; floor armed, dropped ${dropped.txs} txs/${dropped.observations} obs already in snapshot; validating from here`);
    } finally {
      // If we did not actually adopt (no snapshot available yet), release the guard so a later peer
      // connect can retry the negotiation. Once adopted, fastSynced stays true and this is a no-op.
      if (!this.fastSynced) this.fastSyncStarted = false;
    }
  }

  /**
   * Finality watchdog. If finalizedEpoch has not advanced for a sustained window while the chain clock keeps
   * moving, the node is stalled: either its state diverged from the mesh (its votes never match quorum) or it
   * restarted into a backfill gap that live gossip cannot fill. The cure is the same as a fresh join: adopt a
   * current, cryptographically-verified snapshot from an advanced peer. This is the self-heal that lets a node
   * restart or rejoin without manual intervention. Idempotent and trustless: the snapshot must pass the same
   * >=67%-master, genesis-anchored checkpoint proof as initial fast-sync.
   */
  private maybeResyncOnStall(now: number): void {
    if (!this.opts.fastSync || process.env.ZIRA_FULL_SYNC === "1") return;
    const fin = this.checkpoints.lastFinalizedEpoch;
    if (fin > this.lastFinalizedSeen) { this.lastFinalizedSeen = fin; this.finalizedProgressAt = now; this.resyncFailStreak = 0; return; }
    if (this.finalizedProgressAt === 0) { this.finalizedProgressAt = now; return; } // arm on first observation
    if (now - this.finalizedProgressAt < this.resyncStallMs) return;
    if (this.state.lastProcessedEpoch - fin < this.resyncMinGap) return;
    if (this.net.peerCount() === 0) return;
    // De-thrash (2026-07-10 box1 CPU-saturation incident): when a whole cluster is stuck at the SAME epoch,
    // every node fired a heavy full-snapshot resync every cooldown, all in lockstep — pegging CPU so no node
    // could process the heartbeat gossip that would restore quorum (a self-reinforcing stall). Back off
    // EXPONENTIALLY once resyncs stop finding an advanced peer (capped at 15 min), plus a deterministic
    // per-node jitter so the masters never resync in unison. Consensus-neutral: this only changes WHEN a
    // snapshot is pulled, never what is computed or voted.
    const backoff = Math.min(this.resyncCooldownMs * 2 ** Math.min(this.resyncFailStreak, 5), 900_000);
    const jitter = (this.identity.address.charCodeAt(5) * 911) % 45_000;
    if (this.resyncInFlight || now - this.lastResyncAt < backoff + jitter) return;
    this.lastResyncAt = now;
    log.warn(`finality stalled: finalizedEpoch ${fin} unchanged for ${Math.round((now - this.finalizedProgressAt) / 1000)}s (processed ${this.state.lastProcessedEpoch}); attempting resync from peers`);
    void this.attemptResyncFromPeers();
  }

  /**
   * State-divergence watchdog. The finality watchdog above only catches a FROZEN finalized epoch. A follower can
   * instead keep finalizing the master-signed roots normally while its own applied state quietly drifts from them:
   * it missed a gossiped payout tx, so balanceOf under-reports and a mining node looks like it earns nothing even
   * though every master has credited it. We detect that directly — our own recorded root for the latest finalized
   * epoch must equal the finalized consensus root — and, if it disagrees for a few consecutive finalized epochs,
   * re-adopt a verified master snapshot. Consensus-neutral: a master's own root always equals its own vote, so
   * this only ever heals followers and changes nothing a master finalizes.
   */
  private maybeResyncOnDivergence(now: number): void {
    if (!this.opts.fastSync || process.env.ZIRA_FULL_SYNC === "1") return;
    if (this.net.peerCount() === 0) return;
    const fin = this.checkpoints.lastFinalizedEpoch;
    if (fin < 0 || fin === this.lastDivergenceCheckedEpoch) return;   // one check per new finalized epoch
    const localRoot = this.localRootByEpoch.get(fin);
    if (localRoot === undefined) return;                             // have not computed our own root for it yet
    this.lastDivergenceCheckedEpoch = fin;
    if (localRoot === this.checkpoints.lastFinalizedRoot) { this.divergentFinalizedStreak = 0; return; }
    this.divergentFinalizedStreak++;
    if (this.divergentFinalizedStreak < DIVERGENCE_STREAK_TRIGGER) return;
    if (this.resyncInFlight || now - this.lastDivergenceResyncAt < this.resyncCooldownMs) return;
    this.lastDivergenceResyncAt = now;
    log.warn(`state diverged from consensus: our root for finalized epoch ${fin} != finalized root over ${this.divergentFinalizedStreak} epochs; re-adopting a verified master snapshot`);
    void this.attemptResyncOnDivergence();
  }

  /** Re-adopt the most-advanced verified master snapshot to heal a diverged (not merely stalled) follower. Unlike
   *  attemptResyncFromPeers this does NOT require the peer to be further ahead — a diverged node's finalized epoch
   *  is current, only its state is wrong — but it keeps the identical checkpoint-verification gate, so a forged or
   *  forked snapshot can never be adopted. */
  private async attemptResyncOnDivergence(): Promise<void> {
    if (this.resyncInFlight) return;
    this.resyncInFlight = true;
    try {
      const got: Snap[] = [];
      for (const p of this.net.peers().slice(0, 8)) {
        try {
          const frames = await this.net.request(p, SNAPSHOT_PROTOCOL, enc.encode("{}"));
          if (frames[0]) got.push(JSON.parse(dec.decode(frames[0])) as Snap);
        } catch { /* try the next peer */ }
      }
      if (!got.length) return;
      // Try EVERY candidate, most-advanced first, and adopt the first that verifies. A single snapshot commonly
      // fails verifyFastSyncSnapshot only transiently — the serving peer's live state has moved a few epochs past
      // its own finalized root, so the returned account table no longer hashes to the finalized root it carries.
      // Picking just the most-advanced one (as the stall path does, which relies on retrying later) would leave a
      // diverged follower stuck at 0 across the cooldown; iterating the batch heals on the first round instead.
      got.sort((a, b) => (b.finalizedEpoch ?? -1) - (a.finalizedEpoch ?? -1));
      for (const cand of got) {
        if (!cand.snapshot || !Array.isArray(cand.snapshot.accounts) || cand.snapshot.accounts.length === 0) continue;
        if (!this.verifyFastSyncSnapshot(cand)) continue;                 // this peer's live state raced its root; try the next
        const dropped = this.state.adoptFastSyncSnapshot(cand.snapshot);
        this.checkpoints.lastFinalizedEpoch = cand.finalizedEpoch;
        this.checkpoints.lastFinalizedRoot = cand.finalizedRoot;
        this.lastFinalizedSeen = cand.finalizedEpoch;
        this.finalizedProgressAt = Date.now();
        this.divergentFinalizedStreak = 0;
        this.lastDivergenceCheckedEpoch = -1;
        this.localRootByEpoch.clear();
        log.info(`divergence resync: adopted verified master snapshot at finalized epoch ${cand.finalizedEpoch} (dropped ${dropped.txs} txs/${dropped.observations} obs already in snapshot); balances now match consensus`);
        return;
      }
      log.warn(`divergence resync: no peer served a verifiable snapshot this round (${got.length} tried); will retry`);
    } finally {
      this.resyncInFlight = false;
    }
  }

  /** Adopt the most-advanced verified peer snapshot to recover from a finality stall. See maybeResyncOnStall. */
  private async attemptResyncFromPeers(): Promise<void> {
    if (this.resyncInFlight) return;
    this.resyncInFlight = true;
    let adopted = false;
    try {
      const got: Snap[] = [];
      for (const p of this.net.peers().slice(0, 5)) {
        try {
          const frames = await this.net.request(p, SNAPSHOT_PROTOCOL, enc.encode("{}"));
          if (frames[0]) got.push(JSON.parse(dec.decode(frames[0])) as Snap);
        } catch { /* try the next peer */ }
      }
      if (got.length === 0) return;
      got.sort((a, b) => (b.finalizedEpoch ?? -1) - (a.finalizedEpoch ?? -1));
      const best = got[0]!;
      if (!best.snapshot || !Array.isArray(best.snapshot.accounts) || best.snapshot.accounts.length === 0) return;
      // Only adopt a peer genuinely ahead of our stuck point, and only if its snapshot is bound to a real
      // finalized checkpoint (same gate as initial fast-sync; a forked or older snapshot cannot pass).
      if (best.finalizedEpoch <= this.checkpoints.lastFinalizedEpoch + this.resyncMinGap) return;
      if (!this.verifyFastSyncSnapshot(best)) { log.warn("resync: peer snapshot failed checkpoint verification; staying put"); return; }
      const dropped = this.state.adoptFastSyncSnapshot(best.snapshot);
      // Move our finalized marker up to the adopted checkpoint so finality resumes forward from here (live
      // votes for newer epochs finalize on top), instead of re-finalizing a gap it never had votes for.
      this.checkpoints.lastFinalizedEpoch = best.finalizedEpoch;
      this.checkpoints.lastFinalizedRoot = best.finalizedRoot;
      this.lastFinalizedSeen = best.finalizedEpoch;
      this.finalizedProgressAt = Date.now();
      adopted = true;
      log.info(`resynced past finality stall: adopted verified snapshot at finalized epoch ${best.finalizedEpoch} (dropped ${dropped.txs} txs/${dropped.observations} obs already in snapshot); finality resuming`);
    } finally {
      this.resyncInFlight = false;
      // A resync that adopted nothing means no peer was ahead (the cluster is stuck together) — grow the
      // backoff so we stop hammering CPU; a real adoption resets it. See maybeResyncOnStall.
      if (adopted) this.resyncFailStreak = 0; else this.resyncFailStreak++;
    }
  }

  // ---- outbound (from the local RPC) ----

  private publish(topic: string, env: Envelope): void {
    void this.net.publish(topic, enc.encode(JSON.stringify(env)));
  }

  submitTx(tx: SignedTx): { accepted: boolean; reason?: string } {
    const r = this.state.ingestTx(tx);
    if (r.ok && r.isNew) { this.store.appendEvent({ t: "tx", data: tx }); this.publish(this.topics.events, { t: "tx", data: tx }); }
    return { accepted: r.ok, reason: r.reason };
  }

  /**
   * Export the node's own (mining) wallet: address + the private key. The node's identity IS the wallet
   * a self-run operator earns into, so the local desktop Console adopts it as its active wallet (in
   * memory, never persisted in the browser) and can then sign sends, query fees, resonator and anchor
   * actions with it. The RPC route that calls this is loopback-ONLY (see server.ts), so the key never
   * crosses the network: it is only ever handed to the Console running on the same machine, and
   * identity.json already sits in plaintext in the data dir on that same disk.
   */
  exportWallet(): { address: string; privateKey: string; publicKey: string; balanceUZIR: number } {
    return { address: this.identity.address, privateKey: this.identity.privateKey, publicKey: this.identity.publicKey, balanceUZIR: this.state.balanceOf(this.identity.address) };
  }

  /**
   * Import a wallet as THIS node's identity: the node will mine into it after a restart. Writes the key to
   * <dataDir>/identity.json (the same file loadOrCreateIdentity reads at startup). Loopback-gated at the RPC
   * layer. The caller restarts the node/app so the new identity loads; we do not hot-swap it in-process
   * because the identity is referenced throughout a running node.
   */
  importIdentity(privateKey: string): { ok: boolean; address?: string; reason?: string } {
    let kp;
    try { kp = keypairFromPrivate(String(privateKey || "").trim()); }
    catch { return { ok: false, reason: "that is not a valid private key" }; }
    try {
      mkdirSync(this.dataDir, { recursive: true });
      writeFileSync(join(this.dataDir, "identity.json"), JSON.stringify({ privateKey: kp.privateKey, publicKey: kp.publicKey, address: kp.address }, null, 2));
      return { ok: true, address: kp.address };
    } catch (e) { return { ok: false, reason: e instanceof Error ? e.message : "could not write identity" }; }
  }
  submitObservation(o: SignedObservation): { accepted: boolean; reason?: string } {
    const r = this.state.ingestObservation(o);
    if (r.ok && r.isNew) { this.store.appendEvent({ t: "observation", data: o }); this.publish(this.topics.events, { t: "observation", data: o }); }
    return { accepted: r.ok, reason: r.reason };
  }
  /**
   * Case B resonator-creation freeze: true when the freeze is armed (activation epoch > 0 and reached) AND
   * the anchors are not yet all secured by users. Enforced on the accept path (both publish and gossip), so
   * old app releases cannot bypass it. Dormant (always false) while the activation epoch is 0 = today's
   * behavior. Off the state root, so this is consensus-neutral.
   */
  /** Effective freeze activation epoch: the env override ZIRA_RESONATOR_FREEZE_EPOCH (operators can arm/disarm
   *  without a rebuild) else the compiled constant. Off the state root, so per-node config is consensus-neutral;
   *  set it on the masters + gateways (the authoritative accept layer) to freeze creation network-wide. */
  private resonatorFreezeActivationEpoch(): number {
    const env = Number(process.env.ZIRA_RESONATOR_FREEZE_EPOCH);
    return Number.isFinite(env) && env > 0 ? Math.floor(env) : PROTOCOL.RESONATOR_CREATION_FREEZE_ACTIVATION_EPOCH;
  }
  private resonatorCreationFrozen(): boolean {
    const act = this.resonatorFreezeActivationEpoch();
    if (!(act > 0) || epochOf(Date.now()) < act) return false;
    return !this.state.allAnchorsSecured();
  }
  publishResonator(r: Resonator): boolean { const ok = this.soft.upsertResonator(r, this.state.provisionalBalance(r.address), this.resonatorCreationFrozen(), this.resonatorFreezeActivationEpoch()); if (ok) { const env = { t: "resonator" as const, data: r }; this.store.appendEvent(env); this.publish(this.topics.app, env); } return ok; }
  publishTask(t: Task): boolean { const ok = this.soft.upsertTask(t); if (ok) { const env = { t: "task" as const, data: t }; this.store.appendEvent(env); this.publish(this.topics.app, env); } return ok; }
  publishProvider(p: ProviderAnnounce): boolean { const ok = this.soft.upsertProvider(p, Date.now()); if (ok) this.publish(this.topics.app, { t: "provider", data: p }); return ok; }
  publishProviderProfile(p: ProviderProfile): boolean { const ok = this.soft.upsertProviderProfile(p); if (ok) { const env = { t: "providerProfile" as const, data: p }; this.store.appendEvent(env); this.publish(this.topics.app, env); } return ok; }
  publishRecommendation(rec: ModelRecommendation): boolean { const ok = this.soft.upsertRecommendation(rec); if (ok) { const env = { t: "recommendation" as const, data: rec }; this.store.appendEvent(env); this.publish(this.topics.app, env); } return ok; }
  publishQuery(q: QueryMsg): void { if (this.soft.addQuery(q)) this.publish(this.topics.app, { t: "query", data: q }); }

  /**
   * Bounded wait for a field query to be answered. A query must never hang forever: we poll soft state
   * for at least one collected answer and return as soon as one arrives, or return a clear timed-out
   * result after `timeoutMs`. This is the reliability surface the Console reads so "asking" stops
   * resonating indefinitely. On a single serving node, the miner loop (provider/loop.ts) generates an
   * answer within its poll interval and addAnswer collects it back here, so this resolves promptly with
   * the local answer; on a multi-node field it resolves on the first peer answer that gossips back.
   */
  async awaitQueryAnswer(queryId: string, timeoutMs = QUERY_ANSWER_TIMEOUT_MS): Promise<{ ok: boolean; queryId: string; answers: number; timedOut: boolean; waitedMs: number; reason?: string }> {
    const start = Date.now();
    const deadline = start + Math.max(0, Math.min(timeoutMs, QUERY_ANSWER_MAX_WAIT_MS));
    for (;;) {
      const answers = this.soft.answers.get(queryId) ?? [];
      if (answers.length > 0) return { ok: true, queryId, answers: answers.length, timedOut: false, waitedMs: Date.now() - start };
      if (Date.now() >= deadline) {
        return {
          ok: false, queryId, answers: 0, timedOut: true, waitedMs: Date.now() - start,
          reason: "no answer yet; the field is still resonating. Try again, or check that a serving node (mining with a loaded model or endpoint) is online.",
        };
      }
      await new Promise((r) => setTimeout(r, QUERY_ANSWER_POLL_MS));
    }
  }
  minerAnswered = 0;
  publishAnswer(a: AnswerMsg): boolean { const ok = this.soft.addAnswer(a); if (ok) { this.minerAnswered++; this.publish(this.topics.app, { t: "answer", data: a }); } return ok; }

  // Reserved id prefix every PAID real-user query must carry. Autonomous-coordination query ids are content
  // hashes (hex), so they can never collide with this namespace — which means a charge tx crafted for an
  // autonomous query id (to try to pre-empt or double-settle it) is rejected at ingress AND ignored by the
  // settler. This is the anti-collision guard: real-user settlement only ever touches `ru-` ids.
  static REAL_USER_QUERY_ID_PREFIX = "ru-";

  /** Real-user payout activation epoch. Env-overridable (ZIRA_REAL_USER_PAYOUT_EPOCH) so it can be ARMED
   *  operationally on the settler without a recompile — same approach as the resonator-creation freeze —
   *  falling back to the compiled constant. */
  private realUserPayoutActivationEpoch(): number {
    const env = Number(process.env.ZIRA_REAL_USER_PAYOUT_EPOCH);
    return Number.isFinite(env) && env > 0 ? Math.floor(env) : PROTOCOL.REAL_USER_QUERY_PAYOUT_ACTIVATION_EPOCH;
  }
  /** Whether PAID real-user answering is live right now (activation epoch reached). Dormant => false, and the
   *  whole paid path is skipped, so asking is byte-identical to today. */
  realUserPayoutActive(now = Date.now()): boolean { const act = this.realUserPayoutActivationEpoch(); return act > 0 && epochOf(now) >= act; }

  /** Query-tier pricing activation epoch, env-overridable (ZIRA_QUERY_TIER_EPOCH) for operational arming. */
  private queryTierActivationEpoch(): number {
    const env = Number(process.env.ZIRA_QUERY_TIER_EPOCH);
    return Number.isFinite(env) && env > 0 ? Math.floor(env) : PROTOCOL.QUERY_TIER_PRICING_ACTIVATION_EPOCH;
  }
  /** Price/earn multiplier for a query's work tier (quick 1x / standard 2x / deep 4x), 1x while dormant. Uses
   *  the env-overridable activation epoch so ingress pricing matches whatever the settler is armed to. */
  queryTierMult(chars: number, now = Date.now()): number {
    const act = this.queryTierActivationEpoch();
    if (!(act > 0) || epochOf(now) < act) return 1;
    return PRICING.QUERY_TIER_MULT[queryTier(chars)];
  }

  /** The network coordination wallet an asker funds a paid query into (the settler reads charges back from it). */
  queryChargeWallet(): Address { return settlementWalletsFor(this.genesis.network).network; }

  /** Minimum ZIR to fund a paid real-user query: the base query price scaled by the work tier of the signed
   *  question (quick 1x / standard 2x / deep 4x). Deterministic from the query text + current epoch. */
  queryChargeMinUZIR(q: QueryMsg, now = Date.now()): number {
    const chars = queryComplexityChars(q.question, q.history);
    return Math.round(PROTOCOL.QUERY_PRICE_UZIR * this.queryTierMult(chars, now));
  }

  /**
   * Validate + submit an asker's paid-query charge, tying a real on-chain payment to the query it funds. The
   * charge must be an asker-signed transfer to the network coordination wallet, carry the `query-charge <id>`
   * memo, and meet the tier minimum. On acceptance the settler will later pay the converged answerers a budget
   * equal to the charged amount (convergence policy applied). Returns the accepted budget or a reason.
   */
  acceptQueryCharge(q: QueryMsg, charge: SignedTx): { ok: boolean; reason?: string; amountUZIR?: number } {
    if (!charge || typeof charge !== "object") return { ok: false, reason: "missing query charge" };
    if (!q.id || !q.id.startsWith(ZiraNode.REAL_USER_QUERY_ID_PREFIX)) return { ok: false, reason: `paid query id must start with "${ZiraNode.REAL_USER_QUERY_ID_PREFIX}"` };
    if (charge.to !== this.queryChargeWallet()) return { ok: false, reason: "charge must pay the network coordination wallet" };
    if (charge.from !== q.asker) return { ok: false, reason: "charge must be signed by the asker" };
    if (charge.memo !== ZiraNode.queryChargeMemo(q.id)) return { ok: false, reason: "charge memo must reference this query" };
    const min = this.queryChargeMinUZIR(q);
    if ((charge.amountUZIR ?? 0) < min) return { ok: false, reason: `charge below the tier minimum (${min} uZIR)` };
    const r = this.submitTx(charge);
    if (!r.accepted) return { ok: false, reason: r.reason ?? "charge tx rejected" };
    return { ok: true, amountUZIR: charge.amountUZIR };
  }

  /**
   * Answerer leaderboard — the challenge scoreboard. Derived from ON-CHAIN coordination payouts, so it is
   * globally available on ANY node (including the read gateway), deterministic, and durable — not a
   * settler-local counter. Each settled coordination payout is a `batch_transfer` whose memo carries
   * `k: "coord ..."`; this sums the contributor slice each address earned from those payouts (autonomous +
   * paid real-user answering) over recent history, excluding the protocol network/pool wallets. Ranked by
   * ZIR earned by answering, which is exactly "who did the most paid answering".
   */
  answererLeaderboard(limit = 50, scan = 5000): { address: string; earnedUZIR: number; payouts: number }[] {
    const w = settlementWalletsFor(this.genesis.network);
    const exclude = new Set([w.network, w.resonatorPool, this.genesis.founder]);
    const tally = new Map<string, { earnedUZIR: number; payouts: number }>();
    for (const e of this.state.recentHistory(null, Math.max(100, Math.min(scan, 20000)))) {
      if (e.kind !== "batch_transfer" || typeof e.memo !== "string") continue;
      let parsed: { o?: [string, number][]; k?: string };
      try { parsed = JSON.parse(e.memo); } catch { continue; }
      if (typeof parsed.k !== "string" || !parsed.k.startsWith("coord")) continue;   // coordination payouts only
      for (const [addr, amt] of parsed.o ?? []) {
        if (!/^zir1[0-9a-z]{6,}$/.test(addr) || exclude.has(addr) || !(amt > 0)) continue; // skip protocol wallets
        const row = tally.get(addr) ?? { earnedUZIR: 0, payouts: 0 };
        row.earnedUZIR += amt; row.payouts += 1; tally.set(addr, row);
      }
    }
    return [...tally.entries()].map(([address, v]) => ({ address, earnedUZIR: v.earnedUZIR, payouts: v.payouts }))
      .sort((a, b) => b.earnedUZIR - a.earnedUZIR || (a.address < b.address ? -1 : 1))
      .slice(0, Math.max(1, Math.min(limit, 500)));
  }

  /** One address's earnings from answering the field (coordination payouts), derived on-chain the same way as
   *  the leaderboard. Powers the Mine page "earned from answering" stat. Zeroes if the address never answered. */
  answererEarnings(address: string, scan = 5000): { address: string; earnedUZIR: number; payouts: number } {
    const row = this.answererLeaderboard(500, scan).find((r) => r.address === address);
    return row ?? { address, earnedUZIR: 0, payouts: 0 };
  }

  /**
   * Settle a coordinated query with the §9 four-way split: contributors (77%, by domain ZTI x confidence),
   * the network wallet (8%), the resonator pool (10%), and a burn (5%). This is the multi-LLM coordination
   * money path: many contributors share one query's pay. It moves already-held ZIR from the funding wallet
   * (the asker/founder) via real transfers and a bond_burn for the burn slice; it mints no new ZIR, so PoR
   * emission and the supply cap are untouched. Founder-gated at the RPC layer (the funding wallet is the
   * node identity, which must hold the budget). Returns the split.
   */
  settleQueryCoordination(queryId: string, budgetUZIR: number, opts: { poolBeneficiary?: string; convergencePolicy?: boolean } = {}): { ok: boolean; reason?: string; payouts?: { address: string; amountUZIR: number }[]; networkUZIR?: number; resonatorPoolUZIR?: number; burnUZIR?: number; confidenceScore?: number } {
    const query = this.soft.queries.get(queryId);
    const domain: Domain = query?.domain ?? "general";
    const answers = this.soft.answers.get(queryId) ?? [];
    if (answers.length === 0) return { ok: false, reason: "no answers to settle for this query" };
    if (budgetUZIR <= 0) return { ok: false, reason: "budget must be positive" };
    const funder = this.identity;
    // One contribution per provider (latest), weighted by its domain ZTI x confidence.
    const latest = new Map<string, AnswerMsg>();
    for (const a of [...answers].sort((x, y) => x.ts - y.ts)) latest.set(a.provider, a);
    // F8: a contributor with non-positive confidence did not actually stand behind an answer, so it must
    // not draw a slice of the budget. (A stricter min-confidence floor is the future tightening.)
    const contribAnswers = [...latest.values()].filter((a) => a.confidence > 0);
    // Agreement-with-consensus: each contributor's answer is scored by how much of its significant
    // vocabulary it shares with the OTHER contributors' answers (mean Jaccard overlap). A contributor that
    // diverges from the panel earns little even with high self-confidence, so coordination pay tracks
    // answers the field actually agreed on rather than self-reported confidence. A lone contributor scores 1.
    const contributions = contribAnswers.map((a) => {
      const address = addressFromPubKey(a.provider);
      const acct = this.state.accounts.get(address);
      const domainZti = Math.max(0.05, acct?.ztiByDomain?.[domain] ?? acct?.zti ?? 0.05);
      const agreement = answerAgreement(a.answer, contribAnswers.filter((o) => o.provider !== a.provider).map((o) => o.answer));
      return { address, domainZti, confidence: a.confidence, agreement };
    });
    if (contributions.length === 0) return { ok: false, reason: "no contributions with positive confidence to settle" };
    // Paid real-user answering applies the convergence policy: the full budget when >= REAL_USER_QUERY_CONVERGENCE
    // contributors converged, a reduced fraction for a lone answerer (thin serving pool). Autonomous coordination
    // does NOT pass convergencePolicy, so its settlement is byte-identical to before (its own >=2 model-backed
    // gate lives in settleAutonomousCoordination). Pure + deterministic: the settler applies it before the split.
    const effectiveBudget = opts.convergencePolicy ? convergenceAdjustedBudget(budgetUZIR, contributions.length) : budgetUZIR;
    if (effectiveBudget <= 0) return { ok: false, reason: "convergence-adjusted budget is zero" };
    const split = settleCoordination(effectiveBudget, contributions);
    const wallets = settlementWalletsFor(this.genesis.network);
    const tag = queryId.slice(0, 12);
    // The resonator-pool slice normally accrues to the shared pool wallet, but for autonomous coordination the
    // caller passes the driving resonator's OWNER, so the owner of that autonomous agent earns the pool slice
    // directly (its resonator did the coordination work). Guard it to a real, non-funder address.
    const poolTarget = (opts.poolBeneficiary && /^zir1[0-9a-z]{6,}$/.test(opts.poolBeneficiary))
      ? opts.poolBeneficiary : wallets.resonatorPool;
    // The protocol slices (§9): network wallet, resonator pool. The funder is the asker; when a target
    // equals the funder the slice simply stays put, so we skip that transfer.
    const protocolTransfers: { to: string; amountUZIR: number; memo: string }[] = [];
    if (split.networkUZIR > 0 && wallets.network !== funder.address) protocolTransfers.push({ to: wallets.network, amountUZIR: split.networkUZIR, memo: `coordination network ${tag}` });
    if (split.resonatorPoolUZIR > 0 && poolTarget !== funder.address) protocolTransfers.push({ to: poolTarget, amountUZIR: split.resonatorPoolUZIR, memo: `coordination resonator-pool ${tag}` });
    // ONE batch_transfer covers the whole §9 split (contributors + network + pool as outputs), and the 5%
    // burn slice is folded into the tx FEE (FEE_BURN=1.0 destroys the whole fee). So the entire settlement is
    // a SINGLE settler tx with a SINGLE nonce. The previous N separate agent_spends were the coordination
    // equivalent of the field-participation fork: one dropped tx opened a nonce gap that cascaded, dropped
    // every later settler tx on that node, diverged its state root, and FROZE quorum finality. A single tx
    // has no gap to cascade — applied byte-identically by every node (batch_transfer is a consensus kind).
    const credits = new Map<string, number>();
    for (const p of split.payouts) if (p.amountUZIR > 0) credits.set(p.address, (credits.get(p.address) ?? 0) + p.amountUZIR);
    for (const t of protocolTransfers) if (t.amountUZIR > 0) credits.set(t.to, (credits.get(t.to) ?? 0) + t.amountUZIR);
    const outputs: [string, number][] = [...credits.entries()].filter(([a]) => /^zir1[0-9a-z]{6,}$/.test(a));
    if (outputs.length === 0) return { ok: false, reason: "no positive-value coordination outputs to settle" };
    const outSum = outputs.reduce((s, [, a]) => s + a, 0);
    const fee = Math.max(PROTOCOL.BASE_FEE_UZIR, split.burnUZIR); // the §9 burn IS the fee (all burned)
    if (this.state.provisionalBalance(funder.address) < outSum + fee) return { ok: false, reason: "funding wallet has insufficient balance for the coordination payout" }; // provisional: don't over-commit across this tick's pooled payouts (a later overspend drop would still mark the query settled)
    const now = Date.now();
    const tx = signTx({
      network: this.genesis.network, from: funder.address, fromPubKey: funder.publicKey, to: funder.address,
      amountUZIR: outSum, feeUZIR: fee, nonce: this.state.provisionalNonce(funder.address), kind: "batch_transfer",
      parents: [], timestamp: now, memo: JSON.stringify({ o: outputs, k: `coord ${tag} ${domain}` }),
    }, funder.privateKey);
    const res = this.submitTx(tx);
    const paid = res.accepted ? split.payouts.filter((p) => p.amountUZIR > 0).map((p) => ({ address: p.address, amountUZIR: p.amountUZIR })) : [];
    return { ok: res.accepted, reason: res.accepted ? undefined : res.reason, payouts: paid, networkUZIR: split.networkUZIR, resonatorPoolUZIR: split.resonatorPoolUZIR, burnUZIR: split.burnUZIR, confidenceScore: split.confidenceScore };
  }
  private publishModelAnnounce(a: ModelAnnounce): void {
    const env: Envelope = { t: "model", data: a };
    const key = `${a.meta.id}:${a.peerId}`;
    if (!this.modelAnnounceKeys.has(key)) {
      this.modelAnnounceKeys.add(key);
      this.store.appendEvent(env);
    }
    this.publish(this.topics.app, env);
  }
  myBalance(): number { return this.state.balanceOf(this.identity.address); }

  /** The labeled project wallets the steward administers, each with its live on-ledger balance. Public,
   *  read-only ledger data (no keys); the Console Treasury card renders it. */
  treasury(): { network: string; wallets: { key: string; label: string; address: string; role: string; uZIR: number }[] } {
    const wallets = treasuryWalletsFor(this.genesis.network).map((w) => ({
      ...w, uZIR: this.state.balanceOf(w.address),
    }));
    return { network: this.genesis.network, wallets };
  }

  founderAddresses(): string[] {
    return this.state.activeFounderAddresses();
  }
  isFounder(): boolean { return this.founderAddresses().includes(this.identity.address); }

  /**
   * The steward capability surface (assign/transfer anchor positions + resonators, manage/add models,
   * seed network/anchor resonators, coordinate/settle) is gated to the steward identity: an active
   * founder, or a node holding a steward operator key (the anchor-reserve wallet or the events wallet).
   * Use this to gate steward-only RPC routes consistently alongside isFounder().
   */
  canSteward(): boolean {
    if (this.isFounder()) return true;
    if (this.anchorReserveKp && this.anchorReserveKp.address === this.identity.address) return true;
    if (this.eventsKp && this.eventsKp.address === this.identity.address) return true;
    // A node configured with the anchor-reserve key is the steward operator for anchor positions even
    // when its node identity differs (the reserve wallet signs its own anchor operations).
    return Boolean(this.anchorReserveKp);
  }

  /**
   * Authorize a steward action by SIGNATURE instead of by this node holding the key. The Console signs a
   * fresh challenge ("zira-steward:<ms>[:action]") with the loaded steward wallet; ANY node — including a
   * keyless public gateway — can then authorize the action by verifying the signature is by a founder-
   * address wallet and the challenge is recent. This lets the steward toggle the anchor event and other
   * steward controls through the gateway WITHOUT ever placing the steward private key on the server.
   */
  verifyStewardSig(pubKey?: string, challenge?: string, sig?: string): boolean {
    if (!pubKey || !challenge || !sig) return false;
    const m = /^zira-steward:(\d+)(?::.*)?$/.exec(challenge);
    if (!m) return false;
    const ts = Number(m[1]);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 120_000) return false; // 2-minute freshness window
    try {
      if (!edVerify(challenge, sig, pubKey)) return false;
      const addr = addressFromPubKey(pubKey);
      if (this.founderAddresses().includes(addr)) return true;
      // Also accept the steward OPERATOR wallets (anchor-reserve, events, steward ops) — the user may
      // load any of them, not just a founder key. The settlement sinks have no signer and are excluded.
      return treasuryWalletsFor(this.genesis.network)
        .filter((w) => w.key === "steward" || w.key === "anchorReserve" || w.key === "events")
        .some((w) => w.address === addr);
    } catch { return false; }
  }

  // ---- views ----

  stats(): NetworkStats & { version: string; peers: number; finalizedEpoch: number; stateRoot: string; pool: { txs: number; observations: number }; models: number; mastersCount: number; isFounder: boolean; founderAddress: string; founderAddresses: string[] } {
    const now = Date.now();
    const accounts = [...this.state.accounts.values()];
    const ztis = accounts.filter((a) => a.zti > 0).map((a) => a.zti);
    const avgZti = ztis.length ? ztis.reduce((s, z) => s + z, 0) / ztis.length : 0;
    const issued = PROTOCOL.RESERVE_UZIR + this.state.supply.emitted;
    return {
      // Release version, exposed so the Console can negotiate features against older nodes (upgrade
      // without ruptures). Tracks the node package version / installer release (bump per release).
      version: NODE_RELEASE_VERSION,
      network: this.genesis.network,
      phase: "live",
      providersOnline: this.soft.onlineProviders(now).length,
      activeNodes: this.net.peerCount() + 1,
      avgZti: Number(avgZti.toFixed(4)),
      locksPerMinute: this.state.recentLocks(200).filter((l) => now - l.sealedAt < 60000).length,
      circulatingUZIR: issued - this.state.supply.burned,
      emittedUZIR: this.state.supply.emitted,
      burnedUZIR: this.state.supply.burned,
      reserveUZIR: this.state.supply.reserve,
      peers: this.net.peerCount(),
      finalizedEpoch: this.checkpoints.lastFinalizedEpoch,
      currentEpoch: this.state.lastProcessedEpoch,
      stateRoot: this.state.stateRoot(),
      pool: this.state.poolSize(),
      models: this.models.knownModels().length,
      mastersCount: this.state.masters().length,
      isFounder: this.isFounder(),
      founderAddress: this.genesis.founder,
      founderAddresses: this.founderAddresses(),
      role: this.nodeRole(),
    } as NetworkStats & { version: string; peers: number; finalizedEpoch: number; stateRoot: string; pool: { txs: number; observations: number }; models: number; mastersCount: number; isFounder: boolean; founderAddress: string; founderAddresses: string[]; role: "consensus" | "worker" };
  }

  private persistSnapshot(): void {
    try {
      this.store.writeSnapshot(this.state.snapshot());
      this.compactEventLog(false);
    } catch (e) { log.warn("snapshot failed", (e as Error).message); }
  }

  /**
   * Compact events.jsonl to just the recent unsettled replay window. The snapshot holds all APPLIED state, so
   * only events newer than (snapshotEpoch - SETTLE_ROUNDS - cushion) are needed to restart on top of it;
   * everything older is redundant. Without this the log grows without bound — re-gossiped duplicate txs keep
   * re-appending as their ids cycle out of the bounded dedup cache — until it exceeds Node's ~512MB max STRING
   * length and the node cannot boot at all (readFileSync throws ERR_STRING_TOO_LONG), AND startup replay of a
   * huge log stalls before RPC binds. Called at startup (force) and after each snapshot (size-gated). Only
   * safe when a snapshot exists (a fresh node replaying from genesis needs its full history).
   */
  private compactEventLog(force: boolean): void {
    if (!force && this.store.eventsSizeBytes() <= EVENTS_COMPACT_THRESHOLD_BYTES) return;
    const keepFrom = this.state.lastProcessedEpoch - SETTLE_ROUNDS - EVENTS_KEEP_CUSHION_EPOCHS;
    const res = this.store.compactEvents((env) => {
      if (env.t === "tx" || env.t === "observation") {
        const ts = (env.data as { timestamp?: number } | undefined)?.timestamp;
        return typeof ts !== "number" || epochOf(ts) >= keepFrom;
      }
      if (env.t === "checkpoint") {
        const ep = (env.data as { epoch?: number } | undefined)?.epoch;
        return typeof ep !== "number" || ep >= keepFrom;
      }
      return true; // rare structural events (resonator/task/model/providerProfile/recommendation): keep
    });
    if (res.dropped > 0) log.info(`compacted event log: kept ${res.kept}, dropped ${res.dropped} stale events`);
  }

  identityAddress(): string { return this.identity.address; }
  durableTxLog(): SignedTx[] {
    return this.store.readEvents().filter((e) => e.t === "tx").map((e) => e.data as SignedTx);
  }
  durableSupplyAudit(): { emitted: number; burned: number; reserve: number; issued: number; circulating: number; withinCap: boolean } {
    const replay = new State(this.genesis, this.decentralizationActivationEpoch);
    for (const env of this.store.readEvents()) {
      if (env.t === "tx") replay.ingestTx(env.data);
      else if (env.t === "observation") replay.ingestObservation(env.data);
    }
    replay.advance(Date.now() + PROTOCOL.ACCOUNTING_ROUND_MS * 3);
    const issued = PROTOCOL.RESERVE_UZIR + replay.supply.emitted;
    return {
      emitted: replay.supply.emitted,
      burned: replay.supply.burned,
      reserve: replay.supply.reserve,
      issued,
      circulating: issued - replay.supply.burned,
      withinCap: issued <= PROTOCOL.MAX_SUPPLY_UZIR,
    };
  }
  netInfo(): { peerId: string; addrs: string[]; peers: number; savedPeers: string[]; connections: { peerId: string; addr: string; direction: string }[] } {
    return { peerId: this.net.peerId(), addrs: this.net.multiaddrs(), peers: this.net.peerCount(), savedPeers: this.savedPeers(), connections: this.net.connections?.() ?? [] };
  }

  bootstrapSeedCandidates(opts: { publicHost?: string; publicHostType?: string; publicP2pPort?: number } = {}): { isFounder: boolean; candidates: BootstrapSeedCandidate[] } {
    if (!this.isFounder()) return { isFounder: false, candidates: [] };
    const out: BootstrapSeedCandidate[] = [];
    const sourceScore: Record<BootstrapSeedCandidate["source"], number> = { self: 120, connected: 90, storage: 70, saved: 40 };
    const roleScore = (roles: string[]) => roles.reduce((score, role) => {
      const normalized = role.toLowerCase();
      if (normalized === "master" || normalized === "master-node") return score + 40;
      if (normalized === "master-candidate") return score + 25;
      if (normalized === "bootstrap") return score + 15;
      if (normalized === "community-seed") return score + 5;
      return score;
    }, 0);
    const add = (multiaddr: string, candidate: Omit<BootstrapSeedCandidate, "multiaddr" | "shareable" | "eligible" | "status" | "reason" | "score">) => {
      const value = normalizeSeedMultiaddr(multiaddr);
      if (!value || out.some((seed) => seed.multiaddr === value)) return;
      const shareable = isPublicSeedMultiaddr(value);
      const score = sourceScore[candidate.source] + roleScore(candidate.roles) - candidate.priority;
      out.push({
        ...candidate,
        multiaddr: value,
        shareable,
        eligible: shareable,
        status: shareable ? "public-unchecked" : "local",
        reason: shareable
          ? "Public-looking TCP seed. Check reachability before publishing."
          : "Local, LAN, loopback, websocket, or non-public address excluded from founder registry downloads.",
        score,
      });
    };

    const publicHost = opts.publicHost?.trim();
    if (publicHost) {
      const kind = opts.publicHostType === "dns4" || opts.publicHostType === "dns6" || opts.publicHostType === "ip6" ? opts.publicHostType : "ip4";
      const port = opts.publicP2pPort ?? 9645;
      add(`/${kind}/${publicHost}/tcp/${port}/p2p/${this.net.peerId()}`, {
        label: "Steward public bootstrap",
        roles: ["master", "bootstrap", "community-seed"],
        source: "self",
        priority: 1,
      });
    }
    for (const addr of this.net.multiaddrs()) {
      add(addr, { label: "Steward advertised bootstrap", roles: ["master", "bootstrap", "community-seed"], source: "self", priority: 2 });
    }
    for (const addr of this.net.peerMultiaddrs?.() ?? []) {
      add(addr, { label: "Connected field peer", roles: ["master-candidate", "bootstrap", "community-seed"], source: "connected", priority: 10 });
    }
    for (const addr of this.storagePeers()) {
      add(addr, { label: "Assigned storage peer", roles: ["master-candidate", "bootstrap", "community-seed"], source: "storage", priority: 20 });
    }
    for (const addr of this.savedPeers()) {
      add(addr, { label: "Saved peer", roles: ["community-seed"], source: "saved", priority: 30 });
    }
    out.sort((a, b) => Number(b.eligible) - Number(a.eligible) || Number(b.shareable) - Number(a.shareable) || b.score - a.score || a.priority - b.priority || a.multiaddr.localeCompare(b.multiaddr));
    return { isFounder: true, candidates: out };
  }

  // ---- peers: connect to other nodes the user pastes in, and remember them ----

  private peersPath(): string { return join(this.dataDir, "peers.json"); }
  private savedPeers(): string[] {
    try {
      if (existsSync(this.peersPath())) {
        const parsed = JSON.parse(readFileSync(this.peersPath(), "utf8"));
        if (Array.isArray(parsed)) return [...new Set(parsed.map((p) => String(p).trim()).filter((p) => p.startsWith("/") && p.includes("/p2p/")))];
      }
    } catch { /* */ }
    return [];
  }
  private async dialSavedPeers(): Promise<void> {
    // Dial all saved peers in PARALLEL: an unreachable peer must not block dialing the rest, so a node
    // reaches MULTIPLE peers quickly instead of stalling on the first slow/dead address.
    await Promise.allSettled(this.savedPeers().map(async (addr) => {
      try { await this.net.dial(addr); log.info("dialed saved peer", addr.slice(-16)); }
      catch (e) { log.debug("saved peer dial failed", addr.slice(-16), (e as Error).message); }
    }));
  }
  rememberPeers(addrs: string[]): void {
    const current = this.savedPeers();
    let changed = false;
    for (const addr of addrs) {
      const trimmed = addr.trim();
      if (!trimmed.startsWith("/") || !trimmed.includes("/p2p/") || current.includes(trimmed)) continue;
      current.push(trimmed);
      changed = true;
    }
    if (changed) {
      mkdirSync(this.dataDir, { recursive: true });
      writeFileSync(this.peersPath(), JSON.stringify(current, null, 2));
    }
  }
  /** Connect to a node by multiaddr now and remember it for next time. */
  async addPeer(addr: string): Promise<{ ok: boolean; reason?: string }> {
    const trimmed = addr.trim();
    if (!trimmed.startsWith("/")) return { ok: false, reason: "expected a multiaddr like /dns4/host/tcp/9645/p2p/<peerId>" };
    try {
      await this.net.dial(trimmed);
      const peers = this.savedPeers();
      if (!peers.includes(trimmed)) { peers.push(trimmed); writeFileSync(this.peersPath(), JSON.stringify(peers, null, 2)); }
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }

  // ---- storage: launch authority may assign backbone hosts, and every ordinary node starts as a
  // small capped P2P storage peer unless the user disables storage or lowers its local cap.
  private storagePath(): string { return join(this.dataDir, "storage-peers.json"); }
  storagePeers(): string[] {
    try { if (existsSync(this.storagePath())) return JSON.parse(readFileSync(this.storagePath(), "utf8")); } catch { /* */ }
    return [];
  }
  setStoragePeers(peers: string[]): { ok: boolean; reason?: string; peers?: string[] } {
    if (!this.isFounder()) return { ok: false, reason: "only active launch authority can assign storage peers" };
    const clean = [...new Set(peers.map((p) => p.trim()).filter((p) => p.startsWith("/")))];
    writeFileSync(this.storagePath(), JSON.stringify(clean, null, 2));
    return { ok: true, peers: clean };
  }

  // ---- active launch-authority delegation: extra stewardship wallet addresses recorded by authority
  // These addresses can use stewardship tools on this node, including reserve allocation, model provision,
  // storage policy, and adding/removing other delegated founder addresses.
  private founderBackupsPath(): string { return join(this.dataDir, "founder-backups.json"); }
  founderBackups(): string[] {
    if (this.genesis.network === "mainnet") return [];
    try { if (existsSync(this.founderBackupsPath())) return JSON.parse(readFileSync(this.founderBackupsPath(), "utf8")); } catch { /* */ }
    return [];
  }
  setFounderBackups(addresses: string[]): { ok: boolean; reason?: string; addresses?: string[] } {
    if (this.genesis.network === "mainnet") return { ok: false, reason: "mainnet stewardship delegation needs signed ledger events; local backups are disabled" };
    if (!this.isFounder()) return { ok: false, reason: "only active launch authority can assign stewardship addresses" };
    const clean = [...new Set(addresses.map((a) => a.trim()).filter((a) => a.startsWith("zir1") && a !== this.genesis.founder))];
    writeFileSync(this.founderBackupsPath(), JSON.stringify(clean, null, 2));
    this.state.setAuthorizedFounders([...this.state.activeFounderAddresses(), ...clean]);
    return { ok: true, addresses: clean };
  }

  // ---- fresh start: wipe local node state, then exit so the supervisor restarts from genesis.
  // Ordinary resets keep model caches; set ZIRA_DEEP_RESET=1 for a full heavy-byte wipe.
  wipeAndExit(): void {
    const resetFiles = ["events.jsonl", "snapshot.json", "mining.json", "provider.json", "storage-peers.json", "founder-backups.json", "zti-history.jsonl", "peers.json", "identity.json", "peer-key.bin"];
    if (process.env.ZIRA_DEEP_RESET === "1") resetFiles.push("models");
    for (const f of resetFiles) {
      try { rmSync(join(this.dataDir, f), { recursive: true, force: true }); } catch { /* */ }
    }
    log.warn(process.env.ZIRA_DEEP_RESET === "1" ? "admin reset: local node state and model cache wiped, restarting fresh from genesis" : "admin reset: local node state wiped, model cache kept, restarting fresh from genesis");
    setTimeout(() => process.exit(0), 120);
  }
}
