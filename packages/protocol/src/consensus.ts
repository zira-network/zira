// packages/protocol/src/consensus.ts
//
// Proof of Resonance finality. Like bitcoin replaces trust with proof of work, ZIRA replaces it
// with proof of resonance: master nodes (ZTI >= 0.70) co-sign a checkpoint over the deterministic
// state root at each epoch. A checkpoint that gathers at least FINALITY_THRESHOLD of the active
// master trust is final and irreversible. Every node enforces the rules, so no checkpoint can
// finalize an invalid state.
import { PROTOCOL } from "./constants";
import { hashHex, verify as edVerify } from "./crypto";
import { canonical } from "./serialize";
import type { Address, Anchor, Hex, PublicKey, Signature, uZIR } from "./types";

export interface AccountLeaf {
  address: Address;
  balance: uZIR;
  nonce: number;
}

export interface SupplyState {
  emitted: uZIR;
  burned: uZIR;
  reserve: uZIR;
}

/**
 * The deterministic state root: a sha3-256 over the canonical, sorted account leaves and the
 * supply totals. Two honest nodes with the same applied history compute the same root. This is
 * what checkpoints sign, so finality is over state, not over a chain of blocks.
 */
export function computeStateRoot(accounts: AccountLeaf[], supply: SupplyState, founders: Address[] = [], anchors: Anchor[] = []): Hex {
  const leaves = accounts
    .filter((a) => a.balance !== 0 || a.nonce !== 0)
    .map((a) => ({ a: a.address, b: a.balance, n: a.nonce }))
    .sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : 0));
  const founderLeaves = [...new Set(founders)].sort();
  const anchorLeaves = anchors
    .map((a) => ({
      id: a.id, c: a.classCode, i: a.seatIndex, h: a.codeHash, o: a.owner ?? "",
      p: a.listedPriceUZIR ?? 0, s: a.status, z: a.zti,
    }))
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return hashHex(canonical({ accounts: leaves, anchors: anchorLeaves, founders: founderLeaves, supply: { e: supply.emitted, b: supply.burned, r: supply.reserve } }));
}

export interface CheckpointBody {
  network: string;
  epoch: number;
  stateRoot: Hex;
  prevRoot: Hex;       // the previous finalized root, links checkpoints
  emitted: uZIR;
  burned: uZIR;
  reserve: uZIR;
  timestamp: number;
}

export interface SignedCheckpointVote extends CheckpointBody {
  id: Hex;
  voter: PublicKey;
  voterZti: number;
  sig: Signature;
}

export function checkpointId(body: CheckpointBody): Hex {
  return hashHex(canonical(body as unknown as Record<string, unknown>));
}

/** Verify a checkpoint vote: id matches the body and the signature verifies for the voter. */
export function verifyCheckpointVote(v: SignedCheckpointVote): boolean {
  const body: CheckpointBody = {
    network: v.network, epoch: v.epoch, stateRoot: v.stateRoot, prevRoot: v.prevRoot,
    emitted: v.emitted, burned: v.burned, reserve: v.reserve, timestamp: v.timestamp,
  };
  const c = canonical(body as unknown as Record<string, unknown>);
  if (hashHex(c) !== v.id) return false;
  return edVerify(c, v.sig, v.voter);
}

export interface FinalizedCheckpoint extends CheckpointBody {
  supportingTrust: number;       // sum of voter ZTI weights that agreed, normalized
  voters: PublicKey[];
}

/**
 * Given the votes for one (epoch, stateRoot) and the total active master trust, decide whether
 * the checkpoint is final. Final when supporting trust reaches FINALITY_THRESHOLD (0.67).
 * Only master nodes (ZTI >= MASTER_NODE_ZTI) count toward finality.
 *
 * SECURITY: voterZti from the vote body is NEVER used to compute support. The caller must supply
 * a `masterMap` of (voter pubkey -> real ZTI) derived from the authoritative local ledger state.
 * Votes whose voter is not in `masterMap` (i.e. did not actually reach MASTER_NODE_ZTI on-ledger)
 * are silently ignored — they cannot forge finality by claiming a high voterZti in the body.
 * The `totalActiveMasterTrust` must also be derived from the same authoritative local state.
 */
export function tryFinalize(
  votes: SignedCheckpointVote[],
  totalActiveMasterTrust: number,
  /** Authoritative master ZTI lookup: voter pubkey → real on-ledger ZTI. Only voters present here
   *  (i.e. actually at or above MASTER_NODE_ZTI) contribute to finality. When omitted the function
   *  falls back to the legacy voterZti field for backward compatibility in protocol-layer unit tests
   *  that construct synthetic votes without a live ledger, but all callers that pass real gossip
   *  MUST provide this map. */
  masterMap?: ReadonlyMap<PublicKey, number>,
  /** PERFORMANCE (consensus-neutral): when true, skip the ed25519 signature re-check on each vote.
   *  Set ONLY by callers that have ALREADY verified every vote's signature before storing it (the live
   *  Checkpoints.applyVote path verifies each vote once on receipt, so re-verifying the accumulated set
   *  on every new vote is pure O(n²) waste). The signature gate is unchanged for callers that do not set
   *  this (unit tests, any path passing unverified votes): finality semantics, the master-map gate, the
   *  root grouping, and the 0.67 threshold are all identical regardless of this flag. */
  votesPreVerified = false,
): FinalizedCheckpoint | null {
  // Filter to master-eligible votes: if masterMap is provided, only voters present in it count and
  // their real ZTI is used. Without the map we fall back to voterZti (unit-test path only).
  const masters = votes.filter((v) => {
    if (!votesPreVerified && !verifyCheckpointVote(v)) return false;
    if (masterMap) return masterMap.has(v.voter);          // authoritative gate: must be a real master
    return v.voterZti >= PROTOCOL.MASTER_NODE_ZTI;         // legacy: unit tests without a live ledger
  });
  if (masters.length === 0 || totalActiveMasterTrust <= 0) return null;

  // group by stateRoot, the honest majority of trust must agree on one root
  const byRoot = new Map<Hex, SignedCheckpointVote[]>();
  for (const v of masters) {
    const arr = byRoot.get(v.stateRoot) ?? [];
    arr.push(v);
    byRoot.set(v.stateRoot, arr);
  }
  for (const [root, group] of byRoot) {
    // Use locally-derived ZTI, NOT the attacker-controlled voterZti from the vote body.
    const support = group.reduce((a, v) => {
      const realZti = masterMap ? (masterMap.get(v.voter) ?? 0) : v.voterZti;
      return a + realZti;
    }, 0) / totalActiveMasterTrust;
    if (support >= PROTOCOL.FINALITY_THRESHOLD) {
      const first = group[0]!;
      return {
        network: first.network, epoch: first.epoch, stateRoot: root, prevRoot: first.prevRoot,
        emitted: first.emitted, burned: first.burned, reserve: first.reserve, timestamp: first.timestamp,
        supportingTrust: support, voters: group.map((v) => v.voter),
      };
    }
  }
  return null;
}
