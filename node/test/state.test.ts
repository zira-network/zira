// node/test/state.test.ts
// Verify the deterministic state machine: same events, any order, same committed state root.
// This is the property that lets independent peers converge without a central referee.
import test from "node:test";
import assert from "node:assert/strict";
import {
  keypairFromPrivate, signTx, buildTxBody, hashHex, canonical, sign as edSign, standardGenesis, PROTOCOL, ANCHOR_CLASSES, TOTAL_ANCHOR_SEATS,
  type SignedTx, type SignedObservation, type Domain,
} from "@zira/protocol";
import { State, EPOCH_MS, epochOf, GRACE_MS, SETTLE_ROUNDS } from "../src/core/State.js";

const founder = keypairFromPrivate("0a".repeat(32));
const alice = keypairFromPrivate("0b".repeat(32));
const bob = keypairFromPrivate("0c".repeat(32));
const GTS = 1_700_000_000_000;
const genesis = standardGenesis("devnet", founder.address, GTS);

function tx(from: ReturnType<typeof keypairFromPrivate>, to: string, amount: number, nonce: number, ts: number, kind: SignedTx["kind"] = "transfer", network: SignedTx["network"] = "devnet", feeUZIR = PROTOCOL.BASE_FEE_UZIR): SignedTx {
  return signTx(buildTxBody({
    network, from: from.address, fromPubKey: from.publicKey, to,
    amountUZIR: amount, feeUZIR, nonce, kind, parents: [], timestamp: ts,
  }), from.privateKey);
}
function txMemo(from: ReturnType<typeof keypairFromPrivate>, to: string, amount: number, nonce: number, ts: number, kind: SignedTx["kind"], memo: string, network: SignedTx["network"] = "devnet", feeUZIR = PROTOCOL.BASE_FEE_UZIR): SignedTx {
  return signTx(buildTxBody({
    network, from: from.address, fromPubKey: from.publicKey, to,
    amountUZIR: amount, feeUZIR, nonce, kind, parents: [], timestamp: ts, memo,
  }), from.privateKey);
}
function obs(kp: ReturnType<typeof keypairFromPrivate>, subject: string, domain: Domain, value: number, ts: number): SignedObservation {
  const body: Record<string, unknown> = { type: "value", observer: kp.publicKey, timestamp: ts, subject, domain, confidence: 0.9, sourceHashes: ["t"], value };
  const c = canonical(body);
  return { ...(body as any), id: hashHex(c), sig: edSign(c, kp.privateKey) };
}

// a wall clock time at which exactly `epoch` becomes closable (and no later epoch)
function at(epoch: number): number { return (epoch + SETTLE_ROUNDS + 1) * EPOCH_MS + GRACE_MS + 1; }

test("genesis seeds the founder reserve", () => {
  const s = new State(genesis);
  assert.equal(s.balanceOf(founder.address), PROTOCOL.RESERVE_UZIR);
  assert.equal(s.supply.reserve, PROTOCOL.RESERVE_UZIR);
});

test("a fresh genesis state restores the full reserve after local history is wiped", () => {
  const spent = new State(genesis);
  const e1 = epochOf(GTS) + 1;
  const grant = tx(founder, alice.address, 5_000_000, 0, e1 * EPOCH_MS + 10, "reserve_grant");
  assert.equal(spent.ingestTx(grant).ok, true);
  spent.advance(at(e1));
  assert.equal(spent.balanceOf(founder.address), PROTOCOL.RESERVE_UZIR - 5_000_000 - PROTOCOL.BASE_FEE_UZIR);

  const fresh = new State(genesis);
  assert.equal(fresh.balanceOf(founder.address), PROTOCOL.RESERVE_UZIR);
  assert.equal(fresh.supply.reserve, PROTOCOL.RESERVE_UZIR);
  assert.equal(PROTOCOL.RESERVE_UZIR / PROTOCOL.UZIR_PER_ZIR, 11_767_000_000);
});

test("a transaction from another network is rejected", () => {
  const s = new State(genesis);
  const e1 = epochOf(GTS) + 1;
  const wrongNetwork = tx(founder, alice.address, 1_000_000, 0, e1 * EPOCH_MS + 10, "reserve_grant", "mainnet");
  const r = s.ingestTx(wrongNetwork);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /network mismatch/);
});

