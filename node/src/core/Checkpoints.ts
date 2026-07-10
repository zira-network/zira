// node/src/core/Checkpoints.ts
// Proof of Resonance finality. After a node processes an epoch, if it is a master node (ZTI >=
// 0.70) it signs a checkpoint vote over the deterministic state root and gossips it. When votes
// for one root reach 0.67 of the active master trust, that checkpoint is final and irreversible.
import {
  checkpointId, verifyCheckpointVote, tryFinalize,
  sign as edSign, canonical,
  type CheckpointBody, type SignedCheckpointVote, type FinalizedCheckpoint, type Keypair,
} from "@zira/protocol";
import { log } from "../log.js";

export class Checkpoints {
  // epoch -> stateRoot -> votes
  private votes = new Map<number, Map<string, SignedCheckpointVote[]>>();
  private seen = new Set<string>();
  finalized = new Map<number, FinalizedCheckpoint>();
  lastFinalizedEpoch = -1;
  lastFinalizedRoot = "00";

  // Memory bounds. These three structures are local finality bookkeeping, NOT part of the deterministic
  // state root, so trimming settled history is consensus-neutral and cannot fork a node. They are the
  // only checkpoint structures that would otherwise grow without limit (one bucket/entry per epoch, one
  // id per vote, forever), so a long-running node or a vote flood is the thing being bounded here.
  private static readonly RETAIN_VOTE_EPOCHS = 256;   // keep vote buckets for recent epochs only
  private static readonly FINALIZED_CAP = 4096;       // keep the most recent finalized checkpoints
  private static readonly SEEN_CAP = 200_000;         // cap the vote-id dedup set

  constructor(private network: string) {}

  /** Create and return a signed vote for an epoch's state root, to be gossiped. */
  createVote(epoch: number, stateRoot: string, supply: { emitted: number; burned: number; reserve: number }, signer: Keypair, voterZti: number, timestamp: number): SignedCheckpointVote {
    const body: CheckpointBody = {
      network: this.network, epoch, stateRoot, prevRoot: this.lastFinalizedRoot,
      emitted: supply.emitted, burned: supply.burned, reserve: supply.reserve, timestamp,
    };
    const c = canonical(body as unknown as Record<string, unknown>);
    const id = checkpointId(body);
    const sig = edSign(c, signer.privateKey);
    const vote: SignedCheckpointVote = { ...body, id, voter: signer.publicKey, voterZti, sig };
    return vote; // the caller stores it via receiveVote with the real total master trust
  }

  /**
   * Receive a gossiped vote. Returns a newly finalized checkpoint if this vote crossed it.
   *
   * SECURITY (F1): `masterMap` must be derived from the authoritative local ledger state:
   * a Map from voter public key to REAL on-ledger ZTI, containing ONLY voters whose on-ledger
   * ZTI is >= MASTER_NODE_ZTI. tryFinalize uses this map instead of the attacker-controlled
   * `voterZti` field in the vote body, so a forged high voterZti cannot manufacture finality.
   * The `totalMasterTrust` must also come from the same local state (sum of real ZTI values).
   */
  receiveVote(vote: SignedCheckpointVote, totalMasterTrust: number, masterMap: ReadonlyMap<string, number>): FinalizedCheckpoint | null {
    const fin = this.applyVote(vote, totalMasterTrust, masterMap);
    this.prune();   // bound memory after every accepted/rejected vote; consensus-neutral
    return fin;
  }

