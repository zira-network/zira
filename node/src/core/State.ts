// node/src/core/State.ts
//
// The deterministic state machine, ZIRA's answer to bitcoin's block validation. Every node that
// has seen the same signed events computes the same committed state. There is no central referee.
//
// How convergence works without a chain of blocks:
//  - Ledger events (transactions, observations) are gossiped and held in a pool.
//  - State advances in fixed epochs. When an epoch closes (enough wall clock has passed for gossip
//    to settle), the node processes that epoch's events in a canonical order, so every honest node
//    derives the same committed balances, the same Locks, and the same rewards.
//  - Finality comes from Proof of Resonance checkpoints (see consensus.ts), computed over the
//    committed state root. This file produces that state; Checkpoints.ts finalizes it.
import {
  PROTOCOL, ANCHOR_CLASSES, ANCHOR_CLASS_ZTI, ANCHOR_ACTIVATION_ENABLED, anchorSeatAllocationUZIR,
  hashHex, canonical, buildObservationBody, addressFromPubKey, verify as edVerify,
  verifyTx, feeAndBurn, parseBatchOutputs, parsePoolPayout,
  trustWeightedMedian, cv as cvOf, accuracyScore, emaAccuracy, consistencyScore, composeZti,
  perRoundReward,
  applyGenesis, computeStateRoot, decentralizationActive,
  addUZIR, subUZIR,
  type SignedTx, type SignedObservation, type Lock, type GenesisDoc, type Address, type Domain,
  type AccountLeaf, type SupplyState, type Anchor, type AnchorTxPayload,
} from "@zira/protocol";
import type { Account } from "./types";
import { log } from "../log.js";

export const EPOCH_MS = PROTOCOL.ACCOUNTING_ROUND_MS;                 // 5s rounds
export const WINDOW_ROUNDS = Math.ceil(PROTOCOL.OBSERVATION_WINDOW_MS / EPOCH_MS); // 6
// Field convergence (Lock seal + emission) runs over a SETTLED trailing window, lagged by this many epochs
// behind the epoch being processed. Observations gossip and re-gossip, so the in-window set for an epoch is
// only guaranteed identical on every node once it has had a few epochs to fully propagate. If emission read
// the freshest epoch, a contributor (especially a busy serving node) could land in one node's in-window set
// but not another's: the emission TOTAL stays curve-bound, but the reward SPLIT — and therefore each node's
// per-account balances and state root — would differ, so no single root could ever gather the 3-of-4 master
// votes and quorum finality would stall. Lagging the evidence makes the contributor set deterministic across
// nodes. The emit-every-epoch cadence and per-epoch curve value are unchanged; only the evidence is settled.
// Widened for a public network with uneven peer connectivity: a master with many external peers can receive
// user txs its sibling masters have not yet seen, so an epoch closed too eagerly diverges and stalls quorum
// finality. Finalizing further behind the head (with the applied-tx re-gossip backfill in ZiraNode) gives
// every tx time to reach every master before its epoch settles, so honest masters always agree. Cost: finality
// trails wall-clock by a few more seconds. Deterministic — every node uses the same value.
export const SETTLE_ROUNDS = 8;
// Settle time before an epoch is processed. Emission/Lock convergence is computed over each node's
// in-window observation pool, so for the state root to match across nodes EVERY node must hold the same
// observations when it closes a given epoch. A node whose event loop is briefly busy (serving inference,
// fetching a model, a GC pause) can drain its gossip-receive queue late; with too short a grace it closes
// the epoch over an incomplete pool and its emission — and thus its state root — diverges, which is exactly
// what stalls quorum finality (no single root gets the votes). A grace comfortably larger than any plausible
// loop stall (and than the re-gossip interval) lets late deliveries land before the epoch closes anywhere,
// so all nodes converge on identical emission. Kept well under OBSERVATION_WINDOW_MS so observations are
// still firmly in-window when processed; the only cost is finality trailing wall-clock by a few epochs.
export const GRACE_MS = 20_000;

/**
 * Deep-clone a plain snapshot leaf (account/lock/anchor) so loadSnapshot never aliases the caller's
 * objects. Accounts carry a nested ztiByDomain map, so a shallow spread is not enough. structuredClone
 * is available on Node >= 17 (engines pin >= 20); the JSON fallback keeps it robust for any leaf shape.
 */
function structuredCloneLeaf<T>(leaf: T): T {
  try { return structuredClone(leaf); } catch { return JSON.parse(JSON.stringify(leaf)) as T; }
}

export function epochOf(ts: number): number {
  return Math.floor(ts / EPOCH_MS);
}

export interface LedgerEntry extends SignedTx { committedEpoch?: number; }

export class State {
  readonly genesis: GenesisDoc;
  readonly founder: Address;
  private authorizedFounders = new Set<Address>();
  private genesisMasters = new Set<Address>();
  // The network settler: the FIRST genesis master (mainnet) or the founder (devnet/test with no master set).
  // Base emission is credited here alone, so a single wallet mints the earned pool and then redistributes
  // most of it to the community each cycle (see ZiraNode). Fixed from genesis, so emission stays deterministic.
  readonly settler: Address;

  accounts = new Map<Address, Account>();
  supply: SupplyState = { emitted: 0, burned: 0, reserve: 0 };
  locks = new Map<string, Lock>();          // latest lock per subject
  lockLog: Lock[] = [];                      // recent locks, capped
  history: LedgerEntry[] = [];               // recent committed ledger entries, capped
  anchors = new Map<string, Anchor>();        // consensus-visible ZRC-1 structural seats
  // Decentralization cutover: the sealed validator registry (earned-work masters + anchor holders) that
  // may finalize alongside the genesis quorum. Sorted, deduped, capped at MAX_VALIDATORS. EMPTY until
  // DECENTRALIZATION_ACTIVATION_EPOCH, so it is dropped from the state root and behaves exactly as before.
  // When non-empty it is folded into computeStateRoot, so every node must seal an identical set. The Set
  // mirror is a lookup index (not persisted; rebuilt from the array on load).
  private validators: Address[] = [];
  private validatorSet = new Set<Address>();
  // Decentralization cutover: monotonic idempotency watermark for pool_payout (community payouts funded from
  // the emission pool). Advanced only by applied pool_payout txs; a bucket <= this is rejected, so two racing
  // settlers can never double-pay a cycle. 0 while dormant (no pool_payout exists) => dropped from the root.
  private lastPoolPayoutBucket = 0;

  private txPool = new Map<string, SignedTx>();
  private obsPool = new Map<string, SignedObservation>();
  knownIds = new Set<string>();
  /** F7: bound the dedup cache. knownIds is NOT part of the state root (only an idempotency cache);
   *  txs are nonce-guarded and observations lock-guarded, so evicting the very oldest ids is safe and
   *  caps memory on a long-running public node. */
  private static readonly KNOWN_IDS_CAP = 500_000;
  private rememberId(key: string): void {
    this.knownIds.add(key);
    if (this.knownIds.size > State.KNOWN_IDS_CAP) {
      const evict = Math.floor(State.KNOWN_IDS_CAP * 0.1);
      let i = 0;
      for (const k of this.knownIds) { this.knownIds.delete(k); if (++i >= evict) break; }
    }
  }
  lastProcessedEpoch: number;
  // The last epoch base emission has been credited through. Advances deterministically with processing so
  // supply.emitted is a pure function of the epoch reached (see emitBaseThrough). Snapshot-persisted.
  private lastEmittedEpoch: number;
  /**
   * Fast-sync convergence floor. -1 except on a node that ADOPTED a verified peer snapshot, where it is
   * set to the adopted epoch. While set, ingest refuses to POOL any event at or below it (their effects
   * are already baked into the adopted snapshot), so the joiner forward-applies only post-snapshot
   * events and converges exactly. The genesis-replay and persisted-restart paths never set this, so
   * they still see the full event history. See dropPooledThrough / adoptFastSyncSnapshot.
   */
  fastSyncFloorEpoch = -1;

  private static HISTORY_CAP = 8000;
  private static LOCK_CAP = 2000;
  // How long a nonce-gapped tx waits in the pool for its missing predecessor before it is dropped (~10 min of
  // epochs). Generous, because the applied-tx re-gossip usually fills the gap within seconds; this only bounds
  // the pool against a predecessor that is genuinely gone. Deterministic across nodes (epochs of tx timestamps).
  private static TX_GAP_TTL_EPOCHS = 120;

  // Decentralization cutover activation epoch. Defaults to the protocol constant (0 = dormant in prod, so
  // every node on the same release agrees). An override is accepted ONLY as a test/rehearsal seam — the live
  // cutover ships the constant in a release, never a per-node override, so nodes can never disagree.
  private readonly decentralizationActivationEpoch: number;

  constructor(genesis: GenesisDoc, activationEpochOverride?: number) {
    this.genesis = genesis;
    this.founder = genesis.founder;
    this.settler = genesis.masters?.[0]?.address ?? genesis.founder;
    this.decentralizationActivationEpoch = activationEpochOverride ?? PROTOCOL.DECENTRALIZATION_ACTIVATION_EPOCH;
    this.setAuthorizedFounders(genesis.founders ?? [genesis.founder]);
    const seeded = applyGenesis(genesis);
    for (const [addr, bal] of Object.entries(seeded.balances)) {
      this.accounts.set(addr, this.blankAccount(addr, bal));
    }
    // Record the genesis pre-allocations as the first entries in the living ledger, so history traces
    // from genesis to now: the 41% reserves (anchor, events, founder ops) are visible as ledger events,
    // not only in the supply audit. These are display records; record() does not touch the state root.
    for (const [addr, bal] of Object.entries(seeded.balances)) {
      if (bal <= 0) continue;
      const body = {
        network: genesis.network, from: "", fromPubKey: "", to: addr, amountUZIR: bal, feeUZIR: 0,
        nonce: 0, kind: "reserve_grant" as const, parents: [], timestamp: genesis.timestamp, memo: "genesis allocation",
      };
      this.record({ ...body, id: hashHex(canonical({ ...body, g: "genesis" })), sig: "", committedEpoch: epochOf(genesis.timestamp) });
    }
    for (const founder of this.authorizedFounders) {
      if (!this.accounts.has(founder)) this.accounts.set(founder, this.blankAccount(founder));
    }
    this.seedGenesisMasters();
    this.supply = { ...seeded.supply };
    this.loadGenesisAnchors(genesis);
    this.lastProcessedEpoch = epochOf(genesis.timestamp);
    this.lastEmittedEpoch = epochOf(genesis.timestamp);
  }

