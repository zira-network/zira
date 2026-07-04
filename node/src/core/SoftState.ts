// node/src/core/SoftState.ts
// Eventually consistent shared application data that is gossiped but is not part of the consensus
// ledger: the resonator directory and marketplace, provider profiles, online providers, the live
// query relay, and founder model recommendations. The money behind these (funding, hiring, query
// rewards) is always real signed transactions on the ledger. This layer is the shared, replaceable
// view, but every record that a user authors now carries a Signed mixin and is verified here.
import {
  verify as edVerify, verifyRecord, addressFromPubKey, PROTOCOL,
  NETWORK_RESONATOR_SPECS, MAINNET_NETWORK_RESONATOR_OWNER,
  DEFAULT_ANCHOR_CODE_COMMITMENTS, MAINNET_ANCHOR_STEWARD, anchorResonatorSpec, anchorResonatorId,
  materializedAnchorResonator, type AnchorClass,
  type Resonator, type Task, type Domain, type Listing, type ProviderProfile, type ModelRecommendation, type Signed,
} from "@zira/protocol";

// The seeded network Resonators carry a deterministic genesis ZTI standing (like anchor seats), so the
// node accepts their declared seed ZTI when they FIRST appear (signed by the canonical owner). After
// that, ZTI is node-derived from settled work like every other Resonator.
const NETWORK_RESONATOR_SEED_ZTI = new Map(NETWORK_RESONATOR_SPECS.map((s) => [s.id, s.zti] as const));
// The 512 anchor Resonators (one per anchor position) also carry a deterministic genesis ZTI standing
// equal to their position's class ZTI. They are seeded/transferred only by the anchor steward authority,
// so a third party cannot forge anchor standing. Keyed by the deterministic anchor-resonator id.
const ANCHOR_RESONATOR_SEED_ZTI = new Map(
  DEFAULT_ANCHOR_CODE_COMMITMENTS.map((c) => [anchorResonatorId(c.seatId), anchorResonatorSpec(c.seatId, c.classCode).zti] as const),
);
import type { ProviderAnnounce, QueryMsg, AnswerMsg } from "./types.js";
import { log } from "../log.js";

const PROVIDER_TTL_MS = 90_000;
// Answers to a query must survive long enough for the settler to see >= MIN_ANSWERS of them: autonomous
// coordination opens its settle window at bucketStart + 30s and retries once per ~30s reap tick, while a CPU
// answer can take ~35s to generate. At the old 60s the answers were pruned after roughly one settle tick, so
// coordination could never settle even when enough nodes answered. Keep answers well past the settle window
// (still under the 5 min autonomous bucket, so query ids never collide across buckets).
const QUERY_TTL_MS = 240_000;
// DoS guard: the most answers any single query will retain. Far above any honest contributor count
// for one query; overflow is dropped. Soft state, so this is consensus-neutral (see addAnswer).
const MAX_ANSWERS_PER_QUERY = 256;

export class SoftState {
  // The address authorized to mint and move the 512 anchor Resonators (the anchor-reserve steward
  // wallet). Defaults to the mainnet steward; the node sets it to the genesis anchor steward of the
  // active network so devnet/test networks authenticate their own steward. Anchor resonators are
  // accepted only when signed by this address, so anchor standing cannot be forged by a third party.
  anchorStewardAddress: string = MAINNET_ANCHOR_STEWARD;
  resonators = new Map<string, Resonator>();
  tasks = new Map<string, Task>();
  private settledTaskIds = new Set<string>();
  providers = new Map<string, { p: ProviderAnnounce; lastSeen: number }>();
  providerProfiles = new Map<string, ProviderProfile>();      // by address
  recommendations = new Map<string, ModelRecommendation>();   // by id
  queries = new Map<string, QueryMsg>();
  answers = new Map<string, AnswerMsg[]>();

