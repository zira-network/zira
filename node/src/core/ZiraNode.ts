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
} from "@zira/protocol";
import { settlementWalletsFor, treasuryWalletsFor } from "../genesis-docs.js";
import { launchModelsFor } from "../launch-models.js";
import { verifyContribution, type WatchNetwork } from "../anchor/paymentWatcher.js";
import { State, epochOf } from "./State.js";
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
import { topics as buildTopics, SNAPSHOT_PROTOCOL } from "../p2p/topics.js";
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

// Master-created earning txs (storage_attest credit + autonomous coordination payout from genesis masters)
// are OFF by default. They are created continuously per-master from local soft state and, in practice,
// make the per-epoch state diverge across masters (different masters include slightly different tx sets per
// epoch), which breaks quorum finality (it freezes once the chain catches up to real time). Until the
// credit is carried deterministically inside the heartbeat observation (verified identically by every node),
// keep these off so finality stays byte-identical and real-time. The founder/steward path is unaffected.
const MASTER_EARN_TX = (process.env.ZIRA_MASTER_EARN_TX ?? "0") === "1";
const AUTONOMOUS_RESONATOR_DELIVER_MS = envMs("ZIRA_AUTONOMOUS_RESONATOR_DELIVER_MS", 10_000);
const AUTONOMOUS_RESONANCE_CYCLE_MS = envMs("ZIRA_AUTONOMOUS_RESONANCE_CYCLE_MS", 5 * 60_000);
const AUTONOMOUS_RESONANCE_SETTLE_MS = envMs("ZIRA_AUTONOMOUS_RESONANCE_SETTLE_MS", 30_000);
const AUTONOMOUS_RESONANCE_MIN_ANSWERS = envInt("ZIRA_AUTONOMOUS_RESONANCE_MIN_ANSWERS", 2);
const AUTONOMOUS_RESONANCE_MAX_PER_CYCLE = envInt("ZIRA_AUTONOMOUS_RESONANCE_MAX_PER_CYCLE", 2);
const AUTONOMOUS_RESONANCE_TASK_UZIR = envInt("ZIRA_AUTONOMOUS_RESONANCE_TASK_UZIR", 0);
// Real per-query coordination reward paid by the steward/founder funding wallet to the providers that
// contributed accepted answers to an autonomous-resonance query. This is the money path that makes a
// MINING node actually earn ZIR via Proof of Resonance + coordination: when its accepted work converges
// a query, its balance grows from this payout (split by domain ZTI x confidence, minus the small
// steward-ops share). It moves already-allocated founder-ops ZIR — it mints no new ZIR, so emission and
// the supply cap are untouched. Set to 0 to disable automatic coordination payouts.
const AUTONOMOUS_COORDINATION_REWARD_UZIR = envInt("ZIRA_AUTONOMOUS_COORDINATION_REWARD_UZIR", 500_000); // 0.5 ZIR default
// Field heartbeat: how often a contributing (mining or storage) node attests it is up + serving, so the
// PoR field forms Locks and the round emission flows to contributors. Frequent enough that every
// contributor always has a fresh in-window observation. This is the inference-free "mining/storage earns"
// path (the whitepaper's mining reward); paid inference coordination earns on top of it.
const FIELD_HEARTBEAT_INTERVAL_MS = envMs("ZIRA_FIELD_HEARTBEAT_MS", 30_000);
const FIELD_HEARTBEAT_SUBJECT = PROTOCOL.FIELD_HEARTBEAT_SUBJECT;  // shared so the work-gate matches exactly
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

  // The snapshot content must hash to the finalized root; binds the state to the checkpoint.
  const root = computeStateRoot(
    best.snapshot.accounts as AccountLeaf[], best.snapshot.supply,
    best.snapshot.founders ?? [], best.snapshot.anchors ?? [],
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
  const masterByPub = new Map<string, SnapAccount>();
  let totalMaster = 0;
  for (const a of best.snapshot.accounts) {
    if (!a.isMaster || !a.pubkey) continue;
    if (gatedMasters && !genesisMasterAddrs.has(a.address)) continue;
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
  // Steward Anchor Event toggle (spec §2.1 / §6.2). When off (the default), the anchor contribute section
  // is absent for every connected user; when on, the contribute flow is live. Steward-gated at the RPC
  // layer. In-memory like the events toggle: the steward/gateway node holds it and serves it to clients.
  private anchorEventEnabled = false;
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
    };
    this.state = new State(genesis);
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
    if (r.accepted) this.eventsClaimed.set(address, 1);
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
    let replayed = 0;
    for (const env of this.store.readEvents()) { this.ingest(env, false); replayed++; }
    if (replayed) log.info(`replayed ${replayed} durable events`);
    // Re-hydrate the steward-run anchor event + contribution queue (non-consensus), so a gateway restart
    // does not switch the event off for everyone or drop contributions the steward still owes seats for.
    this.restoreAnchorState();
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
    const redialTarget = envInt("ZIRA_PEER_REDIAL_TARGET", 4);
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

  /** Start or restart the Tier 2 inference provider with the given config. */
  startProvider(config: ProviderConfig): void {
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
      if (e.to === this.identity.address && (e.kind === "reward" || e.kind === "agent_spend" || launchMiningSettlement) && e.timestamp >= since) earnedTodayUZIR += e.amountUZIR;
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
  pricing(): { queryUZIR: number; taskBaseUZIR: number; resonatorCreationUZIR: number; openQueries: number; providersOnline: number } {
    const now = Date.now();
    const providersOnline = this.soft.onlineProviders(now).length;
    const openQueries = this.soft.openQueries([], now).length;
    return {
      queryUZIR: adaptiveQueryPriceUZIR({ openQueries, providersOnline }),
      taskBaseUZIR: adaptiveTaskPriceUZIR({ openQueries, providersOnline }),
      // Cost to create (fund) a new Resonator, surfaced so the Console shows the same canonical floor.
      resonatorCreationUZIR: PROTOCOL.RESONATOR_CREATION_COST_UZIR,
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

  private tick(): void {
    const now = Date.now();
    const advanced = this.state.advance(now);
    if (advanced > 0) this.voteCheckpoints(now);
    this.maybeResyncOnStall(now);   // finality watchdog: self-heal if finalizedEpoch freezes behind the mesh
    this.soft.prune(now);
    // periodically re-gossip pending events so peers converge despite gossipsub mesh races and
    // late joiners. Cheap: the pool is small and drains every epoch.
    this.regossipEvery = (this.regossipEvery + 1) % 4;
    if (this.regossipEvery === 0) {
      const pool = this.state.poolEvents(50);
      for (const tx of pool.txs) this.publish(this.topics.events, { t: "tx", data: tx });
      for (const o of pool.observations) this.publish(this.topics.events, { t: "observation", data: o });
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
    if (now - this.lastReapAt >= this.opts.taskReapMs) { this.lastReapAt = now; this.reapTasks(now); this.coordinateAutonomousResonance(now); }
    // Field heartbeat: contributing (mining/storage) nodes attest participation so PoR Locks form and the
    // round emission flows to them (storage-weighted). Self-throttled to FIELD_HEARTBEAT_INTERVAL_MS.
    this.contributeFieldHeartbeat(now);
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
  private static VOUCH_FRESH_MS = 120_000;   // vouch a peer for ~2 min after a successful probe

  private async runStorageProbe(): Promise<void> {
    if (this.storageProbeBusy) return;
    const me = this.state.accounts.get(this.identity.address);
    if (!(this.state.isGenesisMaster(this.identity.address) || (me?.isMaster ?? false))) return;  // only masters vouch
    const modelId = this.models.localHeldModelId();
    if (!modelId) { log.debug("storage-proof: no model held locally yet; skipping probe"); return; }
    const peers = this.models.peersServing(modelId).slice(0, 16);   // bound work per round
    if (peers.length === 0) { log.debug(`storage-proof: no peers advertising model ${modelId.slice(0, 12)} to probe yet`); return; }
    this.storageProbeBusy = true;
    try {
      const now = Date.now();
      let verified = 0;
      for (const { peerId, address } of peers) {
        try { if (await this.models.verifyPeerStorage(peerId, modelId)) { this.verifiedMiners.set(address, now); verified++; } }
        catch { /* unreachable peer: skip */ }
      }
      // prune stale entries so the vouch set stays current and bounded
      for (const [a, ts] of this.verifiedMiners) if (now - ts > ZiraNode.VOUCH_FRESH_MS) this.verifiedMiners.delete(a);
      if (verified > 0) log.info(`storage-proof: verified ${verified} peer(s) hold model ${modelId.slice(0, 12)} -> vouching in heartbeat`);
    } finally {
      this.storageProbeBusy = false;
    }
  }

  /** The miners this master currently vouches for (verified within the freshness window), for the heartbeat. */
  private freshVouchedMiners(now: number): string[] {
    const out: string[] = [];
    for (const [a, ts] of this.verifiedMiners) if (now - ts <= ZiraNode.VOUCH_FRESH_MS) out.push(a);
    return out;
  }
  private lastAutonomousResonanceBucket = -1;
  private lastHeartbeatBucket = -1;

  /**
   * Field heartbeat (the inference-free "mining/storage earns" path). A contributing node — one that is
   * mining OR serving storage — periodically submits a signed observation attesting that the field is
   * operational and it is participating, carrying its served-storage size. When >= MIN_OBSERVATIONS such
   * contributors converge on the same value, the PoR field seals a Lock and the round emission is split
   * among them, weighted by storage (storageRewardMultiplier). So simply mining/storing earns from day one,
   * and paid inference coordination earns ON TOP. The steward/founder never farms this. Mints nothing
   * beyond the emission curve (it only activates the scheduled emission), so the supply cap is unchanged.
   */
  private contributeFieldHeartbeat(now: number): void {
    if (this.isFounder()) return;                                   // the launch authority does not farm emission
    if (!this.models.miningEnabled() && !this.models.storageState().enabled) return; // only contributing nodes
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

    let released = 0;
    for (const settleBucket of [bucket, bucket - 1]) {
      if (settleBucket < 0) continue;
      const bucketStart = settleBucket * AUTONOMOUS_RESONANCE_CYCLE_MS;
      if (now < bucketStart + AUTONOMOUS_RESONANCE_SETTLE_MS) continue;
      for (const resonator of this.autonomousResonanceBatch(mine, settleBucket)) {
        const task = this.autonomousResonanceTask(resonator, settleBucket, now);
        if (task && this.publishTask(task)) released++;
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

  private settledCoordinationQueries = new Set<string>();
  /**
   * Pay the providers who contributed accepted answers to an autonomous-resonance query. Only the
   * funding wallet (the founder/steward node whose identity is the query asker) can fund it, and only
   * once per query. The payout is the configured per-query coordination reward, drawn from the founder's
   * already-allocated balance via settleQueryCoordination — no new ZIR is minted.
   */
  private settleAutonomousCoordination(resonatorId: string, bucket: number): void {
    if (AUTONOMOUS_COORDINATION_REWARD_UZIR <= 0) return;
    // The founder/steward always may settle. A genesis master may too, but ONLY when master-earn txs are
    // enabled — by default they are off, because master-created payout txs diverge per-epoch across masters
    // and freeze quorum finality. The founder/steward path stays available (single funder = deterministic).
    const isMasterFunder = this.state.isGenesisMaster(this.identity.address);
    if (this.identity.address !== this.genesis.founder && !(isMasterFunder && MASTER_EARN_TX)) return;
    const queryId = this.autonomousResonanceQueryId(resonatorId, bucket);
    if (this.settledCoordinationQueries.has(queryId)) return;
    const raw = this.soft.answers.get(queryId) ?? [];
    const answers = this.modelBackedProviderAnswers(raw);
    if (answers.length < AUTONOMOUS_RESONANCE_MIN_ANSWERS) {
      if (raw.length > 0) log.debug(`autonomous coordination: ${queryId.slice(0, 16)} has ${raw.length} answer(s), ${answers.length} model-backed; need ${AUTONOMOUS_RESONANCE_MIN_ANSWERS} to pay`);
      return;
    }
    const result = this.settleQueryCoordination(queryId, AUTONOMOUS_COORDINATION_REWARD_UZIR);
    if (result.ok) {
      this.settledCoordinationQueries.add(queryId);
      // bound the dedup set: keep only the most recent ids (autonomous queries are bucketed, so this is
      // ample headroom and prevents unbounded growth on a long-running node).
      if (this.settledCoordinationQueries.size > 5000) {
        const keep = [...this.settledCoordinationQueries].slice(-2500);
        this.settledCoordinationQueries = new Set(keep);
      }
      log.info(`coordination payout for query ${queryId.slice(0, 12)}: ${result.payouts?.length ?? 0} contributors, network ${result.networkUZIR ?? 0}, pool ${result.resonatorPoolUZIR ?? 0}, burn ${result.burnUZIR ?? 0}`);
    }
  }

  private autonomousResonanceEligible(): Resonator[] {
    return [...this.soft.resonators.values()]
      .filter((r) => r.listed && r.resonanceEnabled && r.status !== "paused" && (r.balanceUZIR ?? 0) > 0)
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, 12);
  }

  /**
   * The subset of eligible resonators THIS node funds. The founder/steward drives all of them; a genesis
   * master drives only its own shard (resonator hashed to this master's index in the genesis master set),
   * so the masters split the work and never settle the same query twice. Any other node drives none.
   */
  private autonomousResonanceDriven(eligible: Resonator[]): Resonator[] {
    if (this.identity.address === this.genesis.founder) return eligible;
    const masters = (this.genesis.masters ?? []).map((m) => m.address);
    const idx = masters.indexOf(this.identity.address);
    if (idx < 0 || masters.length === 0) return [];
    return eligible.filter((r) => {
      let h = 0; for (let i = 0; i < r.id.length; i++) h = (h * 31 + r.id.charCodeAt(i)) >>> 0;
      return h % masters.length === idx;
    });
  }

  private autonomousResonanceBatch(resonators: Resonator[], bucket: number): Resonator[] {
    if (resonators.length <= AUTONOMOUS_RESONANCE_MAX_PER_CYCLE) return resonators;
    const start = (bucket * AUTONOMOUS_RESONANCE_MAX_PER_CYCLE) % resonators.length;
    return Array.from({ length: AUTONOMOUS_RESONANCE_MAX_PER_CYCLE }, (_, i) => resonators[(start + i) % resonators.length]!);
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
      "Act as part of ZIRA's multi-intelligence neural economy: coordinate models, miners, storage, Resonators, tasks, trust, and continuity.",
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
    const budgetUZIR = Math.min(
      AUTONOMOUS_RESONANCE_TASK_UZIR,
      Math.max(0, resonator.spendLimits?.perTxUZIR ?? AUTONOMOUS_RESONANCE_TASK_UZIR),
      Math.max(0, resonator.balanceUZIR ?? 0),
    );
    void now;
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
    const me = this.state.accounts.get(this.identity.address);
    if (!me || !me.isMaster) return;
    const epoch = this.state.lastProcessedEpoch;
    if (epoch <= this.lastVotedEpoch) return;
    this.lastVotedEpoch = epoch;
    const root = this.state.stateRoot();
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
        const fin = this.checkpoints.receiveVote(env.data, this.state.totalMasterTrust(), this.state.masterZtiMap());
        this.store.appendEvent(env);
        void fin;
        return { ok: true, isNew: true };
      }
      case "resonator": {
        const isNew = this.soft.upsertResonator(env.data);
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
  private startedFresh = false;
  // Finality watchdog (auto-resync). If finalizedEpoch freezes while the chain clock keeps moving, the node
  // re-adopts a current, verified peer snapshot, the same self-heal a fresh node uses on join. Conservative
  // thresholds avoid false triggers during normal brief settling.
  private lastFinalizedSeen = -1;
  private finalizedProgressAt = 0;
  private resyncInFlight = false;
  private lastResyncAt = 0;
  private readonly resyncStallMs = 30_000;     // finalizedEpoch must stay frozen this long to count as stalled
  private readonly resyncMinGap = 5;           // and the processed head must be at least this far ahead
  private readonly resyncCooldownMs = 90_000;  // and at most one resync attempt per this window

  /** Serve our finalized state snapshot to a joining peer, with the finalized checkpoint it sits on. */
  private async *serveSnapshot(): AsyncIterable<Uint8Array> {
    yield enc.encode(JSON.stringify({
      snapshot: this.state.snapshot(),
      finalizedEpoch: this.checkpoints.lastFinalizedEpoch,
      finalizedRoot: this.checkpoints.lastFinalizedRoot,
      votes: this.checkpoints.finalizingVotes(this.checkpoints.lastFinalizedEpoch, this.checkpoints.lastFinalizedRoot),
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
        log.warn("fast-sync: snapshot failed checkpoint verification, replaying from genesis");
        this.fastSynced = true;
        return;
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
    if (fin > this.lastFinalizedSeen) { this.lastFinalizedSeen = fin; this.finalizedProgressAt = now; return; }
    if (this.finalizedProgressAt === 0) { this.finalizedProgressAt = now; return; } // arm on first observation
    if (now - this.finalizedProgressAt < this.resyncStallMs) return;
    if (this.state.lastProcessedEpoch - fin < this.resyncMinGap) return;
    if (this.net.peerCount() === 0) return;
    if (this.resyncInFlight || now - this.lastResyncAt < this.resyncCooldownMs) return;
    this.lastResyncAt = now;
    log.warn(`finality stalled: finalizedEpoch ${fin} unchanged for ${Math.round((now - this.finalizedProgressAt) / 1000)}s (processed ${this.state.lastProcessedEpoch}); attempting resync from peers`);
    void this.attemptResyncFromPeers();
  }

  /** Adopt the most-advanced verified peer snapshot to recover from a finality stall. See maybeResyncOnStall. */
  private async attemptResyncFromPeers(): Promise<void> {
    if (this.resyncInFlight) return;
    this.resyncInFlight = true;
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
      log.info(`resynced past finality stall: adopted verified snapshot at finalized epoch ${best.finalizedEpoch} (dropped ${dropped.txs} txs/${dropped.observations} obs already in snapshot); finality resuming`);
    } finally {
      this.resyncInFlight = false;
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
  submitObservation(o: SignedObservation): { accepted: boolean; reason?: string } {
    const r = this.state.ingestObservation(o);
    if (r.ok && r.isNew) { this.store.appendEvent({ t: "observation", data: o }); this.publish(this.topics.events, { t: "observation", data: o }); }
    return { accepted: r.ok, reason: r.reason };
  }
  publishResonator(r: Resonator): boolean { const ok = this.soft.upsertResonator(r); if (ok) { const env = { t: "resonator" as const, data: r }; this.store.appendEvent(env); this.publish(this.topics.app, env); } return ok; }
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

  /**
   * Settle a coordinated query with the §9 five-way split: contributors (72%, by domain ZTI x confidence),
   * the network wallet (8%), the resonator pool (10%), an ecosystem slice (5%), and a burn (5%). This is
   * the multi-LLM coordination money path: many contributors share one query's pay. It moves already-held
   * ZIR from the funding wallet (the asker/founder) via real transfers and a bond_burn for the burn slice;
   * it mints no new ZIR, so PoR emission and the supply cap are untouched. Founder-gated at the RPC layer
   * (the funding wallet is the node identity, which must hold the budget). Returns the split.
   */
  settleQueryCoordination(queryId: string, budgetUZIR: number): { ok: boolean; reason?: string; payouts?: { address: string; amountUZIR: number }[]; networkUZIR?: number; resonatorPoolUZIR?: number; ecosystemUZIR?: number; burnUZIR?: number; confidenceScore?: number } {
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
    const split = settleCoordination(budgetUZIR, contributions);
    const wallets = settlementWalletsFor(this.genesis.network);
    const tag = queryId.slice(0, 12);
    // The protocol slices (§9): network wallet, resonator pool, ecosystem treasury. The funder is the
    // asker; when a target equals the funder the slice simply stays put, so we skip that transfer.
    const protocolTransfers: { to: string; amountUZIR: number; memo: string }[] = [];
    if (split.networkUZIR > 0 && wallets.network !== funder.address) protocolTransfers.push({ to: wallets.network, amountUZIR: split.networkUZIR, memo: `coordination network ${tag}` });
    if (split.resonatorPoolUZIR > 0 && wallets.resonatorPool !== funder.address) protocolTransfers.push({ to: wallets.resonatorPool, amountUZIR: split.resonatorPoolUZIR, memo: `coordination resonator-pool ${tag}` });
    if (split.ecosystemUZIR > 0 && wallets.ecosystem !== funder.address) protocolTransfers.push({ to: wallets.ecosystem, amountUZIR: split.ecosystemUZIR, memo: `coordination ecosystem ${tag}` });
    const payoutTxs = split.payouts.filter((p) => p.amountUZIR > 0).length;
    const willBurn = split.burnUZIR > 0;
    // Every outgoing tx (payouts + protocol transfers + the burn) carries one base fee; the funder must
    // cover the whole budget plus those fees.
    const needed = budgetUZIR + (payoutTxs + protocolTransfers.length + (willBurn ? 1 : 0)) * PROTOCOL.BASE_FEE_UZIR;
    if (this.state.balanceOf(funder.address) < needed) return { ok: false, reason: "funding wallet has insufficient balance for the coordination payout" };
    let nonce = this.state.provisionalNonce(funder.address);
    const now = Date.now();
    const tx = (to: string, amountUZIR: number, memo: string, kind: "agent_spend" | "bond_burn" = "agent_spend") => signTx({
      network: this.genesis.network, from: funder.address, fromPubKey: funder.publicKey, to,
      amountUZIR, feeUZIR: PROTOCOL.BASE_FEE_UZIR, nonce: nonce++, kind,
      parents: [], timestamp: now, memo,
    }, funder.privateKey);
    const paid: { address: string; amountUZIR: number }[] = [];
    for (const p of split.payouts) {
      if (p.amountUZIR <= 0) continue;
      if (this.submitTx(tx(p.address, p.amountUZIR, `coordination payout ${tag} ${domain}`)).accepted) paid.push({ address: p.address, amountUZIR: p.amountUZIR });
    }
    for (const t of protocolTransfers) this.submitTx(tx(t.to, t.amountUZIR, t.memo));
    // The burn slice is destroyed via a bond_burn (debits the funder, credits no one, increases burned).
    if (willBurn) this.submitTx(tx(funder.address, split.burnUZIR, `coordination burn ${tag}`, "bond_burn"));
    return { ok: true, payouts: paid, networkUZIR: split.networkUZIR, resonatorPoolUZIR: split.resonatorPoolUZIR, ecosystemUZIR: split.ecosystemUZIR, burnUZIR: split.burnUZIR, confidenceScore: split.confidenceScore };
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
      // without ruptures). Tracks the node package version / installer release.
      version: "1.9.10",
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
    } as NetworkStats & { version: string; peers: number; finalizedEpoch: number; stateRoot: string; pool: { txs: number; observations: number }; models: number; mastersCount: number; isFounder: boolean; founderAddress: string; founderAddresses: string[] };
  }

  private persistSnapshot(): void {
    try { this.store.writeSnapshot(this.state.snapshot()); } catch (e) { log.warn("snapshot failed", (e as Error).message); }
  }

  identityAddress(): string { return this.identity.address; }
  durableTxLog(): SignedTx[] {
    return this.store.readEvents().filter((e) => e.t === "tx").map((e) => e.data as SignedTx);
  }
  durableSupplyAudit(): { emitted: number; burned: number; reserve: number; issued: number; circulating: number; withinCap: boolean } {
    const replay = new State(this.genesis);
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