  /**
   * Seed the genesis master set: the bootstrap finality quorum (keyless coordinator nodes). Each is set
   * isMaster with full trust and its genesis pubkey, so the master map is deterministic from genesis and
   * finality starts immediately — no waiting for pubkeys to propagate via gossip. These accounts hold no
   * funds (balance 0), and isMaster/zti/pubkey are NOT part of the state root, so this is root-neutral.
   * Idempotent: safe to call again after loadSnapshot to re-assert the set on restart.
   */
  private seedGenesisMasters(): void {
    for (const m of this.genesis.masters ?? []) {
      if (!m.address?.startsWith("zir1")) continue;
      this.genesisMasters.add(m.address);
      const a = this.accounts.get(m.address) ?? this.blankAccount(m.address);
      a.isMaster = true;
      a.zti = Math.max(a.zti, 1.0);
      a.accuracy = Math.max(a.accuracy, 1.0);
      a.uptime = Math.max(a.uptime, 1.0);
      a.ztiByDomain.general = 1.0;
      if (m.pubKey && !a.pubkey) a.pubkey = m.pubKey;
      this.accounts.set(m.address, a);
    }
  }
  /** Whether an address is one of the genesis bootstrap masters (exempt from the admission gates). */
  isGenesisMaster(address: Address): boolean {
    return this.genesisMasters.has(address);
  }

  /**
   * Union of miners vouched by ANY genesis master in a recent field-heartbeat observation. The settler pays
   * this set so field-participation earning does NOT depend on the settler's own peer connections: a miner
   * that is a live/serving peer of any master earns, even if it never connected to the settler. Consensus-
   * safe because it only feeds the settler's OWN signed payout tx (which every node applies identically);
   * it is not a per-node consensus computation. Reads the same gossiped heartbeat observations runField uses.
   */
  aggregateVouchedMiners(now: number, freshMs: number): string[] {
    const cutoff = now - freshMs;
    const latestPerMaster = new Map<string, SignedObservation>();
    for (const o of this.obsPool.values()) {
      if (o.subject !== PROTOCOL.FIELD_HEARTBEAT_SUBJECT || o.timestamp < cutoff) continue;
      if (!this.isGenesisMaster(addressFromPubKey(o.observer))) continue;
      const prev = latestPerMaster.get(o.observer);
      if (!prev || o.timestamp > prev.timestamp) latestPerMaster.set(o.observer, o);
    }
    const out = new Set<string>();
    for (const o of latestPerMaster.values()) for (const m of o.vouchedMiners ?? []) out.add(m);
    return [...out];
  }

  /**
   * The genesis-master addresses that have beaconed a field heartbeat within `freshMs` — i.e. are online.
   * Used for settler FAILOVER: the active settler is the lowest-index master that is live, so if box1
   * (masters[0]) goes offline its heartbeat ages out here and the next master can take over payouts. Soft
   * state (reads gossiped observations), never in the state root, so this changes only WHO issues payout txs.
   */
  liveGenesisMasters(now: number, freshMs: number): Set<Address> {
    const cutoff = now - freshMs;
    const live = new Set<Address>();
    for (const o of this.obsPool.values()) {
      if (o.subject !== PROTOCOL.FIELD_HEARTBEAT_SUBJECT || o.timestamp < cutoff) continue;
      const addr = addressFromPubKey(o.observer);
      if (this.isGenesisMaster(addr)) live.add(addr);
    }
    return live;
  }

  /**
   * The storage size (GiB) a miner most recently attested it is serving, from its own signed field heartbeat.
   * Self-reported, so the settler only WEIGHTS by it for miners it independently verified are storage-serving
   * (passed a chunk challenge) — a liar who never serves gains nothing. Soft state; feeds "bigger storage
   * earns more" in the field payout weight. 0 if the miner has no fresh heartbeat.
   */
  minerStorageGiB(addr: Address, now: number, freshMs: number): number {
    const cutoff = now - freshMs;
    let latest = 0, latestTs = 0;
    for (const o of this.obsPool.values()) {
      if (o.subject !== PROTOCOL.FIELD_HEARTBEAT_SUBJECT || o.timestamp < cutoff) continue;
      if (addressFromPubKey(o.observer) !== addr) continue;
      if (o.timestamp > latestTs) { latestTs = o.timestamp; latest = Math.max(0, Number(o.storageGiB) || 0); }
    }
    return latest;
  }

  setAuthorizedFounders(addresses: Address[]): void {
    this.authorizedFounders = new Set([this.founder, ...addresses.filter((a) => a.startsWith("zir1"))]);
    for (const founder of this.authorizedFounders) {
      if (!this.accounts.has(founder)) this.accounts.set(founder, this.blankAccount(founder));
    }
  }
  isAuthorizedFounder(address: Address): boolean {
    return this.authorizedFounders.has(address);
  }
  activeFounderAddresses(): Address[] {
    return [...this.authorizedFounders].sort();
  }

  private blankAccount(address: Address, balance = 0, pubkey = ""): Account {
    return { address, pubkey, balance, nonce: 0, zti: 0, ztiByDomain: {}, accuracy: 0, consistency: 1, uptime: 0, isMaster: false, firstSeenEpoch: -1, activeEpochs: 0, lastActiveEpoch: -1, lastWorkEpoch: -1 };
  }
  private acct(address: Address): Account {
    let a = this.accounts.get(address);
    if (!a) { a = this.blankAccount(address); this.accounts.set(address, a); }
    return a;
  }

  private loadGenesisAnchors(genesis: GenesisDoc): void {
    this.anchors.clear();
    const owners = new Map((genesis.anchorOwnership ?? []).map((o) => [o.seatId, o.owner]));
    for (const c of genesis.anchors ?? []) {
      const meta = ANCHOR_CLASSES[c.classCode];
      const owner = owners.get(c.seatId);
      // Per-position allocation: the reserved half (lower seat indices) carries 2x the website figure,
      // the open half 1x. This is the reserve-backed amount that vests to a position's owner over a year.
      const seat: Anchor = {
        id: c.seatId,
        ring: meta.tier,
        classCode: c.classCode,
        className: meta.name,
        seatIndex: c.seatIndex,
        codeHash: c.codeHash,
        owner,
        zirReserveUZIR: anchorSeatAllocationUZIR(c.classCode, c.seatIndex),
        vestedUZIR: 0,
        // Each anchor resonator is seeded at its class ZTI standing (A 0.95 ... F 0.45). This is the
        // position's structural standing; ongoing PoR + coordination still moves the operator's account ZTI.
        zti: ANCHOR_CLASS_ZTI[c.classCode],
        routingWeight: meta.weight,
        status: owner ? "owned" : "unclaimed",
        claimedAt: owner ? genesis.timestamp : undefined,
      };
      this.anchors.set(seat.id, seat);
      if (owner) this.acct(owner);
    }
  }

  private parseAnchorPayload(tx: SignedTx): AnchorTxPayload | null {
    if (!tx.memo) return null;
    try {
      const parsed = JSON.parse(tx.memo) as AnchorTxPayload;
      return parsed && typeof parsed === "object" && "anchor" in parsed ? parsed : null;
    } catch {
      return null;
    }
  }