  /** Verify the Signed mixin before accepting any user authored record. */
  private mustVerify(record: Signed | undefined, context: string, id: string): boolean {
    if (!record || !verifyRecord(record)) {
      log.warn(`[SoftState] rejected unsigned/invalid ${context}`, id);
      return false;
    }
    return true;
  }

  // `agentBalanceUZIR`, when provided by the node, is the resonator agent wallet's REAL ledger balance.
  // The operating float is never the owner-declared record value (which is signed as 0 at creation and so
  // cannot be trusted or rewritten after signing) — the node reads it from the ledger, gates the creation
  // cost on it, and stores it so Discover shows the true float. Absent (internal seed callers) it falls
  // back to the record value.
  upsertResonator(r: Resonator, agentBalanceUZIR?: number): boolean {
    if (!this.mustVerify(r, "Resonator", r?.id ?? "?")) return false;
    const floatUZIR = agentBalanceUZIR ?? (r.balanceUZIR ?? 0);
    // Anchor Resonators (one per anchor position) are minted and moved only by the anchor steward
    // authority: the steward signs them while setting `owner` to the position's current on-chain owner,
    // so they follow their position through transfers (the steward re-publishes the record after a
    // position_transfer settles). For anchor resonators we therefore require the steward key as signer
    // rather than owner==pubKey. Every other Resonator must still be self-signed by its owner.
    const isAnchorResonator = ANCHOR_RESONATOR_SEED_ZTI.has(r.id);
    const signerAddress = addressFromPubKey(r.pubKey);
    const prev = this.resonators.get(r.id);
    if (isAnchorResonator) {
      if (signerAddress !== this.anchorStewardAddress) { log.warn("[SoftState] anchor resonator not signed by the steward authority", r.id); return false; }
    } else if (prev && r.owner !== prev.owner) {
      // An ownership change is a TRANSFER, and only the CURRENT owner may authorize it: they sign a record
      // naming the new owner. This both enables resonator transfer (spec §7) and closes a hijack gap, since
      // otherwise a third party could republish a resonator under their own owner with a newer timestamp.
      // After the handoff the new owner controls the record with their own self-signed updates.
      if (signerAddress !== prev.owner) { log.warn("[SoftState] resonator transfer not signed by the current owner", r.id); return false; }
    } else if (signerAddress !== r.owner) {
      log.warn("[SoftState] resonator pubKey does not match owner", r.id); return false;
    }
    // replay protection: only accept a strictly newer record
    if (prev && (prev.updatedAt ?? 0) >= (r.updatedAt ?? 0)) return false;
    // No repeated templates: a listed Resonator must have a name distinct from every other listed
    // Resonator, so a template (or any listing) cannot be cloned verbatim and flood Discover. The
    // owner has to give it its own name. Re-listing the same Resonator (same id) is unaffected.
    if (r.listed) {
      const norm = (s?: string) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
      for (const other of this.resonators.values()) {
        if (other.id !== r.id && other.listed && norm(other.name) === norm(r.name)) {
          log.warn("[SoftState] rejected duplicate listed Resonator name", r.name);
          return false;
        }
      }
    }
    // Creation cost: a brand-new user Resonator must be funded with at least RESONATOR_CREATION_COST_UZIR
    // at creation, so it stands up with a real operating float and standing one up carries a meaningful,
    // non-trivial commitment (anti-spam for Discover). This is the owner's own ZIR moved into their own
    // Resonator's wallet, NOT a fee/burn — supply is unchanged. The seeded network/anchor resonators are
    // exempt: network resonators get a steward-funded float, anchor resonators draw on the position's
    // vesting allocation rather than a seeded balance, and the founder's default "zira" system resonator
    // is field-answered (no per-resonator float). Only enforced for the FIRST appearance of a record.
    const isSeededResonator = isAnchorResonator || NETWORK_RESONATOR_SEED_ZTI.has(r.id) || r.id === "zira";
    if (!prev && !isSeededResonator && floatUZIR < PROTOCOL.RESONATOR_CREATION_COST_UZIR) {
      log.warn("[SoftState] rejected under-funded new Resonator (below creation cost)", r.id, floatUZIR);
      return false;
    }
    // Trust and earnings are NOT the owner's to declare. ZTI, per-domain ZTI, jobs done, and total
    // earned are derived by the node from settled work (applyReleasedTask) and never read from the
    // signed record. We preserve the node's own values (zero for a brand-new Resonator), so a signed
    // record can never buy, forge, or reset standing in Discover. The owner only controls name,
    // purpose, domains, price, limits, listed/paused, and the resonance toggle.
    // Seeded network Resonators carry a deterministic genesis ZTI standing on first appearance, but only
    // when signed by the canonical owner — so the seed cannot be forged by a third party. Every other
    // Resonator starts at zero standing; trust is earned.
    const seedZti = NETWORK_RESONATOR_SEED_ZTI.get(r.id) ?? ANCHOR_RESONATOR_SEED_ZTI.get(r.id);
    // A network resonator is canonical when self-signed or signed by the network-resonator owner; an
    // anchor resonator is canonical when signed by the anchor steward authority (checked above).
    const isCanonicalOwner = isAnchorResonator || r.owner === MAINNET_NETWORK_RESONATOR_OWNER || signerAddress === r.owner;
    const seedStanding = !prev && seedZti !== undefined && isCanonicalOwner;
    const earned = prev
      ? { zti: prev.zti, ztiByDomain: prev.ztiByDomain, jobsDone: prev.jobsDone, totalEarnedUZIR: prev.totalEarnedUZIR }
      : seedStanding
        ? { zti: seedZti!, ztiByDomain: Object.fromEntries(r.domains.map((d) => [d, seedZti!])) as Record<string, number>, jobsDone: 0, totalEarnedUZIR: 0 }
        : { zti: 0, ztiByDomain: {} as Record<string, number>, jobsDone: 0, totalEarnedUZIR: 0 };
    // Store the ledger-derived float so Discover reflects real funds, not the owner-declared value.
    this.resonators.set(r.id, { ...r, ...earned, balanceUZIR: floatUZIR });
    return true;
  }

