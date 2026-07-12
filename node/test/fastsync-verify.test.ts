// node/test/fastsync-verify.test.ts
// Consensus-critical: a joining node must only adopt a peer snapshot that is cryptographically
// bound to a genuinely finalized checkpoint, anchored to a genesis founder, backed by >= 67% of
// master trust. This exercises verifyFastSyncSnapshot directly: one honest case is accepted, and
// every adversarial variant (content does not hash to the root, no genesis founder among signers,
// votes below the 67% threshold, empty votes) is rejected. If this verification regresses, a node
// could adopt forged state, so the adversarial coverage here is the proof.
import test from "node:test";
import assert from "node:assert/strict";
import {
  keypairFromPrivate, generateKeypair, standardGenesis,
  computeStateRoot, checkpointId, canonical, sign as edSign,
  PROTOCOL,
  type SignedCheckpointVote, type CheckpointBody, type Keypair, type GenesisDoc,
} from "@zira/protocol";
import { verifyFastSyncSnapshot } from "../src/core/ZiraNode.js";

// These adversarial cases assert the CLASSIC multi-master quorum arithmetic (founder alone = 1/4 = 0.25 <
// 0.67, three of four = 0.75 >= 0.67). That path is only exercised when single-finalizer is dormant; with it
// active the electorate collapses to the lead finalizer whose lone vote is 100%, which the dedicated
// single-finalizer tests cover. Pin it dormant here so the quorum thresholds under test are the real ones.
// Node's test runner isolates each file in its own process, so this does not leak to other suites.
process.env.ZIRA_SINGLE_FINALIZER_ACTIVATION_EPOCH = "999999999999";

const GTS = 1_700_000_000_000;
const founder = keypairFromPrivate("0a".repeat(32));
const genesis: GenesisDoc = standardGenesis("devnet", founder.address, GTS);

// Four masters: the genesis founder plus three others, all equal ZTI, so each carries 1/4 of the
// trust. Any three of them are 75% (>= 67%); the founder alone is 25% (< 67%). This lets the
// adversarial cases isolate exactly one failing condition each.
const m2 = keypairFromPrivate("0b".repeat(32));
const m3 = keypairFromPrivate("0c".repeat(32));
const m4 = keypairFromPrivate("0d".repeat(32));
const ZTI = 0.9; // >= MASTER_NODE_ZTI

type SnapAccount = { address: string; pubkey: string; zti: number; isMaster: boolean; balance: number; nonce: number };

function masterAccount(kp: Keypair, zti = ZTI): SnapAccount {
  return { address: kp.address, pubkey: kp.publicKey, zti, isMaster: true, balance: 1_000_000, nonce: 1 };
}

const supply = { emitted: 5_000_000, burned: 0, reserve: PROTOCOL.RESERVE_UZIR };
const FINAL_EPOCH = 12;

// A snapshot whose accounts/supply/founders/anchors hash to a single deterministic root.
function buildSnapshot(accounts: SnapAccount[]) {
  return {
    lastProcessedEpoch: FINAL_EPOCH,
    accounts,
    supply,
    founders: [founder.address],
    anchors: [],
  };
}

function rootOf(snap: ReturnType<typeof buildSnapshot>): string {
  return computeStateRoot(snap.accounts, snap.supply, snap.founders, snap.anchors);
}

// Build a valid signed checkpoint vote over (epoch, stateRoot), mirroring Checkpoints.createVote.
function makeVote(signer: Keypair, epoch: number, stateRoot: string): SignedCheckpointVote {
  const body: CheckpointBody = {
    network: "devnet", epoch, stateRoot, prevRoot: "00",
    emitted: supply.emitted, burned: supply.burned, reserve: supply.reserve, timestamp: GTS,
  };
  const c = canonical(body as unknown as Record<string, unknown>);
  return { ...body, id: checkpointId(body), voter: signer.publicKey, voterZti: ZTI, sig: edSign(c, signer.privateKey) };
}

const ALL_MASTERS = () => [masterAccount(founder), masterAccount(m2), masterAccount(m3), masterAccount(m4)];