  private applyAnchorTx(tx: SignedTx, sender: Account, epoch: number): boolean {
    if (tx.kind === "anchor_activate") return true;
    const payload = this.parseAnchorPayload(tx);
    if (!payload || tx.amountUZIR !== 0) return true;
    const fee = tx.feeUZIR;
    if (sender.balance < fee) return true;
    const applyFee = () => {
      const { burned } = feeAndBurn(fee);
      sender.balance = subUZIR(sender.balance, fee, "anchor-fee debit");
      sender.nonce += 1;
      if (!sender.pubkey) sender.pubkey = tx.fromPubKey;
      this.supply.burned = addUZIR(this.supply.burned, burned, "anchor-fee burn");
      this.record({ ...tx, committedEpoch: epoch });
    };

    if (tx.kind === "anchor_claim" && payload.anchor === "claim") {
      const { seatId, code } = payload.data;
      const seat = this.anchors.get(seatId);
      if (!seat || seat.owner || hashHex(String(code)) !== seat.codeHash) return true;
      seat.owner = tx.from;
      seat.status = "owned";
      seat.claimedAt = tx.timestamp;
      seat.listedPriceUZIR = undefined;
      seat.listedAt = undefined;
      applyFee();
      return true;
    }

    if (tx.kind === "anchor_transfer" && payload.anchor === "transfer") {
      const { seatId, to } = payload.data;
      const seat = this.anchors.get(seatId);
      if (!seat || seat.owner !== tx.from || !to.startsWith("zir1")) return true;
      this.acct(to);
      seat.owner = to;
      seat.status = "owned";
      seat.listedPriceUZIR = undefined;
      seat.listedAt = undefined;
      applyFee();
      return true;
    }

    // Owner-authorized transfer of one or more POSITIONS (resonator assets) in a single signed op.
    // Single = one seatId, batch = many. A position carries class/ZTI/weight and its ZIR allocation;
    // vesting follows the new owner. Two cases, both pure accounting (the backing ZIR moves later, in
    // claimable increments, via the existing release path — nothing is minted here):
    //   - steward-owned position with NO schedule yet: open a fresh one-year linear vesting of the seat's
    //     allocation to the new owner, funded by the current owner (which holds the backing ZIR).
    //   - already-vesting position: redirect the remaining releases to the new owner (carry the schedule:
    //     same funder/total/start/duration and vested high-water mark; only the beneficiary changes).
    // The whole batch is atomic: if any seat fails authorization/validation, none are moved.
    if (tx.kind === "anchor_position_transfer" && payload.anchor === "position_transfer") {
      const { seatIds, to, vestStartAt, vestDurationMs } = payload.data;
      if (!Array.isArray(seatIds) || seatIds.length === 0) return true;
      if (typeof to !== "string" || !to.startsWith("zir1")) return true;
      // De-duplicate while preserving order; reject if any id is unknown or not owned by the signer.
      const ids = [...new Set(seatIds.map(String))];
      const seats = ids.map((id) => this.anchors.get(id));
      if (seats.some((s) => !s || s.owner !== tx.from)) return true;
      const startAt = Number.isFinite(vestStartAt) ? (vestStartAt as number) : tx.timestamp;
      const duration = vestDurationMs && vestDurationMs > 0 ? vestDurationMs : undefined;
      this.acct(to);
      for (const seat of seats as Anchor[]) {
        seat.owner = to;
        seat.status = "owned";
        seat.listedPriceUZIR = undefined;
        seat.listedAt = undefined;
        if (!seat.vestTotalUZIR) {
          // open a fresh schedule for the full allocation, funded by the transferring owner
          seat.vestTotalUZIR = seat.zirReserveUZIR;
          seat.vestStartAt = startAt;
          seat.vestDurationMs = duration;
          seat.vestBeneficiary = to;
          seat.vestFunder = tx.from;
          seat.vestedUZIR = 0;
        } else {
          // carry the schedule: remaining releases now go to the new owner
          seat.vestBeneficiary = to;
        }
      }
      applyFee();
      return true;
    }

    if (tx.kind === "anchor_list" && payload.anchor === "list") {
      const { seatId, priceUZIR } = payload.data;
      const seat = this.anchors.get(seatId);
      if (!seat || seat.owner !== tx.from || !Number.isInteger(priceUZIR) || priceUZIR <= 0) return true;
      seat.status = "listed";
      seat.listedPriceUZIR = priceUZIR;
      seat.listedAt = tx.timestamp;
      applyFee();
      return true;
    }

    if (tx.kind === "anchor_delist" && payload.anchor === "delist") {
      const { seatId } = payload.data;
      const seat = this.anchors.get(seatId);
      if (!seat || seat.owner !== tx.from) return true;
      seat.status = "owned";
      seat.listedPriceUZIR = undefined;
      seat.listedAt = undefined;
      applyFee();
      return true;
    }

    if (tx.kind === "anchor_set_contributions" && payload.anchor === "set_contributions") {
      // The anchor OWNER opens or closes one or more of their positions for user contributions. Owner-only,
      // per seat; a non-owned or wrong-owner seat is silently skipped. Deterministic (fields are in the tx).
      const { seatIds, open } = payload.data;
      if (!Array.isArray(seatIds) || seatIds.length === 0 || seatIds.length > 64) return true;
      let changed = false;
      for (const seatId of seatIds) {
        const seat = this.anchors.get(String(seatId));
        if (!seat || seat.owner !== tx.from) continue;
        seat.contributionsOpen = !!open;
        changed = true;
      }
      if (changed) applyFee();
      return true;
    }

    if (tx.kind === "anchor_code_edit" && payload.anchor === "code_edit") {
      const { seatId, codeHash } = payload.data;
      const seat = this.anchors.get(seatId);
      if (!seat || seat.owner || !this.isAuthorizedFounder(tx.from) || !/^[0-9a-f]{64}$/i.test(String(codeHash))) return true;
      seat.codeHash = codeHash.toLowerCase();
      applyFee();
      return true;
    }

    // Begin a one-year linear vesting of the seat's class allocation to the beneficiary. Recorded by
    // the anchor-reserve wallet that funds the allocation, at assignment time. Pure accounting: the
    // ZIR itself moves later, in claimable increments, via ordinary transfers from the same wallet.
    if (tx.kind === "anchor_vest_start" && payload.anchor === "vest_start") {
      const { seatId, beneficiary, totalUZIR, startAt, durationMs } = payload.data;
      const seat = this.anchors.get(seatId);
      // Only the seat owner at this instant (the funder that just claimed it, i.e. the reserve wallet)
      // may open a schedule, and only once: an existing active schedule is never silently overwritten.
      // The funder is recorded so it can author releases later, after ownership transfers to the owner.
      if (!seat || seat.owner !== tx.from || seat.vestTotalUZIR) return true;
      if (typeof beneficiary !== "string" || !beneficiary.startsWith("zir1")) return true;
      if (!Number.isInteger(totalUZIR) || totalUZIR <= 0 || !Number.isFinite(startAt)) return true;
      seat.vestTotalUZIR = totalUZIR;
      seat.vestStartAt = startAt;
      seat.vestBeneficiary = beneficiary;
      seat.vestFunder = tx.from;
      seat.vestDurationMs = durationMs && durationMs > 0 ? durationMs : undefined;
      seat.vestedUZIR = 0;
      this.acct(beneficiary);
      applyFee();
      return true;
    }

    // Advance the cumulative released figure for a seat's vesting schedule. Monotonic and capped at the
    // scheduled total: it can only move the high-water mark up, never beyond what was scheduled. The
    // matching transfer (reserve -> beneficiary) is a separate ordinary tx, so balances and supply stay
    // exact; this record just keeps every node's view of "how much has vested out" in agreement.
    if (tx.kind === "anchor_vest_release" && payload.anchor === "vest_release") {
      const { seatId, releasedUZIR } = payload.data;
      const seat = this.anchors.get(seatId);
      // Authored by the recorded funder (the reserve wallet), independent of who now owns the seat.
      if (!seat || seat.vestFunder !== tx.from || !seat.vestTotalUZIR) return true;
      if (!Number.isInteger(releasedUZIR) || releasedUZIR < 0) return true;
      const capped = Math.min(releasedUZIR, seat.vestTotalUZIR);
      if (capped <= seat.vestedUZIR) { applyFee(); return true; }   // no backwards moves; still consume the fee/nonce
      seat.vestedUZIR = capped;
      applyFee();
      return true;
    }

    return true;
  }

  balanceOf(address: Address): number { return this.accounts.get(address)?.balance ?? 0; }
  nonceOf(address: Address): number { return this.accounts.get(address)?.nonce ?? 0; }

  // ---- ingest gossiped ledger events into the pool ----

  /** Validate and pool a transaction. Returns whether it was newly accepted. */
  ingestTx(tx: SignedTx): { ok: boolean; isNew: boolean; reason?: string } {
    const key = "tx:" + tx.id;
    if (this.knownIds.has(key)) return { ok: true, isNew: false };
    if (tx.kind === "reward") return { ok: false, isNew: false, reason: "reward is derived, not gossiped" };
    const v = verifyTx(tx);
    if (!v.ok) return { ok: false, isNew: false, reason: v.reason };
    // A tx with a non-finite timestamp can never be assigned to an epoch (epochOf returns NaN, so it is
    // never <= any processed epoch), so it would sit in the pool forever, silently occupying its
    // sender's nonce and blocking every later tx from that sender. Reject it outright.
    if (!Number.isFinite(tx.timestamp)) return { ok: false, isNew: false, reason: "transaction timestamp is not a finite number" };
    if (tx.network !== this.genesis.network) return { ok: false, isNew: false, reason: `transaction network mismatch: expected ${this.genesis.network}` };
    if (tx.kind === "reserve_grant" && !this.isAuthorizedFounder(tx.from)) {
      return { ok: false, isNew: false, reason: "reserve_grant must come from an active founder" };
    }
    if (tx.kind === "anchor_activate" && !ANCHOR_ACTIVATION_ENABLED) {
      return { ok: false, isNew: false, reason: "anchor activation is disabled until all 512 seats are secured" };
    }
    if (tx.kind === "founder_delegate") {
      if (!this.isAuthorizedFounder(tx.from)) return { ok: false, isNew: false, reason: "founder_delegate must come from an active founder" };
      if (!tx.to.startsWith("zir1")) return { ok: false, isNew: false, reason: "delegated founder address is invalid" };
      if (tx.amountUZIR !== 0) return { ok: false, isNew: false, reason: "founder_delegate amount must be zero" };
    }
    if (tx.kind === "founder_revoke") {
      if (!this.isAuthorizedFounder(tx.from)) return { ok: false, isNew: false, reason: "founder_revoke must come from an active founder" };
      if (!tx.to.startsWith("zir1")) return { ok: false, isNew: false, reason: "revoked founder address is invalid" };
      if (tx.to === this.founder) return { ok: false, isNew: false, reason: "genesis founder cannot be revoked" };
      if (tx.amountUZIR !== 0) return { ok: false, isNew: false, reason: "founder_revoke amount must be zero" };
    }
    if (tx.kind === "batch_transfer") {
      const outs = parseBatchOutputs(tx.memo);
      if (!outs) return { ok: false, isNew: false, reason: "batch_transfer outputs are malformed" };
      let sum = 0; for (const [, amt] of outs) sum += amt;
      if (sum !== tx.amountUZIR) return { ok: false, isNew: false, reason: "batch_transfer amount must equal the sum of its outputs" };
    }
    if (tx.kind === "pool_payout") {
      const meta = parsePoolPayout(tx.memo);
      if (!meta) return { ok: false, isNew: false, reason: "pool_payout memo is malformed" };
      let sum = 0; for (const [, amt] of meta.outputs) sum += amt;
      if (sum !== tx.amountUZIR) return { ok: false, isNew: false, reason: "pool_payout amount must equal the sum of its outputs" };
      // Authorization + activation + idempotency are re-checked at APPLY time (they depend on the epoch and
      // evolving state); ingest only validates the static shape so a malformed tx never enters the pool.
    }
    // Do NOT reject a tx whose epoch is already processed. A tx that arrives late (gossip delay, or
    // after the empty-epoch fast-forward raced lastProcessedEpoch ahead) must still be pooled; it is
    // applied at the next processed epoch (processEpoch applies every pooled tx whose epoch is <= the one
    // being processed, minus the SETTLE_ROUNDS lag). Rejecting late txs here, or with a per-node-relative
    // bound, would strand real payments and could diverge nodes. Replay of an already-applied tx is
    // prevented by knownIds above and by the per-account nonce, so accepting every valid tx is safe.
    // Fast-sync floor: a node that adopted a verified snapshot already has every effect through the adopted
    // epoch baked in. Because tx application lags its timestamp by SETTLE_ROUNDS (so every node applies the
    // same tx set per epoch and burned/balances stay deterministic), only txs old enough to have already
    // been applied in the snapshot (epoch <= floor - SETTLE_ROUNDS) are dropped; txs in the trailing
    // (floor - SETTLE_ROUNDS, floor] window were NOT yet applied and must re-enter so the joiner applies
    // them as it advances, exactly as the mesh did.
    if (this.fastSyncFloorEpoch >= 0 && epochOf(tx.timestamp) <= this.fastSyncFloorEpoch - SETTLE_ROUNDS) {
      this.rememberId(key);
      return { ok: true, isNew: false };
    }
    this.rememberId(key);
    this.txPool.set(tx.id, tx);
    return { ok: true, isNew: true };
  }