test("an active founder can delegate another founder with full permissions", () => {
  const s = new State(genesis);
  const carol = keypairFromPrivate("0d".repeat(32));
  const e1 = epochOf(GTS) + 1;
  const delegateAlice = tx(founder, alice.address, 0, 0, e1 * EPOCH_MS + 10, "founder_delegate", "devnet", 0);
  assert.equal(s.ingestTx(delegateAlice).ok, true);
  s.advance(at(e1));
  assert.deepEqual(s.activeFounderAddresses(), [alice.address, founder.address].sort());

  const e2 = e1 + 1;
  const grant = tx(alice, bob.address, 1_000_000, 0, e2 * EPOCH_MS + 10, "reserve_grant");
  assert.equal(s.ingestTx(grant).ok, true);
  s.advance(at(e2));
  assert.equal(s.balanceOf(bob.address), 1_000_000);

  const e3 = e2 + 1;
  const delegateCarol = tx(alice, carol.address, 0, 1, e3 * EPOCH_MS + 10, "founder_delegate", "devnet", 0);
  assert.equal(s.ingestTx(delegateCarol).ok, true);
  s.advance(at(e3));
  assert.equal(s.isAuthorizedFounder(carol.address), true);
});

test("an active founder can revoke a delegated founder", () => {
  const s = new State(genesis);
  const e1 = epochOf(GTS) + 1;
  const delegateAlice = tx(founder, alice.address, 0, 0, e1 * EPOCH_MS + 10, "founder_delegate", "devnet", 0);
  assert.equal(s.ingestTx(delegateAlice).ok, true);
  s.advance(at(e1));
  assert.equal(s.isAuthorizedFounder(alice.address), true);

  const e2 = e1 + 1;
  const revokeAlice = tx(founder, alice.address, 0, 1, e2 * EPOCH_MS + 10, "founder_revoke", "devnet", 0);
  assert.equal(s.ingestTx(revokeAlice).ok, true);
  s.advance(at(e2));
  assert.equal(s.isAuthorizedFounder(alice.address), false);
  assert.equal(s.isAuthorizedFounder(founder.address), true);

  const e3 = e2 + 1;
  const grant = tx(alice, bob.address, 1_000_000, 0, e3 * EPOCH_MS + 10, "reserve_grant");
  assert.equal(s.ingestTx(grant).ok, false);
});

test("non-founders cannot delegate founders", () => {
  const s = new State(genesis);
  const e1 = epochOf(GTS) + 1;
  const attempt = tx(alice, bob.address, 0, 0, e1 * EPOCH_MS + 10, "founder_delegate", "devnet", 0);
  const r = s.ingestTx(attempt);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /active founder/);
});

test("snapshot restores delegated founders and preserves the state root", () => {
  const s = new State(genesis);
  const e1 = epochOf(GTS) + 1;
  const delegateAlice = tx(founder, alice.address, 0, 0, e1 * EPOCH_MS + 10, "founder_delegate", "devnet", 0);
  assert.equal(s.ingestTx(delegateAlice).ok, true);
  s.advance(at(e1));

  const restored = new State(genesis);
  restored.loadSnapshot(s.snapshot());
  assert.equal(restored.isAuthorizedFounder(alice.address), true);
  assert.equal(restored.stateRoot(), s.stateRoot());
});

test("a transfer applies deterministically after its epoch closes", () => {
  const s = new State(genesis);
  // fund alice from founder (reserve_grant), then alice pays bob
  const e1 = epochOf(GTS) + 1;
  const grant = tx(founder, alice.address, 1_000_000, 0, e1 * EPOCH_MS + 10, "reserve_grant");
  assert.equal(s.ingestTx(grant).ok, true);
  s.advance(at(e1));
  assert.equal(s.balanceOf(alice.address), 1_000_000);

  const e2 = e1 + 1;
  const pay = tx(alice, bob.address, 5000, 0, e2 * EPOCH_MS + 10);
  assert.equal(s.ingestTx(pay).ok, true);
  s.advance(at(e2));
  assert.equal(s.balanceOf(bob.address), 5000);
  assert.equal(s.balanceOf(alice.address), 1_000_000 - 5000 - PROTOCOL.BASE_FEE_UZIR);
  assert.equal(s.nonceOf(alice.address), 1);
});