  /**
   * Deterministically MATERIALIZE the 512 anchor Resonators on THIS node from the anchor seats, with no
   * signing key. Both the anchor positions and their class ZTI are derived by every node from genesis
   * with no signer (State seeds them directly); the anchor resonators must materialize the same way so a
   * node WITHOUT the steward/anchor-reserve key still lists all 512 anchor resonators on the anchor-reserve
   * wallet. The record is a pure function of (seatId, classCode, owner) — the agent wallet is derived from a
   * fixed PUBLIC namespace, not a private key — so every node computes the identical record. We write these
   * genesis-derived records straight into the directory (like positions in State), bypassing the gossip
   * authentication in upsertResonator: that check still guards records arriving over the wire, so a third
   * party cannot forge anchor standing, while every node independently reconstructs the canonical set.
   *
   * Owner follows each seat's current on-chain owner, so a transfer re-keys its resonator deterministically.
   * Earned standing (jobs, totalEarned, learned domain ZTI) is preserved across re-materialization. Returns
   * how many records were created or re-keyed. Soft state, mints no ZIR, consensus-neutral.
   */
  materializeAnchorResonators(seats: { id: string; classCode: AnchorClass; owner?: string }[], now: number): number {
    let changed = 0;
    for (const seat of seats) {
      if (!seat.owner) continue;
      const id = anchorResonatorId(seat.id);
      const prev = this.resonators.get(id);
      if (prev && prev.owner === seat.owner) continue;          // already materialized for this owner
      const record = materializedAnchorResonator({
        seatId: seat.id,
        classCode: seat.classCode,
        owner: seat.owner,
        perTxUZIR: PROTOCOL.UZIR_PER_ZIR,
        perDayUZIR: 8 * PROTOCOL.UZIR_PER_ZIR,
        priceUZIR: PROTOCOL.UZIR_PER_ZIR,
        createdAt: prev?.createdAt ?? now,
        updatedAt: prev ? Math.max(now, (prev.updatedAt ?? 0) + 1) : now,
      });
      // Carry earned standing (and the seeded class ZTI for a brand-new record). The position's class ZTI
      // is the deterministic genesis seed; learned ZTI/jobs/earnings from settled work are preserved.
      const seedZti = ANCHOR_RESONATOR_SEED_ZTI.get(id) ?? record.zti;
      const carried = prev
        ? { zti: prev.zti, ztiByDomain: prev.ztiByDomain, jobsDone: prev.jobsDone, totalEarnedUZIR: prev.totalEarnedUZIR }
        : { zti: seedZti, ztiByDomain: Object.fromEntries(record.domains.map((d) => [d, seedZti])) as Record<string, number>, jobsDone: 0, totalEarnedUZIR: 0 };
      // Materialized genesis-derived records are unsigned soft state (like positions). The pubKey/sig
      // fields are present-but-empty markers: these records are reconstructed locally, not gossiped, so
      // they are never re-verified. Gossiped anchor resonators still go through upsertResonator.
      this.resonators.set(id, { ...record, ...carried, pubKey: "", sig: "" });
      changed++;
    }
    return changed;
  }