  /** Validate and pool an observation. */
  ingestObservation(o: SignedObservation): { ok: boolean; isNew: boolean; reason?: string } {
    const key = "ob:" + o.id;
    if (this.knownIds.has(key)) return { ok: true, isNew: false };
    const c = canonical(buildObservationBody(o));
    if (hashHex(c) !== o.id) return { ok: false, isNew: false, reason: "observation id mismatch" };
    if (!edVerify(c, o.sig, o.observer)) return { ok: false, isNew: false, reason: "observation signature invalid" };
    if (o.confidence < 0 || o.confidence > 1) return { ok: false, isNew: false, reason: "confidence out of range" };
    if (epochOf(o.timestamp) <= this.lastProcessedEpoch - SETTLE_ROUNDS - WINDOW_ROUNDS) {
      return { ok: false, isNew: false, reason: "observation too old" };
    }
    // Fast-sync floor (see ingestTx): a backfilled observation already counted by the adopted snapshot must
    // not re-enter the field window, or it could re-mint a reward the snapshot already applied and fork the
    // root. But emission lags an observation by SETTLE_ROUNDS, so the snapshot (processed up to the floor)
    // has NOT yet emitted observations in (floor - SETTLE_ROUNDS, floor]; those must still be admitted so the
    // joiner mints them as it advances past the floor, exactly as the mesh did. Only observations old enough
    // that their emission is definitely baked into the snapshot are dropped.
    if (this.fastSyncFloorEpoch >= 0 && epochOf(o.timestamp) <= this.fastSyncFloorEpoch - SETTLE_ROUNDS) {
      this.rememberId(key);
      return { ok: true, isNew: false };
    }
    this.rememberId(key);
    this.obsPool.set(o.id, o);
    // ensure the observer has an account to carry ZTI
    const addr = addressFromPubKey(o.observer);
    const a = this.acct(addr);
    if (!a.pubkey) a.pubkey = o.observer;
    return { ok: true, isNew: true };
  }

  // ---- deterministic epoch processing ----

  /** The highest epoch that is safe to process now (closed plus a grace period for gossip). */
  closableEpoch(now: number): number {
    return Math.floor((now - GRACE_MS) / EPOCH_MS) - 1;
  }

  /** The earliest epoch that has a pooled event, or null if the pools are empty. */
  private earliestPooledEpoch(): number | null {
    let min: number | null = null;
    for (const t of this.txPool.values()) { const e = epochOf(t.timestamp); if (min === null || e < min) min = e; }
    for (const o of this.obsPool.values()) { const e = epochOf(o.timestamp); if (min === null || e < min) min = e; }
    return min;
  }

  /**
   * Process every newly closable epoch in order. Empty epoch spans are skipped in O(1) instead of
   * iterated, so a node started long after genesis (or restarted) catches up instantly rather than
   * looping over millions of empty rounds. This is what keeps startup scalable as history grows.
   */
  advance(now: number): number {
    const target = this.closableEpoch(now);
    if (target <= this.lastProcessedEpoch) return 0;
    // fast forward over epochs that have no pooled events (nothing to compute there), but NEVER past
    // `target` (the last closable epoch). A pooled event stamped in a future epoch (its `earliest` is
    // ahead of target, e.g. an autonomous-coordination cycle) must not drag lastProcessedEpoch past
    // target: if it did, the while loop below would not run and the node would freeze, processing
    // nothing and leaving the state root static while real txs pile up unapplied in the pool. Capping
    // at target keeps closable epochs flowing; genuinely-future events wait until their epoch closes.
    const earliest = this.earliestPooledEpoch();
    const firstWork = Math.min(target, earliest === null ? target : Math.max(this.lastProcessedEpoch + 1, earliest - WINDOW_ROUNDS));
    if (firstWork > this.lastProcessedEpoch + 1) this.lastProcessedEpoch = firstWork - 1;
    let count = 0;
    while (this.lastProcessedEpoch < target) {
      this.processEpoch(this.lastProcessedEpoch + 1);
      this.lastProcessedEpoch += 1;
      count += 1;
    }
    return count;
  }