test("(a) a finalized snapshot with valid >=67% master votes incl. a genesis founder is ADOPTED", () => {
  const snapshot = buildSnapshot(ALL_MASTERS());
  const root = rootOf(snapshot);
  // founder + m2 + m3 = 3/4 of master trust = 0.75 >= 0.67 threshold; founder anchors to genesis.
  const votes = [makeVote(founder, FINAL_EPOCH, root), makeVote(m2, FINAL_EPOCH, root), makeVote(m3, FINAL_EPOCH, root)];
  const best = { snapshot, finalizedEpoch: FINAL_EPOCH, finalizedRoot: root, votes };
  assert.equal(verifyFastSyncSnapshot(best, genesis), true);
});

test("(b1) ADVERSARIAL: snapshot content that does NOT hash to finalizedRoot is REJECTED", () => {
  const snapshot = buildSnapshot(ALL_MASTERS());
  const root = rootOf(snapshot);
  const votes = [makeVote(founder, FINAL_EPOCH, root), makeVote(m2, FINAL_EPOCH, root), makeVote(m3, FINAL_EPOCH, root)];
  // Tamper with the snapshot AFTER computing the root the votes signed: balances no longer match.
  const forged = { ...snapshot, accounts: snapshot.accounts.map((a) => ({ ...a, balance: a.balance + 999 })) };
  const best = { snapshot: forged, finalizedEpoch: FINAL_EPOCH, finalizedRoot: root, votes };
  assert.equal(verifyFastSyncSnapshot(best, genesis), false);
});

test("(b2) ADVERSARIAL: votes with NO genesis founder among signers are REJECTED", () => {
  const snapshot = buildSnapshot(ALL_MASTERS());
  const root = rootOf(snapshot);
  // m2 + m3 + m4 = 3/4 trust (>= 67%) but none is the genesis founder, so it is not anchored.
  const votes = [makeVote(m2, FINAL_EPOCH, root), makeVote(m3, FINAL_EPOCH, root), makeVote(m4, FINAL_EPOCH, root)];
  const best = { snapshot, finalizedEpoch: FINAL_EPOCH, finalizedRoot: root, votes };
  assert.equal(verifyFastSyncSnapshot(best, genesis), false);
});

test("(b3) ADVERSARIAL: votes summing to < 67% of master trust are REJECTED", () => {
  const snapshot = buildSnapshot(ALL_MASTERS());
  const root = rootOf(snapshot);
  // Only the founder votes: 1/4 of master trust (0.25) < 0.67, even though it is anchored.
  const votes = [makeVote(founder, FINAL_EPOCH, root)];
  const best = { snapshot, finalizedEpoch: FINAL_EPOCH, finalizedRoot: root, votes };
  assert.equal(verifyFastSyncSnapshot(best, genesis), false);
});

test("(b4) ADVERSARIAL: an empty votes array is REJECTED", () => {
  const snapshot = buildSnapshot(ALL_MASTERS());
  const root = rootOf(snapshot);
  const best = { snapshot, finalizedEpoch: FINAL_EPOCH, finalizedRoot: root, votes: [] as SignedCheckpointVote[] };
  assert.equal(verifyFastSyncSnapshot(best, genesis), false);
});

test("(b5) ADVERSARIAL: a forged vote signature is not counted, dropping support below threshold", () => {
  const snapshot = buildSnapshot(ALL_MASTERS());
  const root = rootOf(snapshot);
  const good = makeVote(founder, FINAL_EPOCH, root);
  // Impersonate m2 by claiming its voter pubkey but signing with an attacker key. verifyCheckpointVote
  // fails, so only the founder's 1/3 counts and the snapshot is rejected.
  const attacker = generateKeypair();
  const forgedBody: CheckpointBody = {
    network: "devnet", epoch: FINAL_EPOCH, stateRoot: root, prevRoot: "00",
    emitted: supply.emitted, burned: supply.burned, reserve: supply.reserve, timestamp: GTS,
  };
  const c = canonical(forgedBody as unknown as Record<string, unknown>);
  const forgedVote: SignedCheckpointVote = { ...forgedBody, id: checkpointId(forgedBody), voter: m2.publicKey, voterZti: ZTI, sig: edSign(c, attacker.privateKey) };
  const best = { snapshot, finalizedEpoch: FINAL_EPOCH, finalizedRoot: root, votes: [good, forgedVote] };
  assert.equal(verifyFastSyncSnapshot(best, genesis), false);
});