  upsertTask(t: Task): boolean {
    const prev = this.tasks.get(t.id);
    if (prev && JSON.stringify(prev) === JSON.stringify(t)) return false;
    this.tasks.set(t.id, t);
    this.applyReleasedTask(t);
    return true;
  }
  listTasks(): Task[] { return [...this.tasks.values()]; }

  private applyReleasedTask(t: Task): void {
    if (t.status !== "released" || this.settledTaskIds.has(t.id)) return;
    const r = this.resonators.get(t.resonatorId);
    if (!r) return;
    this.settledTaskIds.add(t.id);
    const quality = Math.max(0.05, Math.min(1, t.minZti || 0.25));
    const budgetSignal = Math.min(1, Math.log10(Math.max(10_000, t.budgetUZIR)) / 8);
    const gain = Math.max(0.01, Math.min(0.08, 0.015 + quality * 0.03 + budgetSignal * 0.02));
    const domainPrev = r.ztiByDomain[t.domain] ?? r.zti ?? 0;
    const domainNext = Math.min(1, domainPrev + (1 - domainPrev) * gain);
    const ztiValues = { ...r.ztiByDomain, [t.domain]: domainNext };
    const overall = Object.values(ztiValues).reduce((s, v) => s + (v ?? 0), 0) / Math.max(1, Object.keys(ztiValues).length);
    this.resonators.set(r.id, {
      ...r,
      zti: Number(overall.toFixed(4)),
      ztiByDomain: ztiValues,
      jobsDone: (r.jobsDone ?? 0) + 1,
      totalEarnedUZIR: (r.totalEarnedUZIR ?? 0) + t.budgetUZIR,
      updatedAt: t.resolvedAt ?? Date.now(),
      status: r.resonanceEnabled ? "learning" : "idle",
    });
  }

  /** Online presence announcement (challenge signed). Kept for query routing and tipping. */
  upsertProvider(p: ProviderAnnounce, now: number): boolean {
    if (!edVerify(p.challenge, p.sig, p.pubKey)) return false;
    if (addressFromPubKey(p.pubKey) !== p.address) return false;
    this.providers.set(p.pubKey, { p, lastSeen: Math.max(p.ts, now - PROVIDER_TTL_MS) });
    return true;
  }

  /** Signed Tier 2 capability profile. Replay protected by updatedAt. */
  upsertProviderProfile(p: ProviderProfile): boolean {
    if (!this.mustVerify(p, "ProviderProfile", p?.address ?? "?")) return false;
    if (addressFromPubKey(p.pubKey) !== p.address) { log.warn("[SoftState] provider profile pubKey does not match address", p.address); return false; }
    const prev = this.providerProfiles.get(p.address);
    if (prev && prev.updatedAt >= p.updatedAt) return false;
    this.providerProfiles.set(p.address, p);
    return true;
  }
  listProviderProfiles(): ProviderProfile[] { return [...this.providerProfiles.values()]; }