  private processEpoch(epoch: number): void {
    // 1. transactions due by this epoch, canonical order: by sender, then nonce, then id. We include
    // every pooled tx whose epoch is <= this one, not just == this one, so a tx that arrived after the
    // empty-epoch fast-forward skipped its own epoch (or arrived late over gossip) still settles at the
    // next processed epoch instead of being stranded in the pool forever. Effects are idempotent and
    // nonce-ordered, so applying a late tx one epoch later converges to the same balances and root.
    const txs = [...this.txPool.values()]
      .filter((t) => epochOf(t.timestamp) <= epoch - SETTLE_ROUNDS)
      .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) || (a.nonce - b.nonce) || (a.id < b.id ? -1 : 1));
    // A nonce-gapped tx (its predecessor for this sender has not been applied yet, e.g. it is still in flight
    // over gossip) must NOT be discarded: dropping it meant the tx was lost even after the predecessor arrived,
    // so the node stayed permanently behind and its state root diverged, stalling quorum finality. Instead we
    // RETAIN a future-nonce tx and let the applied-tx re-gossip (ZiraNode) deliver the missing predecessor,
    // then it applies in order on the next epoch. Stale txs (nonce already past) are dropped; a gap that never
    // resolves is dropped after TX_GAP_TTL_EPOCHS so the pool stays bounded. All checks are pure functions of
    // nonce and epoch, so every node makes the identical keep/drop/apply decision and converges to one root.
    for (const tx of txs) {
      const senderNonce = this.nonceOf(tx.from);
      if (tx.nonce < senderNonce) { this.txPool.delete(tx.id); continue; }        // superseded / already applied
      if (tx.nonce > senderNonce) {                                                // gap: wait for the predecessor
        if (epochOf(tx.timestamp) < epoch - State.TX_GAP_TTL_EPOCHS) this.txPool.delete(tx.id); // predecessor never came
        continue;
      }
      // nonce matches the sender's committed nonce: try to apply. applyTx advances the sender's nonce on every
      // path EXCEPT an unaffordable spend (overspend), which it drops WITHOUT consuming the nonce so a
      // temporarily-underfunded sender can retry once it accrues. Left unbounded that is a WEDGE: an
      // unaffordable tx pinned at the committed nonce blocks every later tx from that sender FOREVER, because
      // the sender keeps issuing at provisionalNonce = committed + pooledCount (nonce+1, +2, ...), which are all
      // future-nonce gaps that can never apply while the wedge sits at the committed nonce. This is the
      // 2026-07-05 incident: one unaffordable settler payout silently froze the settler's nonce and stopped
      // EVERY field-participation payout, so miners earned nothing. Fix: retry while the wedge is young, but once
      // it has been unable to apply for longer than the gap TTL, SKIP it (advance the nonce, drop the tx) so no
      // single stuck tx can permanently wedge a sender. The skip is a pure function of (nonce, timestamp, epoch)
      // — identical on every node and every event-log replay — so the state root never diverges. In the same
      // sorted drain pass the freed nonce lets the sender's later txs apply immediately (no extra epochs).
      const nonceBefore = this.acct(tx.from).nonce;
      this.applyTx(tx, epoch);
      if (this.acct(tx.from).nonce > nonceBefore) { this.txPool.delete(tx.id); continue; }   // applied or nonce-consumed
      if (epochOf(tx.timestamp) < epoch - State.TX_GAP_TTL_EPOCHS) {                          // unaffordable too long: skip
        this.acct(tx.from).nonce += 1;
        this.txPool.delete(tx.id);
      }
      // else: keep it pooled and retry next epoch (the sender may yet accrue enough to pay).
    }

    // 2. field convergence over the trailing observation window ending at this epoch
    this.runField(epoch);

    // 2b. re-seal the validator registry on its cadence (decentralization cutover). Runs on every node
    // deterministically from the just-applied state, so all nodes commit an identical set. Inert (no-op)
    // until DECENTRALIZATION_ACTIVATION_EPOCH, keeping the registry empty and the root unchanged.
    this.sealValidators(epoch);

    // 3. age out observations older than the settled field window (must outlive the SETTLE_ROUNDS lag, or
    // the trailing window in runField would lose evidence before it is counted)
    const minEpoch = epoch - SETTLE_ROUNDS - WINDOW_ROUNDS + 1;
    for (const [id, o] of this.obsPool) if (epochOf(o.timestamp) < minEpoch) this.obsPool.delete(id);
  }

  private applyTx(tx: SignedTx, epoch: number): void {
    const sender = this.acct(tx.from);
    if (tx.nonce !== sender.nonce) return;                 // out of order or replay, drop
    const need = tx.amountUZIR + tx.feeUZIR;

    if (tx.kind === "storage_attest") {
      // A master attests that the listed miners proved they hold and serve authorized model bytes (the
      // master probed a random chunk and verified it against the known content hash). This credits their
      // verifiable storage/serving work, so heartbeat emission is earnable by genuine storage miners and
      // not only by paid coordination. Only a master may attest; from anyone else it is a no-op. No balance
      // moves. lastWorkEpoch is not in the state root, but the emission it unlocks IS, so every node must
      // run this rule (it ships as a re-genesis cutover). Deterministic: every field is in the signed tx.
      sender.nonce += 1;
      if (!sender.pubkey) sender.pubkey = tx.fromPubKey;
      const signerIsMaster = this.isGenesisMaster(tx.from) || (this.accounts.get(tx.from)?.isMaster ?? false);
      if (signerIsMaster) {
        let miners: string[] = [];
        try { const p = JSON.parse(tx.memo ?? "{}") as { miners?: unknown }; if (Array.isArray(p.miners)) miners = p.miners.slice(0, 64).map(String); } catch { /* malformed memo attests no one */ }
        for (const m of miners) if (/^zir1[0-9a-z]{6,}$/.test(m) && m !== tx.from) this.acct(m).lastWorkEpoch = epoch;
      }
      this.record({ ...tx, committedEpoch: epoch });
      return;
    }

    if (tx.kind === "reserve_grant" && !this.isAuthorizedFounder(tx.from)) return;

    if (tx.kind === "founder_delegate") {
      if (!this.isAuthorizedFounder(tx.from) || tx.amountUZIR !== 0 || !tx.to.startsWith("zir1")) return;
      this.authorizedFounders.add(tx.to);
      this.acct(tx.to);
      sender.nonce += 1;
      if (!sender.pubkey) sender.pubkey = tx.fromPubKey;
      this.record({ ...tx, committedEpoch: epoch });
      return;
    }

    if (tx.kind === "founder_revoke") {
      if (!this.isAuthorizedFounder(tx.from) || tx.amountUZIR !== 0 || !tx.to.startsWith("zir1") || tx.to === this.founder) return;
      this.authorizedFounders.delete(tx.to);
      this.authorizedFounders.add(this.founder);
      sender.nonce += 1;
      if (!sender.pubkey) sender.pubkey = tx.fromPubKey;
      this.record({ ...tx, committedEpoch: epoch });
      return;
    }

    if (tx.kind.startsWith("anchor_")) {
      this.applyAnchorTx(tx, sender, epoch);
      return;
    }

    if (tx.kind === "reserve_grant") {
      const reserve = this.acct(this.founder);
      if (reserve.balance < need) return;
      const { burned } = feeAndBurn(tx.feeUZIR);
      reserve.balance -= need;
      sender.nonce += 1;
      if (!sender.pubkey) sender.pubkey = tx.fromPubKey;
      this.acct(tx.to).balance += tx.amountUZIR;
      this.supply.burned += burned;
      this.supply.reserve = Math.max(0, this.supply.reserve - tx.amountUZIR);
      this.record({ ...tx, committedEpoch: epoch });
      return;
    }

    if (tx.kind === "batch_transfer") {
      // One tx credits many recipients. Outputs come straight from the signed memo, applied in listed order,
      // so every node produces the identical balances. amountUZIR == sum(outputs) was checked at ingest; we
      // re-check here so a malformed tx that somehow reached apply moves no money. Overspend drops WITHOUT
      // consuming the nonce (same as a transfer), so it retries once the funder has accrued enough.
      const outs = parseBatchOutputs(tx.memo);
      if (!outs) { sender.nonce += 1; if (!sender.pubkey) sender.pubkey = tx.fromPubKey; this.record({ ...tx, committedEpoch: epoch }); return; }
      let sum = 0; for (const [, amt] of outs) sum += amt;
      if (sum !== tx.amountUZIR) { sender.nonce += 1; if (!sender.pubkey) sender.pubkey = tx.fromPubKey; this.record({ ...tx, committedEpoch: epoch }); return; }
      if (sender.balance < need) return;                   // overspend, drop and retry
      const { burned } = feeAndBurn(tx.feeUZIR);
      sender.balance = subUZIR(sender.balance, need, "batch debit");
      sender.nonce += 1;
      if (!sender.pubkey) sender.pubkey = tx.fromPubKey;
      for (const [to, amt] of outs) { const r = this.acct(to); r.balance = addUZIR(r.balance, amt, "batch credit"); }
      this.supply.burned = addUZIR(this.supply.burned, burned, "fee burn");
      this.record({ ...tx, committedEpoch: epoch });
      return;
    }

    if (tx.kind === "pool_payout") {
      // Decentralization cutover: a community payout funded from the fixed emission POOL (this.settler's
      // account), not the sender's balance, so ANY authorized settler can keep miners paid while the primary
      // settler (box1) is offline. Fork-safe by construction:
      //   (1) INERT until activation — rejected (nonce consumed, no money) before the activation epoch;
      //   (2) authorization is the ROOT-COMMITTED set {genesis masters ∪ committed validators}, so every node
      //       agrees who may spend the pool;
      //   (3) idempotent per bucket via the root-committed watermark — a bucket already paid is a no-op, so two
      //       racing settlers never double-pay, and settler selection can stay soft without fork risk.
      // BOTH the outputs and the fee are funded by the POOL (this.settler), not the sender, so a fresh failover
      // validator with ZERO balance can still keep miners paid without any pre-funding.
      const consumeNoMoney = () => { sender.nonce += 1; if (!sender.pubkey) sender.pubkey = tx.fromPubKey; this.record({ ...tx, committedEpoch: epoch }); };
      if (!decentralizationActive(epoch, this.decentralizationActivationEpoch)) { consumeNoMoney(); return; }         // dormant: never pays
      const meta = parsePoolPayout(tx.memo);
      if (!meta) { consumeNoMoney(); return; }                                  // malformed memo
      if (tx.to !== this.settler) { consumeNoMoney(); return; }                 // `to` must name the emission pool
      if (!this.isAuthorizedSettler(tx.from)) { consumeNoMoney(); return; }     // not a master/validator
      if (meta.bucket <= this.lastPoolPayoutBucket) { consumeNoMoney(); return; } // already paid: idempotent
      let sum = 0; for (const [, amt] of meta.outputs) sum += amt;
      if (sum !== tx.amountUZIR) { consumeNoMoney(); return; }                  // amount must equal outputs sum
      const pool = this.acct(this.settler);
      // Underfunded pool: DROP without consuming the nonce so it retries once the pool accrues more emission
      // (same retry semantics as a batch_transfer overspend).
      if (pool.balance < sum + tx.feeUZIR) return;
      const { burned } = feeAndBurn(tx.feeUZIR);
      pool.balance = subUZIR(pool.balance, sum + tx.feeUZIR, "pool payout debit + fee");
      sender.nonce += 1;
      if (!sender.pubkey) sender.pubkey = tx.fromPubKey;
      for (const [to, amt] of meta.outputs) { const r = this.acct(to); r.balance = addUZIR(r.balance, amt, "pool payout credit"); }
      this.supply.burned = addUZIR(this.supply.burned, burned, "fee burn");
      this.lastPoolPayoutBucket = meta.bucket;                                  // advance the root-committed watermark
      this.record({ ...tx, committedEpoch: epoch });
      return;
    }

    if (sender.balance < need) return;                     // overspend, drop
    const { burned } = feeAndBurn(tx.feeUZIR);
    sender.balance = subUZIR(sender.balance, need, "transfer debit");
    sender.nonce += 1;
    if (!sender.pubkey) sender.pubkey = tx.fromPubKey;
    if (tx.kind === "bond_burn") {
      this.supply.burned = addUZIR(this.supply.burned, tx.amountUZIR, "bond_burn");
    } else {
      const recipient = this.acct(tx.to);
      recipient.balance = addUZIR(recipient.balance, tx.amountUZIR, "transfer credit");
      // A settled coordination payout is on-ledger proof the recipient did real serving work; it unlocks the
      // recipient's heartbeat (base mining) emission and master-tenure accrual for a window. The marker is a
      // SECURITY boundary, so it must NOT be self-grantable: require a genuine THIRD-PARTY, fee-paying payment
      // (from != to, positive amount, at least the base fee burned) carrying the coordination-payout memo.
      // This is exactly the shape settleQueryCoordination emits, and it makes a forged self-send (from == to,
      // zero amount, zero fee) ineligible. Deterministic: every field here is part of the signed tx.
      if (tx.kind === "agent_spend"
        && tx.from !== tx.to
        && tx.amountUZIR > 0
        && tx.feeUZIR >= PROTOCOL.BASE_FEE_UZIR
        && tx.memo?.startsWith("coordination payout")) {
        recipient.lastWorkEpoch = epoch;
      }
    }
    this.supply.burned = addUZIR(this.supply.burned, burned, "fee burn");
    this.record({ ...tx, committedEpoch: epoch });
  }

  /** Proof of Resonance over the window: seal Locks, update ZTI. Base emission is credited separately in
   *  emitBaseThrough (a pure function of the epoch, independent of observations). Deterministic. */
  private runField(epoch: number): void {
    // Base per-epoch emission runs FIRST, and unconditionally: it must not depend on the observation window
    // (an empty or gossip-lagged window must not change how much was emitted), or supply.emitted would differ
    // across nodes and fork the chain. See emitBaseThrough — it catches up every epoch since the last emission
    // so the empty-epoch fast-forward and any per-node skew never leave a gap.
    this.emitBaseThrough(epoch);

    // Read a SETTLED trailing window (see SETTLE_ROUNDS): the evidence ends SETTLE_ROUNDS epochs back so the
    // converged contributor set — and thus ZTI updates — is identical on every node.
    const head = epoch - SETTLE_ROUNDS;
    const minEpoch = head - WINDOW_ROUNDS + 1;
    const inWindow = [...this.obsPool.values()].filter((o) => {
      const e = epochOf(o.timestamp);
      return e >= minEpoch && e <= head && o.value !== undefined;
    });
    if (inWindow.length === 0) return;

    const bySubject = new Map<string, SignedObservation[]>();
    for (const o of inWindow) {
      const arr = bySubject.get(o.subject) ?? [];
      arr.push(o);
      bySubject.set(o.subject, arr);
    }

    // Base emission was already credited above (emitBaseThrough), independent of these observations. The loop
    // below only seals Locks and updates ZTI (soft state, not in the state root) so trust and master admission
    // keep working. Miners and resonators earn from coordination settlement and tasks, never from base emission.

    // Walk subjects in a deterministic (sorted) order. Observer ZTI
    // is EMA-updated as the loop runs, so iterating in Map/gossip-arrival order would make trust depend on
    // ingest order and diverge across nodes. Sorting by subject fixes that.
    const subjectsSorted = [...bySubject.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    for (const [subject, obsAll] of subjectsSorted) {
      // latest observation per observer, deterministic
      const latest = new Map<string, SignedObservation>();
      for (const o of obsAll.sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : 1))) {
        latest.set(o.observer, o);
      }
      const obs = [...latest.values()];
      if (obs.length < PROTOCOL.MIN_OBSERVATIONS) continue;
      const domain = obs[0]!.domain;

      const claims = obs.map((o) => {
        const a = this.accounts.get(addressFromPubKey(o.observer));
        const zti = Math.max(0.05, a ? (a.ztiByDomain[domain] ?? a.zti) : 0);
        return { value: o.value as number, zti, confidence: o.confidence, observer: o.observer };
      });
      const median = trustWeightedMedian(claims);
      if (median === null) continue;
      const variation = cvOf(claims.map((c) => c.value));
      if (!(variation < PROTOCOL.CV_THRESHOLD)) continue;

      const totalWeight = claims.reduce((s, c) => s + c.zti * c.confidence, 0);
      let supportWeight = 0;
      const supporters: string[] = [];
      for (const c of claims) {
        const err = median !== 0 ? Math.abs(c.value - median) / Math.abs(median) : 0;
        if (err <= 0.05) { supportWeight += c.zti * c.confidence; supporters.push(c.observer); }
      }
      const supportingTrust = totalWeight > 0 ? supportWeight / totalWeight : 0;
      if (supportingTrust < PROTOCOL.FINALITY_THRESHOLD) continue;

      const sealedAt = epoch * EPOCH_MS;
      const lockBody = {
        subject, domain, epoch, resonantValue: median, cv: variation,
        observationCount: claims.length, supportingTrust, supporters, sealedAt,
      };
      const id = hashHex(canonical({ ...lockBody, k: "lock" }));
      const lock: Lock = { id, ...lockBody };
      // one lock per subject per epoch
      if (this.locks.get(subject)?.epoch === epoch) continue;
      this.locks.set(subject, lock);
      this.lockLog.unshift(lock);
      if (this.lockLog.length > State.LOCK_CAP) this.lockLog.pop();

      // Deterministic storage credit. A miner vouched by >= MIN_STORAGE_VOUCHERS distinct GENESIS-MASTER
      // observers in THIS sealed Lock has proven (via the masters' off-chain random-chunk probes) that it
      // holds + serves the model. We credit its work here from the CONVERGED observations every node shares
      // (vouchedMiners rides on the signed observation), so it is byte-identical across nodes — never from
      // per-master ledger txs, which diverge and freeze finality. Setting lastWorkEpoch unlocks its heartbeat
      // emission in the eligibility check just below. lastWorkEpoch is not in the state root; the emission it
      // unlocks is, and that stays deterministic because the vouch set is derived from consensus observations.
      if (subject === PROTOCOL.FIELD_HEARTBEAT_SUBJECT) {
        const vouches = new Map<Address, Set<Address>>();
        for (const c of claims) {
          const voucher = addressFromPubKey(c.observer);
          if (!this.isGenesisMaster(voucher)) continue;
          for (const m of latest.get(c.observer)?.vouchedMiners ?? []) {
            if (!/^zir1[0-9a-z]{6,}$/.test(m) || m === voucher) continue;
            let s = vouches.get(m); if (!s) { s = new Set(); vouches.set(m, s); }
            s.add(voucher);
          }
        }
        for (const [miner, voucherSet] of vouches) {
          if (voucherSet.size >= PROTOCOL.MIN_STORAGE_VOUCHERS) this.acct(miner).lastWorkEpoch = epoch;
        }
      }

      // update contributor ZTI (soft state, not in the state root; base emission is credited to the fixed
      // genesis-master set after this loop, so no reward is minted per contributor here)
      for (const c of claims) {
        const addr = addressFromPubKey(c.observer);
        const a = this.acct(addr);
        if (!a.pubkey) a.pubkey = c.observer;
        const score = accuracyScore(c.value, median);
        // Verifiable-work gate for master-tenure accrual, scoped to the farmable liveness beacon. On
        // FIELD_HEARTBEAT_SUBJECT a node counts a tenure epoch only if a genesis master recently VOUCHED it
        // (lastWorkEpoch): the master confirmed it is a real, directly-reachable coordinating or storage-
        // serving peer, or it did a settled coordination payout. Genesis masters are always eligible. A bare
        // gossip heartbeat with no master vouch still converges for liveness and lifts ZTI, but earns no
        // tenure, so an idle identity cannot ripen into an earned master without a master attesting it is a
        // genuine participant. (Base emission no longer flows to contributors at all; it goes to the fixed
        // genesis-master set after this loop. This gate now only guards earned-master admission.)
        const eligible = subject !== PROTOCOL.FIELD_HEARTBEAT_SUBJECT
          || this.isGenesisMaster(addr)
          || (a.lastWorkEpoch >= 0 && epoch - a.lastWorkEpoch <= PROTOCOL.WORK_VALIDITY_EPOCHS);
        // Count distinct epochs of genuine, eligible participation for the master-tenure gate.
        if (eligible && a.lastActiveEpoch !== epoch) {
          a.activeEpochs += 1;
          a.lastActiveEpoch = epoch;
          if (a.firstSeenEpoch < 0) a.firstSeenEpoch = epoch;
        }
        if (this.isGenesisMaster(addr)) {
          // Genesis bootstrap masters hold fixed full trust and finalize by quorum with their own node
          // keys. Their trust is not recomputed from accuracy, so a cold start (EMA from 0) cannot drop
          // them out of the finality denominator and stall the chain.
          a.isMaster = true;
          a.zti = Math.max(a.zti, 1.0);
          a.ztiByDomain[domain] = Math.max(a.ztiByDomain[domain] ?? 0, 1.0);
        } else {
          a.accuracy = emaAccuracy(a.accuracy, score);
          // Use the full in-window observation list (obsAll, pre-dedup, already deterministically sorted at
          // line ~435) not the latest-per-observer set, or consistencyScore always sees one value and pins to 1.0.
          const ownVals = obsAll.filter((o) => o.observer === c.observer).map((o) => o.value as number);
          a.consistency = consistencyScore(ownVals);
          a.uptime = Math.min(1, a.uptime * 0.95 + 0.05);
          // Cap how fast trust can RISE within one epoch (descent is unbounded — bad work still drops trust
          // fast). With the tenure gate below, a fresh perfectly-accurate identity cannot vault to master in
          // a single window and seize finality.
          const rawZti = composeZti(a.accuracy, a.consistency, a.uptime);
          const zti = Math.min(rawZti, a.zti + PROTOCOL.MAX_ZTI_ASCENT_PER_EPOCH);
          a.ztiByDomain[domain] = zti;
          a.zti = zti;
          // Master admission needs the ZTI threshold AND earned tenure AND independent support, so finality
          // control is earned over time and across distinct peers, not bought with one accurate burst.
          a.isMaster = zti >= PROTOCOL.MASTER_NODE_ZTI
            && a.activeEpochs >= PROTOCOL.MIN_MASTER_TENURE_EPOCHS
            && supporters.length >= PROTOCOL.MIN_INDEPENDENT_SUPPORTERS;
        }
      }
    }

  }

  /**
   * Deterministic base emission. Credits the fixed genesis-master set a per-epoch reward for every epoch from
   * the last emission up to `epoch`, so supply.emitted is a PURE FUNCTION of the epoch reached — identical on
   * every node regardless of which epochs each one skipped in the empty-epoch fast-forward or which heartbeats
   * it had observed. This is the property finality needs: two nodes at the same epoch always hold the same
   * emitted and the same master balances. Catching up the whole span (rather than emitting one epoch inside
   * runField) is what closes the gap the fast-forward opens. Reward per epoch is perRoundReward(emitted) with
   * NO demand multiplier (that depended on the observed subject count and forked the chain).
   *
   * The whole per-epoch reward is credited to the SETTLER (the first genesis master) alone. The settler then
   * redistributes most of it to the community (miners + resonator owners) each cycle and keeps a small
   * treasury cut — see ZiraNode. Concentrating the mint in one wallet is what lets ~80% of emission flow to
   * participants (a single funder can't redistribute more than it holds). Emission runs only when a genesis
   * master set exists (mainnet); on a masterless devnet nothing mints. Bounded by the earned-share cap.
   */
  private emitBaseThrough(epoch: number): void {
    if (this.genesisMasters.size === 0) { this.lastEmittedEpoch = Math.max(this.lastEmittedEpoch, epoch); return; }
    const cap = PROTOCOL.MAX_SUPPLY_UZIR * PROTOCOL.EARNED_SHARE;
    let credited = 0;
    for (let e = this.lastEmittedEpoch + 1; e <= epoch; e++) {
      const per = perRoundReward(this.supply.emitted, 1);
      if (per <= 0) break;                                // schedule exhausted
      if (this.supply.emitted + per > cap) break;         // would cross the earned-share cap
      this.acct(this.settler).balance += per;
      this.supply.emitted += per;
      credited += per;
    }
    this.lastEmittedEpoch = Math.max(this.lastEmittedEpoch, epoch);
    if (credited > 0) this.record(this.rewardEntry(this.settler, credited, PROTOCOL.FIELD_HEARTBEAT_SUBJECT, epoch));
  }

  private rewardEntry(to: Address, amount: number, subject: string, epoch: number): LedgerEntry {
    const body = {
      network: this.genesis.network, from: "", fromPubKey: "", to, amountUZIR: amount, feeUZIR: 0,
      nonce: 0, kind: "reward" as const, parents: [], timestamp: epoch * EPOCH_MS, memo: "lock " + subject,
    };
    const id = hashHex(canonical({ ...body, e: epoch }));
    return { ...body, id, sig: "", committedEpoch: epoch };
  }

  private record(entry: LedgerEntry): void {
    this.history.unshift(entry);
    if (this.history.length > State.HISTORY_CAP) this.history.pop();
  }

  // ---- consensus surface ----

  accountLeaves(): AccountLeaf[] {
    return [...this.accounts.values()].map((a) => ({ address: a.address, balance: a.balance, nonce: a.nonce }));
  }
  stateRoot(): string {
    // `this.validators` is empty and `lastPoolPayoutBucket` is 0 (=> both omitted, root-neutral) until the
    // decentralization activation epoch, so the root is byte-identical to before the cutover shipped.
    return computeStateRoot(this.accountLeaves(), this.supply, this.activeFounderAddresses(), this.anchorSeats(), this.validators, this.lastPoolPayoutBucket);
  }

  /**
   * Total active master trust, for the checkpoint finality denominator. When the network defines a genesis
   * master set (mainnet), finality rests ONLY on those fixed bootstrap masters: their trust is the
   * denominator, so losing one of four still leaves 3/4 = 0.75 >= 0.67 and finality never stalls on a single
   * master restarting. Counting every account that merely reached MASTER_NODE_ZTI would inflate the
   * denominator with non-voting earned/anchor masters, so a single drop (e.g. 4 voters of 5 known masters)
   * would fall below the threshold and freeze the whole mesh. Earned-master finality decentralization is
   * gated separately and re-enabled once its determinism is proven. Devnet/test (no genesis masters) keeps
   * the all-masters fallback, where the steward is the sole seeded bootstrap master.
   */
  totalMasterTrust(): number {
    const gated = this.genesisMasters.size > 0;
    const active = decentralizationActive(this.lastProcessedEpoch, this.decentralizationActivationEpoch);
    const wmap = active ? this.validatorWeightMap() : null;
    let t = 0;
    for (const a of this.accounts.values()) {
      if (gated && !this.genesisMasters.has(a.address)) {
        // Earned/anchor accounts: excluded UNLESS the decentralization cutover is active AND they are in the
        // sealed, root-committed validator registry. A committed validator's weight is its anchor CLASS trust
        // (A 0.95 .. F 0.45) or the master baseline for earned-only, a pure function of root-committed state,
        // so the denominator is identical on every node. While dormant (active=false) this branch continues.
        if (active && this.validatorSet.has(a.address)) t += wmap!.get(a.address) ?? PROTOCOL.MASTER_NODE_ZTI;
        continue;
      }
      if (a.isMaster) t += a.zti;   // genesis masters (gated) or all masters (devnet/test fallback)
    }
    return t;
  }
  masters(): Account[] {
    return [...this.accounts.values()].filter((a) => a.isMaster);
  }
  /**
   * F1: authoritative map of master public key -> real on-ledger ZTI, for checkpoint finality.
   * Only accounts that actually reached MASTER_NODE_ZTI on-ledger are included, keyed by the
   * pubkey that signs their votes. `tryFinalize`/`receiveVote` use this instead of the vote's
   * self-declared `voterZti`, so a forged high voterZti from a non-master cannot manufacture finality.
   */
  masterZtiMap(): Map<string, number> {
    // Mirrors totalMasterTrust: on a network with a genesis master set, only those fixed masters' votes
    // count toward finality, so the numerator and denominator stay consistent and a single master drop
    // cannot wedge the mesh. Devnet/test falls back to all masters (steward-only bootstrap).
    const gated = this.genesisMasters.size > 0;
    const active = decentralizationActive(this.lastProcessedEpoch, this.decentralizationActivationEpoch);
    const wmap = active ? this.validatorWeightMap() : null;
    const m = new Map<string, number>();
    for (const a of this.accounts.values()) {
      if (!a.pubkey) continue;
      if (gated && !this.genesisMasters.has(a.address)) {
        // Committed validators vote at their anchor CLASS trust (or master baseline), keyed by their signing
        // pubkey, mirroring totalMasterTrust so numerator and denominator stay consistent. Dormant => continue.
        if (active && this.validatorSet.has(a.address)) m.set(a.pubkey, wmap!.get(a.address) ?? PROTOCOL.MASTER_NODE_ZTI);
        continue;
      }
      if (a.isMaster) m.set(a.pubkey, a.zti);
    }
    return m;
  }

  /**
   * Finality voting weight of each committed validator (decentralization cutover), keyed by address.
   * An anchor holder votes at its BEST-owned anchor's CLASS TRUST (A 0.95, B 0.85, C 0.75, D 0.65, E 0.55,
   * F 0.45 — the six anchor classes carry different weight), which is already committed to the state root in
   * the anchor leaf (`a.zti`), so higher classes finalize with more weight. An earned-only validator
   * (isMaster, no anchor) votes at the master baseline (MASTER_NODE_ZTI = 0.70). We use class TRUST, not the
   * 6..1 routing weight, so no validator ever outweighs a genesis master (1.0) and finality can't be seized
   * by a few top-class seats. Pure function of root-committed state (anchor ownership + class zti), so every
   * node computes identical weights — no per-node ZTI enters the denominator.
   */
  private validatorWeightMap(): Map<Address, number> {
    const m = new Map<Address, number>();
    for (const a of this.anchors.values()) {
      if (!a.owner || !this.validatorSet.has(a.owner)) continue;
      m.set(a.owner, Math.max(m.get(a.owner) ?? 0, a.zti));
    }
    for (const addr of this.validatorSet) if (!m.has(addr)) m.set(addr, PROTOCOL.MASTER_NODE_ZTI);
    return m;
  }

  /**
   * Seal the validator registry (decentralization cutover). On each VALIDATOR_SEAL_INTERVAL boundary
   * at/after activation, commit the set of NON-genesis addresses that qualify to finalize, computed
   * purely from the just-applied (converged) state so every node seals an identical set:
   *   - earned-work path: `isMaster` (ZTI threshold + tenure + independent supporters, already gated in
   *     runField) exactly "like a master node."
   *   - anchor path: owns at least one anchor seat (root-committed, scarce) — but ONLY while actually
   *     contributing, so an anchor is a right to validate that must be BACKED BY ONGOING WORK, never a
   *     passive seat that finalizes without serving.
   * BOTH paths additionally require, using ONLY deterministic applied state (never per-node ingest-time
   * state): (a) recent verifiable work — a genesis master vouched within WORK_VALIDITY_EPOCHS that the node
   * serves/stores (lastWorkEpoch, Lock-derived); and (b) `activeEpochs > 0`, i.e. it took part in applied
   * field convergence. (b) is critical for determinism: an account's signing `pubkey` is set both at ingest
   * (per-node gossip timing) AND in runField (applied). Requiring activeEpochs>0 — set in the SAME runField
   * pass that sets the pubkey — guarantees the pubkey came from applied state, so every node at the same
   * epoch resolves the identical (address, pubkey) set. Without it, a node that merely INGESTED a heartbeat
   * (pubkey present) would seal a member another node hasn't, forking the root. Genesis masters are excluded
   * (they already anchor the base quorum). Deduped, sorted, capped at MAX_VALIDATORS. INERT while dormant.
   */
  private sealValidators(epoch: number): void {
    if (!decentralizationActive(epoch, this.decentralizationActivationEpoch)) return;   // dormant: registry stays empty
    // Re-seal on EVERY active processed epoch, NOT on a `epoch % INTERVAL` boundary. A modulo cadence is
    // unsafe with the empty-epoch fast-forward: a node that fast-forwards past a boundary epoch would never
    // seal there while an incremental node would, so their registries — and thus roots — would diverge (a
    // fork). Sealing every processed epoch makes the registry a pure function of the applied state at
    // `lastProcessedEpoch`, identical on every node at the same epoch.
    const anchorOwners = new Set<Address>();
    for (const a of this.anchors.values()) if (a.owner) anchorOwners.add(a.owner);
    const eligible: Address[] = [];
    for (const a of this.accounts.values()) {
      if (this.isGenesisMaster(a.address)) continue;                     // already in the base quorum
      // Deterministic applied-state gates only. activeEpochs>0 guarantees the pubkey is applied-state-derived
      // (set in the same runField pass), closing the ingest-time pubkey fork; !pubkey is then a safe belt-and-
      // braces check. recentWork ties membership to ACTUAL ongoing contribution (a master-vouched serving node).
      if (a.activeEpochs <= 0 || !a.pubkey) continue;
      const recentWork = a.lastWorkEpoch >= 0 && epoch - a.lastWorkEpoch <= PROTOCOL.WORK_VALIDITY_EPOCHS;
      if (!recentWork) continue;
      if (a.isMaster || anchorOwners.has(a.address)) eligible.push(a.address);   // earned-master OR contributing anchor holder
    }
    eligible.sort();
    this.validators = eligible.slice(0, PROTOCOL.MAX_VALIDATORS);
    this.validatorSet = new Set(this.validators);
  }

  /** The sealed validator registry (decentralization cutover); empty while dormant. Read-only view. */
  validatorRegistry(): Address[] { return [...this.validators]; }

  /** May this address issue a pool_payout? The ROOT-COMMITTED settler set: genesis masters (always) plus
   *  sealed validators. Deterministic on every node, so pool-payout authorization can never fork. */
  isAuthorizedSettler(address: Address): boolean {
    return this.isGenesisMaster(address) || this.validatorSet.has(address);
  }
  /** The pool-payout idempotency watermark (decentralization cutover); 0 while dormant. */
  poolPayoutBucket(): number { return this.lastPoolPayoutBucket; }

  /**
   * A read-only view of the decentralization cutover state, for RPC/monitoring (crucially, the live SHADOW
   * proof before activation: watch that the sealed registry + weights are identical across nodes). Everything
   * here is derived from root-committed state, so two honest nodes at the same epoch return the identical view.
   */
  decentralizationView(): { active: boolean; activationEpoch: number; currentEpoch: number; poolPayoutBucket: number; genesisMasterTrust: number; totalMasterTrust: number; validators: { address: Address; weight: number }[] } {
    const active = this.decentralizationActiveNow();
    const wmap = active ? this.validatorWeightMap() : new Map<Address, number>();
    let genesisTrust = 0;
    for (const a of this.accounts.values()) if (this.genesisMasters.has(a.address) && a.isMaster) genesisTrust += a.zti;
    return {
      active,
      activationEpoch: this.decentralizationActivationEpoch,
      currentEpoch: this.lastProcessedEpoch,
      poolPayoutBucket: this.lastPoolPayoutBucket,
      genesisMasterTrust: genesisTrust,
      totalMasterTrust: this.totalMasterTrust(),
      validators: this.validators.map((a) => ({ address: a, weight: wmap.get(a) ?? PROTOCOL.MASTER_NODE_ZTI })),
    };
  }
  /** Whether the decentralization cutover is active at the current processed epoch (dormant => false). */
  decentralizationActiveNow(): boolean { return decentralizationActive(this.lastProcessedEpoch, this.decentralizationActivationEpoch); }
  /** The emission pool account = the settler (masters[0]); pool_payout is funded from here. */
  poolAddress(): Address { return this.settler; }

  // ---- views for the RPC ----

  /** Provisional balance including pooled, not yet processed, transactions. */
  provisionalBalance(address: Address): number {
    let bal = this.balanceOf(address);
    for (const tx of this.txPool.values()) {
      if (tx.kind === "batch_transfer") {
        // A batch debits the sender the full pool and credits each memo output; tx.to is a self-placeholder,
        // so it must NOT be credited here.
        if (tx.from === address) bal -= tx.amountUZIR + tx.feeUZIR;
        const outs = parseBatchOutputs(tx.memo);
        if (outs) for (const [to, amt] of outs) if (to === address) bal += amt;
        continue;
      }
      if (tx.kind === "pool_payout") {
        // Pool-funded: the emission pool (this.settler) pays BOTH the outputs and the fee; the sender pays nothing.
        if (this.settler === address) bal -= tx.amountUZIR + tx.feeUZIR;
        const meta = parsePoolPayout(tx.memo);
        if (meta) for (const [to, amt] of meta.outputs) if (to === address) bal += amt;
        continue;
      }
      if (tx.from === address) bal -= tx.amountUZIR + tx.feeUZIR;
      if (tx.to === address && tx.kind !== "bond_burn") bal += tx.amountUZIR;
    }
    return bal;
  }
  provisionalNonce(address: Address): number {
    let n = this.nonceOf(address);
    for (const tx of this.txPool.values()) if (tx.from === address) n += 1;
    return n;
  }

  recentHistory(address: Address | null, limit: number): LedgerEntry[] {
    if (!address) return this.history.slice(0, limit);
    const out: LedgerEntry[] = [];
    for (const e of this.history) {
      if (e.from === address || e.to === address) {
        out.push(e);
      } else if (e.kind === "pool_payout" || e.kind === "batch_transfer") {
        // Pooled payouts (field participation, coordination) name the pool as `to` and carry every recipient's
        // slice in the signed memo, so a paid miner is neither `from` nor `to` and its earnings would be invisible
        // in the wallet and explorer. Surface the address's own slice as a per-recipient row (its share as the
        // amount, the pool as the payer). Display-only: the ledger and the state root are unchanged.
        const outs = e.kind === "pool_payout" ? parsePoolPayout(e.memo)?.outputs : parseBatchOutputs(e.memo);
        const slice = outs?.find(([a]) => a === address);
        if (slice) out.push({ ...e, to: address, amountUZIR: slice[1] });
      }
      if (out.length >= limit) break;
    }
    return out;
  }
  recentLocks(limit: number): Lock[] { return this.lockLog.slice(0, limit); }
  valueOf(subject: string): Lock | null { return this.locks.get(subject) ?? null; }
  anchorSeats(): Anchor[] { return [...this.anchors.values()].sort((a, b) => a.id.localeCompare(b.id)); }
  anchorSeat(id: string): Anchor | null { return this.anchors.get(id) ?? null; }
  anchorsOwnedBy(owner: Address): Anchor[] { return this.anchorSeats().filter((a) => a.owner === owner); }
  anchorListings(): Anchor[] { return this.anchorSeats().filter((a) => a.status === "listed" && a.listedPriceUZIR); }

  auditEmittedBurned(): { emitted: number; burned: number } {
    let emitted = 0, burned = 0;
    for (const e of this.history) {
      if (e.kind === "reward") emitted += e.amountUZIR;
      else if (e.kind === "bond_burn") burned += e.amountUZIR + feeAndBurn(e.feeUZIR).burned;
      else burned += feeAndBurn(e.feeUZIR).burned;
    }
    return { emitted, burned };
  }

  poolSize(): { txs: number; observations: number } {
    return { txs: this.txPool.size, observations: this.obsPool.size };
  }

  /** Current pending events, for periodic re-gossip so peers converge despite mesh races. */
  poolEvents(limit = 100): { txs: SignedTx[]; observations: SignedObservation[] } {
    return {
      txs: [...this.txPool.values()].slice(0, limit),
      observations: [...this.obsPool.values()].slice(0, limit),
    };
  }

  /**
   * After adopting a fast-sync snapshot at `epoch`, discard any pooled tx/observation whose epoch is
   * already covered by the snapshot. Those events' effects are baked into the adopted account state,
   * supply, and locks; reprocessing them must NOT mutate state again. Transfers are nonce-guarded so
   * re-applying them is already a no-op, but the field (PoR) path is NOT idempotent against a later
   * re-lock: a backfilled observation whose epoch falls inside the snapshot's trailing window could
   * seal a DIFFERENT lock and re-mint a reward the snapshot already counted, shifting emitted/balances
   * and forking the state root by a small fixed offset. Dropping events through the adopted epoch makes
   * fast-sync converge exactly: the joiner forward-applies only genuinely post-snapshot events. Their
   * ids stay in knownIds so a re-gossip cannot re-pool them. Returns how many of each were dropped.
   */
  dropPooledThrough(epoch: number): { txs: number; observations: number } {
    let txs = 0, observations = 0;
    for (const [id, t] of this.txPool) if (epochOf(t.timestamp) <= epoch) { this.txPool.delete(id); txs++; }
    for (const [id, o] of this.obsPool) if (epochOf(o.timestamp) <= epoch) { this.obsPool.delete(id); observations++; }
    return { txs, observations };
  }

  /**
   * Adopt a verified fast-sync snapshot and arm the convergence floor in one step. Loads the snapshot
   * state, raises the floor to the adopted epoch so no already-covered backfill event can reprocess,
   * and purges any events that were pooled before adoption (e.g. tail events that arrived during the
   * join handshake). After this, the node forward-applies only post-snapshot events and converges
   * exactly to the mesh root. Use this instead of loadSnapshot on the fast-sync path.
   */
  adoptFastSyncSnapshot(snap: any): { txs: number; observations: number } {
    this.loadSnapshot(snap);
    this.fastSyncFloorEpoch = Math.max(this.fastSyncFloorEpoch, this.lastProcessedEpoch);
    return this.dropPooledThrough(this.fastSyncFloorEpoch);
  }

  /** Snapshot for persistence. */
  snapshot(): object {
    return {
      lastProcessedEpoch: this.lastProcessedEpoch,
      lastEmittedEpoch: this.lastEmittedEpoch,
      accounts: [...this.accounts.values()],
      founders: this.activeFounderAddresses(),
      supply: this.supply,
      locks: [...this.locks.values()],
      anchors: this.anchorSeats(),
      validators: this.validators,   // sealed validator registry (empty while dormant); part of the root when active
      lastPoolPayoutBucket: this.lastPoolPayoutBucket,   // pool-payout idempotency watermark (0 while dormant)
    };
  }
  loadSnapshot(snap: any): void {
    if (!snap) return;
    this.lastProcessedEpoch = snap.lastProcessedEpoch ?? this.lastProcessedEpoch;
    // Restore the emission cursor. Fall back to lastProcessedEpoch for snapshots written before this field
    // existed, so emission neither double-counts nor re-runs the whole history after a restore.
    this.lastEmittedEpoch = snap.lastEmittedEpoch ?? this.lastProcessedEpoch;
    this.setAuthorizedFounders(Array.isArray(snap.founders) ? snap.founders : (this.genesis.founders ?? [this.founder]));
    if (Array.isArray(snap.accounts)) {
      this.accounts.clear();
      // Deep-copy each leaf: loadSnapshot must not alias the caller's snapshot objects, or later applyTx
      // mutations (balance/nonce/zti) would write back into the shared snapshot and corrupt any other
      // consumer of the same object (e.g. a peer snapshot adopted by reference). JSON round-trip is the
      // simplest structural clone for these plain records.
      for (const a of snap.accounts) this.accounts.set(a.address, structuredCloneLeaf(a));
      for (const founder of this.authorizedFounders) if (!this.accounts.has(founder)) this.accounts.set(founder, this.blankAccount(founder));
    }
    if (snap.supply) this.supply = { ...snap.supply };
    if (Array.isArray(snap.locks)) for (const l of snap.locks) this.locks.set(l.subject, structuredCloneLeaf(l));
    if (Array.isArray(snap.anchors)) {
      this.anchors.clear();
      for (const a of snap.anchors) this.anchors.set(a.id, structuredCloneLeaf(a));
    }
    // Restore the sealed validator registry (part of the state root when active), so a fast-synced node
    // adopts the same electorate and computes the same root. Absent on pre-registry snapshots => empty.
    this.validators = Array.isArray(snap.validators) ? [...snap.validators] : [];
    this.validatorSet = new Set(this.validators);
    this.lastPoolPayoutBucket = typeof snap.lastPoolPayoutBucket === "number" ? snap.lastPoolPayoutBucket : 0;
    // Re-assert the genesis master quorum after replacing accounts, so a restored node always knows the
    // bootstrap finality set even if an older snapshot predated it. Root-neutral; idempotent.
    this.seedGenesisMasters();
    log.info(`loaded snapshot at epoch ${this.lastProcessedEpoch}, ${this.accounts.size} accounts`);
  }
}
