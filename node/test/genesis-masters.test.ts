// node/test/genesis-masters.test.ts
// A2 finality + B2 sybil-resistant admission.
//   A2: mainnet genesis designates a fixed quorum of keyless coordinator nodes as masters. They finalize
//       Proof of Resonance checkpoints by quorum with their OWN node keys, the founder is NOT among them,
//       and any three of four cross 0.67 — so finality continues with the local steward offline.
//   B2: reaching the ZTI threshold is necessary but not sufficient to become a master; tenure must be
//       earned over many epochs, so a fresh accurate identity cannot vault to finality control.
import test from "node:test";
import assert from "node:assert/strict";
import {
  keypairFromPrivate, generateKeypair, standardGenesis, computeStateRoot, PROTOCOL,
  buildObservationBody, canonical, hashHex, sign as edSign,
  type GenesisDoc, type SignedObservation,
} from "@zira/protocol";
import { State, EPOCH_MS, epochOf, GRACE_MS, SETTLE_ROUNDS } from "../src/core/State.js";
import { Checkpoints } from "../src/core/Checkpoints.js";
import { genesisFor } from "../src/genesis-docs.js";

const GTS = 1_700_000_000_000;

test("A2: mainnet genesis seeds a 4-master quorum; the founder is not a master; seeding is root-neutral", () => {
  const g = genesisFor("mainnet");
  assert.equal(g.masters?.length, 4, "mainnet genesis carries four bootstrap masters");
  const s = new State(g);

  for (const m of g.masters!) {
    const a = s.accounts.get(m.address)!;
    assert.ok(a, "master account seeded");
    assert.equal(a.isMaster, true, "genesis master is a master");
    assert.equal(a.zti, 1.0, "genesis master holds full trust");
    assert.equal(a.pubkey, m.pubKey, "genesis master pubkey is seeded for a deterministic master map");
    assert.equal(a.balance, 0, "genesis masters hold no funds, so they are excluded from the state root");
    assert.equal(s.isGenesisMaster(m.address), true);
  }
  // The founder keeps founder authority but is NOT a genesis master, so its absence cannot stall finality.
  assert.equal(s.accounts.get(g.founder)?.isMaster ?? false, false, "the founder is not a genesis master");

  assert.equal(s.totalMasterTrust(), 4.0, "total master trust is exactly the four bootstrap masters");
  assert.equal(s.masterZtiMap().size, 4, "the master map has all four from genesis");

  // Root-neutral: a zero-balance master contributes no leaf, so the root equals the same supply with no masters.
  const rootWith = s.stateRoot();
  const rootBare = computeStateRoot(
    [...s.accounts.values()].filter((a) => a.balance !== 0 || a.nonce !== 0).map((a) => ({ address: a.address, balance: a.balance, nonce: a.nonce })),
    s.supply, s.activeFounderAddresses(), s.anchorSeats(),
  );
  assert.equal(rootWith, rootBare, "seeding masters does not change the deterministic state root");
});

test("A2: three of four genesis masters finalize a checkpoint with the founder offline", () => {
  const founder = keypairFromPrivate("0a".repeat(32));
  const masterKps = [generateKeypair(), generateKeypair(), generateKeypair(), generateKeypair()];
  const g: GenesisDoc = {
    ...standardGenesis("devnet", founder.address, GTS),
    masters: masterKps.map((k) => ({ address: k.address, pubKey: k.publicKey })),
  };
  const s = new State(g);
  const cp = new Checkpoints(g.network);
  const epoch = 7;
  const root = s.stateRoot();
  const total = s.totalMasterTrust();
  const map = s.masterZtiMap();
  assert.equal(total, 4.0);

  // Two masters vote: 0.50 of trust, below the 0.67 threshold — not yet final. The founder never votes.
  // Each vote carries the voter's own wall-clock (as the live voteCheckpoints does), so they are distinct
  // records grouped by the shared state root, not deduped to one.
  let fin = cp.receiveVote(cp.createVote(epoch, root, s.supply, masterKps[0]!, 1.0, GTS + 1), total, map);
  assert.equal(fin, null);
  fin = cp.receiveVote(cp.createVote(epoch, root, s.supply, masterKps[1]!, 1.0, GTS + 2), total, map);
  assert.equal(fin, null, "two of four (0.50) is below 0.67");

  // A third master crosses 0.75 >= 0.67 — finalized, with no founder participation at all.
  fin = cp.receiveVote(cp.createVote(epoch, root, s.supply, masterKps[2]!, 1.0, GTS + 3), total, map);
  assert.ok(fin, "three of four (0.75) finalizes without the founder");
  assert.equal(fin!.epoch, epoch);
  assert.ok(fin!.supportingTrust >= PROTOCOL.FINALITY_THRESHOLD);
});