  /** Founder advisory recommendation (signed). */
  upsertRecommendation(rec: ModelRecommendation): boolean {
    if (!this.mustVerify(rec, "ModelRecommendation", rec?.id ?? "?")) return false;
    const prev = this.recommendations.get(rec.id);
    if (prev && prev.publishedAt >= rec.publishedAt) return false;
    this.recommendations.set(rec.id, rec);
    return true;
  }
  listRecommendations(): ModelRecommendation[] {
    return [...this.recommendations.values()].sort((a, b) => b.publishedAt - a.publishedAt);
  }

  addQuery(q: QueryMsg): boolean {
    if (this.queries.has(q.id)) return false;
    this.queries.set(q.id, q);
    return true;
  }
  addAnswer(a: AnswerMsg): boolean {
    if (!edVerify(a.queryId + "\n" + a.answer, a.sig, a.provider)) return false;
    const arr = this.answers.get(a.queryId) ?? [];
    if (arr.some((x) => x.id === a.id)) return false;
    // DoS guard: cap answers per query so a flood of distinct signed answers on one query id cannot
    // grow this array without bound. Answers are SOFT state (not in the consensus state root) and
    // settlement dedupes to the latest per provider, so dropping overflow answers is consensus-neutral.
    // The cap is generous (far above any honest provider count) so it never bites real coordination.
    if (arr.length >= MAX_ANSWERS_PER_QUERY) return false;
    arr.push(a);
    this.answers.set(a.queryId, arr);
    return true;
  }

  prune(now: number): void {
    for (const [k, v] of this.providers) if (now - v.lastSeen > PROVIDER_TTL_MS) this.providers.delete(k);
    for (const [k, q] of this.queries) if (now - q.postedAt > QUERY_TTL_MS) { this.queries.delete(k); this.answers.delete(k); }
  }

  onlineProviders(now: number): ProviderAnnounce[] {
    return [...this.providers.values()].filter((v) => now - v.lastSeen <= PROVIDER_TTL_MS).map((v) => v.p);
  }

  openQueries(domains: Domain[], now: number): QueryMsg[] {
    return [...this.queries.values()].filter((q) => now - q.postedAt <= QUERY_TTL_MS && (domains.length === 0 || domains.includes(q.domain)));
  }

  marketplace(args: { sort: string; domain?: Domain; q?: string; limit?: number }): Listing[] {
    let list = [...this.resonators.values()].filter((r) => r.listed);
    if (args.domain) list = list.filter((r) => r.domains.includes(args.domain!));
    if (args.q) { const qq = args.q.toLowerCase(); list = list.filter((r) => (r.name + " " + r.purpose).toLowerCase().includes(qq)); }
    const listings: Listing[] = list.map((r) => ({
      resonatorId: r.id, name: r.name, owner: r.owner, purpose: r.purpose, domains: r.domains,
      zti: r.zti, ztiByDomain: r.ztiByDomain, priceUZIR: r.priceUZIR, jobsDone: r.jobsDone,
      totalEarnedUZIR: r.totalEarnedUZIR, lastActiveAt: r.createdAt,
      pubKey: r.pubKey, sig: r.sig,
    }));
    listings.sort((a, b) => {
      switch (args.sort) {
        case "price": return a.priceUZIR - b.priceUZIR;
        case "jobs": return b.jobsDone - a.jobsDone;
        case "recent": return b.lastActiveAt - a.lastActiveAt;
        case "domainZti": return (b.ztiByDomain[args.domain as Domain] ?? 0) - (a.ztiByDomain[args.domain as Domain] ?? 0);
        default: return b.zti - a.zti;
      }
    });
    return listings.slice(0, args.limit ?? 50);
  }
}