test("a transaction stranded by the empty-epoch fast-forward still settles", () => {
  const s = new State(genesis);
  const e1 = epochOf(GTS) + 1;
  assert.equal(s.ingestTx(tx(founder, alice.address, 1_000_000, 0, e1 * EPOCH_MS + 10, "reserve_grant")).ok, true);
  s.advance(at(e1));
  assert.equal(s.balanceOf(alice.address), 1_000_000);

  // the node sits idle and fast-forwards over many empty epochs, so lastProcessedEpoch lands far ahead
  const far = e1 + 30;
  s.advance(at(far));

  // a transfer arrives late, stamped in an epoch the fast-forward already skipped (<= lastProcessedEpoch)
  const lateEpoch = far - 2;
  assert.equal(s.ingestTx(tx(alice, bob.address, 5000, 0, lateEpoch * EPOCH_MS + 10)).ok, true);

  // it must still settle at the next processed epoch, not be stranded in the pool forever
  s.advance(at(far + 1));
  assert.equal(s.balanceOf(bob.address), 5000);
  assert.equal(s.balanceOf(alice.address), 1_000_000 - 5000 - PROTOCOL.BASE_FEE_UZIR);
  assert.equal(s.nonceOf(alice.address), 1);
});

test("a future-stamped pooled event does not freeze the chain", () => {
  const s = new State(genesis);
  const e1 = epochOf(GTS) + 1;
  assert.equal(s.ingestTx(tx(founder, alice.address, 1_000_000, 0, e1 * EPOCH_MS + 10, "reserve_grant")).ok, true);
  s.advance(at(e1));
  assert.equal(s.balanceOf(alice.address), 1_000_000);

  // a pooled event stamped far in the future (as an autonomous-coordination cycle can be) must not drag
  // lastProcessedEpoch past the closable target; if it did, the node would freeze and process nothing.
  const future = e1 + 60;
  assert.equal(s.ingestTx(tx(founder, alice.address, 1, 1, future * EPOCH_MS + 10, "reserve_grant")).ok, true);
  s.advance(at(e1 + 1));

  // a normal transfer now arrives and must still settle at the next closable epoch
  const e2 = e1 + 2;
  assert.equal(s.ingestTx(tx(alice, bob.address, 5000, 0, e2 * EPOCH_MS + 10)).ok, true);
  s.advance(at(e2));
  assert.equal(s.balanceOf(bob.address), 5000);
});

test("two nodes converge to the same state root regardless of ingest order", () => {
  const e1 = epochOf(GTS) + 1;
  const events: SignedTx[] = [
    tx(founder, alice.address, 2_000_000, 0, e1 * EPOCH_MS + 10, "reserve_grant"),
    tx(founder, bob.address, 1_000_000, 1, e1 * EPOCH_MS + 20, "reserve_grant"),
  ];
  const a = new State(genesis);
  const b = new State(genesis);
  for (const ev of events) a.ingestTx(ev);
  for (const ev of [...events].reverse()) b.ingestTx(ev);
  a.advance(at(e1));
  b.advance(at(e1));
  assert.equal(a.stateRoot(), b.stateRoot());
  assert.equal(a.balanceOf(alice.address), 2_000_000);
});

test("a double spend at the same nonce is resolved deterministically", () => {
  const e1 = epochOf(GTS) + 1;
  const fund = tx(founder, alice.address, 1_000_000, 0, e1 * EPOCH_MS + 10, "reserve_grant");
  const e2 = e1 + 1;
  // two conflicting txs, same nonce 0, different recipients
  const t1 = tx(alice, bob.address, 900_000, 0, e2 * EPOCH_MS + 10);
  const t2 = tx(alice, founder.address, 900_000, 0, e2 * EPOCH_MS + 20);

  const a = new State(genesis); const b = new State(genesis);
  a.ingestTx(fund); b.ingestTx(fund);
  a.advance(at(e1)); b.advance(at(e1));
  a.ingestTx(t1); a.ingestTx(t2);
  b.ingestTx(t2); b.ingestTx(t1); // reverse order
  a.advance(at(e2)); b.advance(at(e2));
  // both nodes agree on which tx won (lower id), so the roots match
  assert.equal(a.stateRoot(), b.stateRoot());
  assert.equal(a.nonceOf(alice.address), 1); // exactly one applied
});