test("A2: an earned (non-genesis) master cannot inflate the finality denominator and wedge a 3-of-4 finalize", () => {
  const founder = keypairFromPrivate("0c".repeat(32));
  const masterKps = [generateKeypair(), generateKeypair(), generateKeypair(), generateKeypair()];
  const g: GenesisDoc = {
    ...standardGenesis("devnet", founder.address, GTS),
    masters: masterKps.map((k) => ({ address: k.address, pubKey: k.publicKey })),
  };
  const s = new State(g);
  // An account that climbed to master ZTI on-ledger (e.g. an anchor resonator or miner) but is NOT a genesis
  // bootstrap master and does not run a coordinator vote. In production this 5th master inflated the
  // denominator: 4 voters of 5 known masters = 0.80, so a single genesis master dropping fell to 3/5 = 0.60
  // < 0.67 and froze the whole mesh. Finality must count ONLY the genesis masters.
  const earned = generateKeypair();
  s.accounts.set(earned.address, {
    address: earned.address, pubkey: earned.publicKey, balance: 0, nonce: 0, zti: 1.0, ztiByDomain: {},
    accuracy: 0, consistency: 1, uptime: 0, isMaster: true, firstSeenEpoch: -1, activeEpochs: 0,
    lastActiveEpoch: -1, lastWorkEpoch: -1,
  });
  assert.equal(s.totalMasterTrust(), 4.0, "denominator excludes the earned non-genesis master");
  assert.equal(s.masterZtiMap().size, 4, "the finality master map is the four genesis masters only");
  assert.equal(s.isGenesisMaster(earned.address), false);

  // With the earned master correctly excluded, three of the four genesis masters still finalize (0.75).
  const cp = new Checkpoints(g.network);
  const epoch = 9, root = s.stateRoot(), total = s.totalMasterTrust(), map = s.masterZtiMap();
  let fin = cp.receiveVote(cp.createVote(epoch, root, s.supply, masterKps[0]!, 1.0, GTS + 1), total, map);
  fin = cp.receiveVote(cp.createVote(epoch, root, s.supply, masterKps[1]!, 1.0, GTS + 2), total, map);
  assert.equal(fin, null, "two of four is 0.50, not final");
  fin = cp.receiveVote(cp.createVote(epoch, root, s.supply, masterKps[2]!, 1.0, GTS + 3), total, map);
  assert.ok(fin, "three of four genesis masters finalize even with an earned master present");
});

test("B2: a fresh accurate node reaches the ZTI threshold but is not promoted to master before tenure", () => {
  const founder = keypairFromPrivate("0b".repeat(32));
  const g = standardGenesis("devnet", founder.address, GTS); // no genesis master set on devnet
  const s = new State(g);
  const nodes = [keypairFromPrivate("31".repeat(32)), keypairFromPrivate("32".repeat(32)), keypairFromPrivate("33".repeat(32))];

  const hb = (kp: ReturnType<typeof keypairFromPrivate>, ts: number): SignedObservation => {
    const body = buildObservationBody({
      type: "value", observer: kp.publicKey, timestamp: ts, subject: "ZIRA_FIELD_HEARTBEAT",
      domain: "data", confidence: 0.9, sourceHashes: ["field-heartbeat"], value: 1, storageGiB: 10,
    });
    const c = canonical(body);
    return { ...body, id: hashHex(c), sig: edSign(c, kp.privateKey) };
  };

  const e0 = epochOf(GTS) + 1;
  // Run ~50 epochs of perfectly-accurate participation — far more than enough to clear the 0.70 ZTI bar
  // (the per-epoch ascent cap alone reaches it in ~35 epochs), but far short of MIN_MASTER_TENURE_EPOCHS.
  const EPOCHS = 50;
  for (let i = 0; i < EPOCHS; i++) {
    const e = e0 + i;
    const ts = e * EPOCH_MS + 10;
    for (const n of nodes) s.ingestObservation(hb(n, ts));
    s.advance((e + SETTLE_ROUNDS + 1) * EPOCH_MS + GRACE_MS + 1);
  }

  const a = s.accounts.get(nodes[0]!.address)!;
  assert.ok(a.zti >= PROTOCOL.MASTER_NODE_ZTI, `node cleared the ZTI bar (${a.zti.toFixed(3)})`);
  // These are empty heartbeats with no settled work, so they accrue no work-backed tenure at all — and a
  // node cannot become a master on high ZTI alone. (Both the work gate and the tenure gate hold here.)
  assert.equal(a.activeEpochs, 0, "empty heartbeats build no work-backed tenure");
  assert.ok(a.activeEpochs < PROTOCOL.MIN_MASTER_TENURE_EPOCHS, "tenure is below the master threshold");
  assert.equal(a.isMaster, false, "high ZTI alone does not make a master — work-backed tenure is required");
});