  private applyVote(vote: SignedCheckpointVote, totalMasterTrust: number, masterMap: ReadonlyMap<string, number>): FinalizedCheckpoint | null {
    if (this.seen.has(vote.id)) return null;
    if (vote.network !== this.network) return null;
    if (!verifyCheckpointVote(vote)) return null;
    // SECURITY: reject votes from non-masters immediately (don't even store them).
    if (!masterMap.has(vote.voter)) return null;
    this.seen.add(vote.id);

    let byRoot = this.votes.get(vote.epoch);
    if (!byRoot) { byRoot = new Map(); this.votes.set(vote.epoch, byRoot); }
    const arr = byRoot.get(vote.stateRoot) ?? [];
    // one vote per voter per root
    if (!arr.some((v) => v.voter === vote.voter)) arr.push(vote);
    byRoot.set(vote.stateRoot, arr);

    if (this.finalized.has(vote.epoch)) return null;
    const all = [...byRoot.values()].flat();
    // Every vote in `all` already passed verifyCheckpointVote above before it was stored, so re-verifying
    // the whole accumulated set on each new vote is redundant O(n²) ed25519 work (it was the dominant CPU
    // cost on idle nodes — ~62% of a core, since a fresh checkpoint finalizes every ~5s on every master).
    // Skip the re-check; the master-map gate, root grouping, and 0.67 threshold are unchanged.
    const fin = tryFinalize(all, totalMasterTrust, masterMap, true);
    if (fin && !this.finalized.has(fin.epoch)) {
      this.finalized.set(fin.epoch, fin);
      if (fin.epoch > this.lastFinalizedEpoch) {
        this.lastFinalizedEpoch = fin.epoch;
        this.lastFinalizedRoot = fin.stateRoot;
      }
      log.info(`checkpoint finalized epoch ${fin.epoch} root ${fin.stateRoot.slice(0, 12)} trust ${fin.supportingTrust.toFixed(2)}`);
      return fin;
    }
    return null;
  }

  /** Bound memory. Vote buckets, the dedup set, and the finalized map are local bookkeeping, not part
   *  of the deterministic state root, so trimming settled history is consensus-neutral. Called after
   *  every receiveVote. Recent epochs and the latest finalized checkpoint (the one fast-sync serves) are
   *  always retained; only deep history and flood overflow are dropped. */
  private prune(): void {
    const voteCutoff = this.lastFinalizedEpoch - Checkpoints.RETAIN_VOTE_EPOCHS;
    if (voteCutoff > 0) for (const e of this.votes.keys()) if (e < voteCutoff) this.votes.delete(e);
    if (this.finalized.size > Checkpoints.FINALIZED_CAP) {
      const epochs = [...this.finalized.keys()].sort((a, b) => a - b);
      for (let i = 0; i < epochs.length - Checkpoints.FINALIZED_CAP; i++) this.finalized.delete(epochs[i]!);
    }
    if (this.seen.size > Checkpoints.SEEN_CAP) {
      const drop = Math.floor(Checkpoints.SEEN_CAP * 0.1);   // evict the oldest ~10% (insertion-ordered)
      let i = 0;
      for (const id of this.seen) { this.seen.delete(id); if (++i >= drop) break; }
    }
  }

  /** The stored votes for a given (epoch, root). Used by fast-sync to prove a finalized checkpoint. */
  finalizingVotes(epoch: number, root: string): SignedCheckpointVote[] { return this.votes.get(epoch)?.get(root) ?? []; }

  /** All stored votes for epochs NOT yet finalized, newest-epoch first, bounded. Used to re-gossip when
   *  finality stalls: each epoch's vote is cast ONCE, so a vote lost to a gossipsub mesh race is never resent
   *  and that epoch can never reach quorum — a single lost vote permanently splits it and freezes finality.
   *  Re-broadcasting is idempotent (signed + de-duped by isVoteKnown on the receiver) and consensus-neutral:
   *  it only re-sends votes that already exist, never invents a new root. */
  recentUnfinalizedVotes(limit = 200): SignedCheckpointVote[] {
    const out: SignedCheckpointVote[] = [];
    const epochs = [...this.votes.keys()].filter((e) => !this.finalized.has(e)).sort((a, b) => b - a);
    for (const e of epochs) {
      const byRoot = this.votes.get(e);
      if (!byRoot) continue;
      for (const arr of byRoot.values()) for (const v of arr) { out.push(v); if (out.length >= limit) return out; }
    }
    return out;
  }

  isVoteKnown(id: string): boolean { return this.seen.has(id); }
  recentFinalized(limit: number): FinalizedCheckpoint[] {
    return [...this.finalized.values()].sort((a, b) => b.epoch - a.epoch).slice(0, limit);
  }
}