test("observations seal a Lock, lift ZTI, and mint base emission to the genesis masters", () => {
  const o1 = keypairFromPrivate("31".repeat(32));
  const o2 = keypairFromPrivate("32".repeat(32));
  const o3 = keypairFromPrivate("33".repeat(32));
  // The observers ARE the genesis masters, so the sealed Lock mints base emission to them (base emission
  // credits the fixed master set, never the live-observed contributor set — that is what keeps it deterministic).
  const masterGenesis = { ...standardGenesis("devnet", founder.address, GTS), masters: [o1, o2, o3].map((k) => ({ address: k.address, pubKey: k.publicKey })) };
  const s = new State(masterGenesis);
  const e1 = epochOf(GTS) + 1;
  for (const [kp, v] of [[o1, 1.0], [o2, 1.002], [o3, 0.999]] as const) {
    assert.equal(s.ingestObservation(obs(kp, "USD", "currency", v, e1 * EPOCH_MS + 10)).ok, true);
  }
  s.advance(at(e1));
  const lock = s.valueOf("USD");
  assert.ok(lock, "a lock should seal");
  assert.ok(lock!.resonantValue > 0.99 && lock!.resonantValue < 1.01);
  assert.ok(s.supply.emitted > 0, "base emission is minted to the masters");
  assert.ok(s.balanceOf(o1.address) > 0 && s.balanceOf(o2.address) === 0, "base emission goes to the settler (first master) alone");
});

test("work-gate is not self-grantable: a forged self-send earns no eligibility; a real third-party payout does", () => {
  const s = new State(genesis);
  const e1 = epochOf(GTS) + 1;
  s.ingestTx(tx(founder, alice.address, 5_000_000, 0, e1 * EPOCH_MS + 10, "reserve_grant"));
  s.advance(at(e1));

  // C1: a self-sent agent_spend carrying the "coordination payout" memo (from == to) must NOT set
  // lastWorkEpoch — otherwise any identity forges work eligibility for free and defeats the Sybil gate.
  const e2 = e1 + 1;
  s.ingestTx(txMemo(alice, alice.address, 1_000_000, 0, e2 * EPOCH_MS + 10, "agent_spend", "coordination payout deadbeef general"));
  s.advance(at(e2));
  assert.equal(s.accounts.get(alice.address)?.lastWorkEpoch ?? -1, -1, "a self-send cannot forge work eligibility");

  // A genuine third-party payout (from != to, positive amount, base fee, coordination memo) DOES grant the
  // recipient eligibility — this is exactly what settleQueryCoordination emits.
  const e3 = e2 + 1;
  s.ingestTx(txMemo(alice, bob.address, 1_000_000, 1, e3 * EPOCH_MS + 10, "agent_spend", "coordination payout deadbeef general"));
  s.advance(at(e3));
  // lastWorkEpoch is stamped at the epoch the payout is APPLIED, which trails its timestamp by SETTLE_ROUNDS.
  assert.equal(s.accounts.get(bob.address)?.lastWorkEpoch, e3 + SETTLE_ROUNDS, "a real coordination payout grants eligibility");
});

test("anchor genesis exposes 512 seats, all owned by the steward at launch (refined model)", () => {
  const total = Object.values(ANCHOR_CLASSES).reduce((sum, c) => sum + c.seats, 0);
  assert.equal(total, TOTAL_ANCHOR_SEATS);
  assert.deepEqual(Object.fromEntries(Object.entries(ANCHOR_CLASSES).map(([k, v]) => [k, [v.name, v.seats]])), {
    A: ["Genesis", 16],
    B: ["Meridian", 32],
    C: ["Nexus", 64],
    D: ["Lattice", 96],
    E: ["Sentinel", 160],
    F: ["Foundation", 144],
  });

  // Refined model: the steward anchor-reserve wallet owns ALL 512 positions at genesis. Positions are
  // transferred out to chosen owners after launch (single or batch), at which point vesting begins.
  const mainnet = standardGenesis("mainnet", founder.address, GTS);
  const seats = new State(mainnet).anchorSeats();
  assert.equal(seats.length, 512);
  const seeded = seats.filter((a) => a.owner);
  assert.equal(seeded.length, 512, "every position owned by the steward at genesis");
  for (const code of ["A", "B", "C", "D", "E", "F"]) {
    assert.equal(seeded.filter((a) => a.classCode === code).length, ANCHOR_CLASSES[code as keyof typeof ANCHOR_CLASSES].seats);
  }
});

test("anchor claim, duplicate claim, transfer, listing, and snapshot are deterministic", () => {
  const seatCode = "TEST-ANCHOR-CODE";
  const anchorGenesis = {
    ...genesis,
    anchors: [{ seatId: "A-999", classCode: "A" as const, seatIndex: 999, codeHash: hashHex(seatCode) }],
    anchorOwnership: [],
  };
  const s = new State(anchorGenesis);
  const e1 = epochOf(GTS) + 1;
  s.ingestTx(tx(founder, alice.address, 5_000_000, 0, e1 * EPOCH_MS + 10, "reserve_grant"));
  s.ingestTx(tx(founder, bob.address, 5_000_000, 1, e1 * EPOCH_MS + 20, "reserve_grant"));
  s.advance(at(e1));

  const e2 = e1 + 1;
  const claim = txMemo(alice, alice.address, 0, 0, e2 * EPOCH_MS + 10, "anchor_claim", JSON.stringify({ anchor: "claim", data: { seatId: "A-999", code: seatCode } }));
  assert.equal(s.ingestTx(claim).ok, true);
  s.advance(at(e2));
  assert.equal(s.anchorSeat("A-999")?.owner, alice.address);
  assert.equal(s.anchorSeat("A-999")?.status, "owned");

  const e3 = e2 + 1;
  const duplicate = txMemo(bob, bob.address, 0, 0, e3 * EPOCH_MS + 10, "anchor_claim", JSON.stringify({ anchor: "claim", data: { seatId: "A-999", code: seatCode } }));
  assert.equal(s.ingestTx(duplicate).ok, true);
  s.advance(at(e3));
  assert.equal(s.anchorSeat("A-999")?.owner, alice.address);
  assert.equal(s.nonceOf(bob.address), 0);

  const beforeTransferRoot = s.stateRoot();
  const e4 = e3 + 1;
  const transfer = txMemo(alice, alice.address, 0, 1, e4 * EPOCH_MS + 10, "anchor_transfer", JSON.stringify({ anchor: "transfer", data: { seatId: "A-999", to: bob.address } }));
  assert.equal(s.ingestTx(transfer).ok, true);
  s.advance(at(e4));
  assert.equal(s.anchorSeat("A-999")?.owner, bob.address);
  assert.notEqual(s.stateRoot(), beforeTransferRoot);

  const e5 = e4 + 1;
  const list = txMemo(bob, bob.address, 0, 0, e5 * EPOCH_MS + 10, "anchor_list", JSON.stringify({ anchor: "list", data: { seatId: "A-999", priceUZIR: 123_000_000 } }));
  assert.equal(s.ingestTx(list).ok, true);
  s.advance(at(e5));
  assert.equal(s.anchorListings().length, 1);

  const restored = new State(anchorGenesis);
  restored.loadSnapshot(s.snapshot());
  assert.equal(restored.stateRoot(), s.stateRoot());
  assert.equal(restored.anchorSeat("A-999")?.status, "listed");
});

test("anchor activation is disabled and founder code edits are limited to unclaimed seats", () => {
  const anchorGenesis = {
    ...genesis,
    anchors: [{ seatId: "B-999", classCode: "B" as const, seatIndex: 999, codeHash: hashHex("old") }],
    anchorOwnership: [],
  };
  const s = new State(anchorGenesis);
  const e1 = epochOf(GTS) + 1;
  s.ingestTx(tx(founder, alice.address, 5_000_000, 0, e1 * EPOCH_MS + 10, "reserve_grant"));
  s.advance(at(e1));

  const activate = txMemo(alice, alice.address, 0, 0, (e1 + 1) * EPOCH_MS + 10, "anchor_activate", JSON.stringify({ anchor: "activate", data: { seatId: "B-999" } }));
  const rejected = s.ingestTx(activate);
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason ?? "", /disabled/);

  const nonFounderEdit = txMemo(alice, alice.address, 0, 0, (e1 + 1) * EPOCH_MS + 20, "anchor_code_edit", JSON.stringify({ anchor: "code_edit", data: { seatId: "B-999", codeHash: hashHex("bad") } }));
  assert.equal(s.ingestTx(nonFounderEdit).ok, true);
  s.advance(at(e1 + 1));
  assert.equal(s.anchorSeat("B-999")?.codeHash, hashHex("old"));

  const e3 = e1 + 2;
  const edit = txMemo(founder, founder.address, 0, 1, e3 * EPOCH_MS + 10, "anchor_code_edit", JSON.stringify({ anchor: "code_edit", data: { seatId: "B-999", codeHash: hashHex("new") } }));
  assert.equal(s.ingestTx(edit).ok, true);
  s.advance(at(e3));
  assert.equal(s.anchorSeat("B-999")?.codeHash, hashHex("new"));
});
