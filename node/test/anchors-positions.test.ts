// node/test/anchors-positions.test.ts
// The REFINED anchor/resonator model: per-position ZIR allocations (reserved half 2x, open half 1x),
// genesis ownership by the steward anchor-reserve wallet, position transfers (single + batch, owner-
// authorized), anchor-resonator ZTI seeding, and the reconciliation of all allocations to the 30%
// anchor reserve. These tests prove: allocations reconcile, genesis ownership, single + batch transfer,
// vesting follows the new owner, ZTI seeding, and that supply is conserved / never inflated.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  keypairFromPrivate, generateKeypair, signTx, buildTxBody, hashHex, standardGenesis, PROTOCOL,
  ANCHOR_CLASSES, ANCHOR_CLASS_ZTI, TOTAL_ANCHOR_SEATS, ANCHOR_ALLOCATION_AUDIT,
  anchorPositionAllocationUZIR, anchorSeatAllocationUZIR, isReservedAnchorSeat,
  DEFAULT_MAINNET_ANCHOR_OWNERSHIP, MAINNET_ANCHOR_STEWARD, anchorVestedToDate,
  type AnchorClass,
} from "@zira/protocol";
import { ZiraNode } from "../src/core/ZiraNode.js";
import { State, EPOCH_MS, epochOf, GRACE_MS, SETTLE_ROUNDS } from "../src/core/State.js";
import type { ZiraNetwork } from "../src/p2p/Network.js";

const founder = keypairFromPrivate("0a".repeat(32));
const steward = keypairFromPrivate("0e".repeat(32)); // doubles as the anchor-reserve / steward wallet
const GTS = 1_700_000_000_000;

function fakeNet(): ZiraNetwork {
  return {
    start: async () => {}, stop: async () => {}, publish: async () => {}, onMessage: () => {},
    setSyncProvider: () => {}, onSyncFrame: () => {}, handle: () => {}, request: async () => [],
    onPeerConnect: () => {}, dial: async () => {}, multiaddrs: () => [], peerId: () => "test-peer",
    peerCount: () => 0, peers: () => [],
  } as unknown as ZiraNetwork;
}
function at(epoch: number): number { return (epoch + SETTLE_ROUNDS + 1) * EPOCH_MS + GRACE_MS + 1; }
function advancePast(node: ZiraNode, ts: number): void { node.state.advance(at(epochOf(ts) + 1)); }
function totalAccountedUZIR(node: ZiraNode): number {
  let bal = 0;
  for (const a of node.state.accounts.values()) bal += a.balance;
  return bal + node.state.supply.burned;
}

// Build a node where the steward wallet owns a set of seats at genesis (mirrors mainnet steward ownership).
function buildStewardNode(seats: { seatId: string; classCode: AnchorClass; seatIndex: number; code: string }[]) {
  const anchorGenesis = {
    ...standardGenesis("devnet", founder.address, GTS),
    anchors: seats.map((s) => ({ seatId: s.seatId, classCode: s.classCode, seatIndex: s.seatIndex, codeHash: hashHex(s.code) })),
    anchorOwnership: seats.map((s) => ({ seatId: s.seatId, owner: steward.address })),
  };
  const dir = join(tmpdir(), `zira-anchor-pos-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return new ZiraNode(anchorGenesis, founder, fakeNet(), dir, { anchorReserveKey: steward.privateKey });
}

function seedSteward(node: ZiraNode, amountUZIR: number): void {
  const e1 = epochOf(GTS) + 1;
  const seed = signTx(buildTxBody({
    network: "devnet", from: founder.address, fromPubKey: founder.publicKey, to: steward.address,
    amountUZIR, feeUZIR: PROTOCOL.BASE_FEE_UZIR, nonce: 0, kind: "reserve_grant", parents: [], timestamp: e1 * EPOCH_MS + 10,
  }), founder.privateKey);
  assert.equal(node.submitTx(seed).accepted, true);
  node.state.advance(at(e1));
  assert.equal(node.state.balanceOf(steward.address), amountUZIR);
}

test("per-position allocations reconcile to the 30% anchor reserve (8.604B; ~6M buffer below 8.61B)", () => {
  const a = ANCHOR_ALLOCATION_AUDIT;
  assert.equal(a.totalSeats, TOTAL_ANCHOR_SEATS, "all 512 positions accounted for");
  assert.equal(a.reservedSeats, 256, "256 reserved positions");
  assert.equal(a.openSeats, 256, "256 open positions");
  // 5.736B reserved + 2.868B open = 8.604B total
  assert.equal(a.reservedUZIR, 5_736_000_000 * PROTOCOL.UZIR_PER_ZIR, "reserved half = 5.736B ZIR");
  assert.equal(a.openUZIR, 2_868_000_000 * PROTOCOL.UZIR_PER_ZIR, "open half = 2.868B ZIR");
  assert.equal(a.totalUZIR, 8_604_000_000 * PROTOCOL.UZIR_PER_ZIR, "total = 8.604B ZIR");
  // the total fits inside the 30% reserve, with a documented ~6M ZIR buffer
  assert.ok(a.totalUZIR <= PROTOCOL.ANCHOR_RESERVE_UZIR, "allocations fit within the 30% anchor reserve");
  assert.equal(a.bufferUZIR, 6_000_000 * PROTOCOL.UZIR_PER_ZIR, "the buffer is ~6M ZIR");
});

test("per-class per-position allocation figures match the refined model (reserved 2x, open 1x)", () => {
  const oneX: Record<AnchorClass, number> = { A: 50e6, B: 35e6, C: 25e6, D: 12.5e6, E: 5e6, F: 1.5e6 };
  for (const code of Object.keys(oneX) as AnchorClass[]) {
    const open = anchorPositionAllocationUZIR(code, false);
    const reserved = anchorPositionAllocationUZIR(code, true);
    assert.equal(open, oneX[code] * PROTOCOL.UZIR_PER_ZIR, `${code} open = 1x`);
    assert.equal(reserved, oneX[code] * 2 * PROTOCOL.UZIR_PER_ZIR, `${code} reserved = 2x`);
  }
  // reserved/open split is by seat index: the lower half of each class is reserved
  assert.equal(isReservedAnchorSeat("A", 1), true);
  assert.equal(isReservedAnchorSeat("A", 8), true);
  assert.equal(isReservedAnchorSeat("A", 9), false, "A has 16 seats; index 9 is the open half");
  assert.equal(anchorSeatAllocationUZIR("A", 1), 100e6 * PROTOCOL.UZIR_PER_ZIR);
  assert.equal(anchorSeatAllocationUZIR("A", 9), 50e6 * PROTOCOL.UZIR_PER_ZIR);
});

test("genesis: the steward wallet owns all 512 positions; seats seed allocation + class ZTI", () => {
  assert.equal(DEFAULT_MAINNET_ANCHOR_OWNERSHIP.length, TOTAL_ANCHOR_SEATS, "all 512 owned at genesis");
  assert.ok(DEFAULT_MAINNET_ANCHOR_OWNERSHIP.every((o) => o.owner === MAINNET_ANCHOR_STEWARD), "steward owns all");

  const mainnet = standardGenesis("mainnet", founder.address, GTS);
  const seats = new State(mainnet).anchorSeats();
  assert.equal(seats.length, 512);
  assert.ok(seats.every((s) => s.owner === MAINNET_ANCHOR_STEWARD), "every seat owned by the steward");
  // allocation + ZTI seeded per class, reserved-half 2x
  const a1 = seats.find((s) => s.id === "A-001")!;
  const a9 = seats.find((s) => s.id === "A-009")!;
  assert.equal(a1.zirReserveUZIR, 100e6 * PROTOCOL.UZIR_PER_ZIR, "A-001 reserved-half: 100M");
  assert.equal(a9.zirReserveUZIR, 50e6 * PROTOCOL.UZIR_PER_ZIR, "A-009 open-half: 50M");
  for (const code of Object.keys(ANCHOR_CLASSES) as AnchorClass[]) {
    const seat = seats.find((s) => s.classCode === code)!;
    assert.equal(seat.zti, ANCHOR_CLASS_ZTI[code], `${code} resonator seeded at class ZTI`);
  }
  // the sum of every seat's allocation equals the reconciled total and fits the reserve
  const sum = seats.reduce((x, s) => x + s.zirReserveUZIR, 0);
  assert.equal(sum, ANCHOR_ALLOCATION_AUDIT.totalUZIR);
  assert.ok(sum <= PROTOCOL.ANCHOR_RESERVE_UZIR);
});

test("single position transfer moves the resonator and starts vesting to the new owner; supply conserved", { timeout: 20_000 }, () => {
  const node = buildStewardNode([{ seatId: "A-009", classCode: "A", seatIndex: 9, code: "C-A-009" }]);
  const owner = generateKeypair();
  const alloc = node.state.anchorSeat("A-009")!.zirReserveUZIR; // open-half: 50M
  seedSteward(node, alloc + 100 * PROTOCOL.UZIR_PER_ZIR);
  const supplyBefore = totalAccountedUZIR(node);

  const res = node.transferAnchorPositions(["A-009"], owner.address);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.vestingUZIR, alloc, "the full position allocation is scheduled to vest");
  advancePast(node, res.vestStartAt!);

  const seat = node.state.anchorSeat("A-009")!;
  assert.equal(seat.owner, owner.address, "the resonator (position) moved to the new owner");
  assert.equal(seat.zti, ANCHOR_CLASS_ZTI.A, "class ZTI standing carried with the position");
  assert.equal(seat.routingWeight, ANCHOR_CLASSES.A.weight, "weight carried with the position");
  assert.equal(seat.vestTotalUZIR, alloc, "schedule total = the position allocation");
  assert.equal(seat.vestBeneficiary, owner.address, "vesting beneficiary is the new owner");
  assert.equal(seat.vestFunder, steward.address, "the steward reserve funds the schedule");
  assert.equal(node.state.balanceOf(owner.address), 0, "NO instant payout: it vests over a year");
  assert.ok(totalAccountedUZIR(node) <= supplyBefore, "supply not inflated by the transfer");
});

test("batch position transfer moves multiple resonators in one signed op; vesting follows each", { timeout: 30_000 }, () => {
  const node = buildStewardNode([
    { seatId: "A-009", classCode: "A", seatIndex: 9, code: "C-A-009" },
    { seatId: "B-017", classCode: "B", seatIndex: 17, code: "C-B-017" },
    { seatId: "C-040", classCode: "C", seatIndex: 40, code: "C-C-040" },
  ]);
  const owner = generateKeypair();
  const allocs = ["A-009", "B-017", "C-040"].map((id) => node.state.anchorSeat(id)!.zirReserveUZIR);
  const totalAlloc = allocs.reduce((x, a) => x + a, 0);
  seedSteward(node, totalAlloc + 1000 * PROTOCOL.UZIR_PER_ZIR);
  const supplyBefore = totalAccountedUZIR(node);

  const res = node.transferAnchorPositions(["A-009", "B-017", "C-040"], owner.address);
  assert.equal(res.ok, true, res.reason);
  assert.equal(res.seatIds?.length, 3, "all three positions in one batch");
  assert.equal(res.vestingUZIR, totalAlloc, "the batch vests the sum of all three allocations");
  advancePast(node, res.vestStartAt!);

  for (const id of ["A-009", "B-017", "C-040"]) {
    const seat = node.state.anchorSeat(id)!;
    assert.equal(seat.owner, owner.address, `${id} owner moved`);
    assert.equal(seat.vestBeneficiary, owner.address, `${id} vesting follows the new owner`);
    assert.equal(seat.vestFunder, steward.address, `${id} funded by the steward reserve`);
  }
  assert.equal(node.state.balanceOf(owner.address), 0, "no instant payout across the batch");
  assert.ok(totalAccountedUZIR(node) <= supplyBefore, "supply not inflated by the batch transfer");

  // Drive vesting to completion: the owner ends up with exactly the sum, never more.
  const seat = node.state.anchorSeat("A-009")!;
  const start = seat.vestStartAt!;
  for (const id of ["A-009", "B-017", "C-040"]) node.state.anchorSeat(id)!.vestDurationMs = 100_000;
  const afterEnd = start + 100_000 + 10_000;
  for (let i = 0; i < 4; i++) { node.releaseAnchorVesting(afterEnd + i * EPOCH_MS); advancePast(node, afterEnd + i * EPOCH_MS); }
  assert.equal(node.state.balanceOf(owner.address), totalAlloc, "owner holds exactly the summed allocation, no more");
  assert.ok(totalAccountedUZIR(node) <= supplyBefore, "supply not inflated through full release");
});

test("owner-authorized re-transfer carries the remaining vesting to the next owner", { timeout: 30_000 }, () => {
  const node = buildStewardNode([{ seatId: "F-073", classCode: "F", seatIndex: 73, code: "C-F-073" }]);
  const owner1 = generateKeypair();
  const owner2 = generateKeypair();
  const alloc = node.state.anchorSeat("F-073")!.zirReserveUZIR; // open-half F: 1.5M
  seedSteward(node, alloc + 1000 * PROTOCOL.UZIR_PER_ZIR);

  // steward -> owner1 (opens schedule)
  const r1 = node.transferAnchorPositions(["F-073"], owner1.address);
  assert.equal(r1.ok, true, r1.reason);
  advancePast(node, r1.vestStartAt!);
  const seat = node.state.anchorSeat("F-073")!;
  seat.vestDurationMs = 100_000;
  const start = seat.vestStartAt!;

  // release ~half to owner1
  const half = start + 50_000;
  node.releaseAnchorVesting(half);
  advancePast(node, half);
  const releasedToOwner1 = node.state.balanceOf(owner1.address);
  assert.ok(releasedToOwner1 > 0 && releasedToOwner1 < alloc, "owner1 received a partial vest");

  // owner1 needs gas to sign the re-transfer: fund it in an earlier, fully-settled epoch.
  seedStewardTo(node, owner1.address, 10 * PROTOCOL.UZIR_PER_ZIR, epochOf(half) + 2);

  // owner1 -> owner2 via an owner-signed anchor_position_transfer (the carry path)
  const e = epochOf(half) + 4;
  const transfer = signTx(buildTxBody({
    network: "devnet", from: owner1.address, fromPubKey: owner1.publicKey, to: owner1.address,
    amountUZIR: 0, feeUZIR: PROTOCOL.BASE_FEE_UZIR, nonce: node.state.provisionalNonce(owner1.address),
    kind: "anchor_position_transfer", parents: [], timestamp: e * EPOCH_MS + 10,
    memo: JSON.stringify({ anchor: "position_transfer", data: { seatIds: ["F-073"], to: owner2.address } }),
  }), owner1.privateKey);
  assert.equal(node.submitTx(transfer).accepted, true);
  advancePast(node, e * EPOCH_MS + 10);

  const moved = node.state.anchorSeat("F-073")!;
  assert.equal(moved.owner, owner2.address, "position moved to owner2");
  assert.equal(moved.vestBeneficiary, owner2.address, "remaining vesting now goes to owner2");
  assert.equal(moved.vestedUZIR, releasedToOwner1, "vested high-water mark carried (no double-release)");

  // drive to completion: owner2 receives the REMAINDER only; owner1 keeps what already vested.
  const afterEnd = start + 100_000 + 10_000;
  for (let i = 0; i < 4; i++) { node.releaseAnchorVesting(afterEnd + i * EPOCH_MS); advancePast(node, afterEnd + i * EPOCH_MS); }
  assert.equal(node.state.balanceOf(owner1.address) >= releasedToOwner1, true, "owner1 keeps its vested portion");
  assert.equal(node.state.balanceOf(owner2.address), alloc - releasedToOwner1, "owner2 gets exactly the remainder");
});

test("a position transfer the signer does not own is refused (no ownership change, supply intact)", { timeout: 20_000 }, () => {
  const node = buildStewardNode([{ seatId: "A-009", classCode: "A", seatIndex: 9, code: "C-A-009" }]);
  const stranger = generateKeypair();
  seedSteward(node, 1000 * PROTOCOL.UZIR_PER_ZIR);
  seedStewardTo(node, stranger.address, 10 * PROTOCOL.UZIR_PER_ZIR, epochOf(GTS) + 2);
  const supplyBefore = totalAccountedUZIR(node);

  const e = epochOf(GTS) + 3;
  const bad = signTx(buildTxBody({
    network: "devnet", from: stranger.address, fromPubKey: stranger.publicKey, to: stranger.address,
    amountUZIR: 0, feeUZIR: PROTOCOL.BASE_FEE_UZIR, nonce: node.state.provisionalNonce(stranger.address),
    kind: "anchor_position_transfer", parents: [], timestamp: e * EPOCH_MS + 10,
    memo: JSON.stringify({ anchor: "position_transfer", data: { seatIds: ["A-009"], to: stranger.address } }),
  }), stranger.privateKey);
  node.submitTx(bad);
  advancePast(node, e * EPOCH_MS + 10);

  assert.equal(node.state.anchorSeat("A-009")!.owner, steward.address, "ownership unchanged for a non-owner signer");
  assert.equal(node.state.anchorSeat("A-009")!.vestTotalUZIR, undefined, "no schedule opened by a non-owner");
  assert.ok(totalAccountedUZIR(node) <= supplyBefore, "supply not inflated by the refused transfer");
});

// Fund an arbitrary address from the steward reserve so it can pay gas, settling by epoch `e`.
function seedStewardTo(node: ZiraNode, to: string, amountUZIR: number, e: number): void {
  const seed = signTx(buildTxBody({
    network: "devnet", from: steward.address, fromPubKey: steward.publicKey, to,
    amountUZIR, feeUZIR: PROTOCOL.BASE_FEE_UZIR, nonce: node.state.provisionalNonce(steward.address),
    kind: "transfer", parents: [], timestamp: e * EPOCH_MS + 5,
  }), steward.privateKey);
  assert.equal(node.submitTx(seed).accepted, true);
  advancePast(node, e * EPOCH_MS + 5);
}

test("anchor owner opens and closes a position for user contributions", () => {
  const seats = [{ seatId: "A-001", classCode: "A" as AnchorClass, seatIndex: 1, code: "code-A-001" }];
  const node = buildStewardNode(seats);
  seedSteward(node, 5_000_000);
  const seat0 = node.state.anchorSeats().find((a) => a.id === "A-001");
  assert.equal(seat0?.owner, steward.address, "steward owns the seat at genesis");
  assert.notEqual(seat0?.contributionsOpen, true, "contributions closed by default");

  const setContrib = (open: boolean, ts: number) => signTx(buildTxBody({
    network: "devnet", from: steward.address, fromPubKey: steward.publicKey, to: steward.address,
    amountUZIR: 0, feeUZIR: PROTOCOL.BASE_FEE_UZIR, nonce: node.state.provisionalNonce(steward.address),
    kind: "anchor_set_contributions", parents: [], timestamp: ts,
    memo: JSON.stringify({ anchor: "set_contributions", data: { seatIds: ["A-001"], open } }),
  }), steward.privateKey);

  const e = epochOf(GTS) + 3;
  assert.equal(node.submitTx(setContrib(true, e * EPOCH_MS + 10)).accepted, true);
  advancePast(node, e * EPOCH_MS + 10);
  assert.equal(node.state.anchorSeats().find((a) => a.id === "A-001")?.contributionsOpen, true, "owner opened contributions");

  const e2 = e + 1;
  assert.equal(node.submitTx(setContrib(false, e2 * EPOCH_MS + 10)).accepted, true);
  advancePast(node, e2 * EPOCH_MS + 10);
  assert.equal(node.state.anchorSeats().find((a) => a.id === "A-001")?.contributionsOpen, false, "owner closed contributions");
});

test("a non-owner cannot open an anchor position for contributions", () => {
  const seats = [{ seatId: "A-002", classCode: "A" as AnchorClass, seatIndex: 2, code: "code-A-002" }];
  const node = buildStewardNode(seats);
  seedSteward(node, 5_000_000);
  // fund a non-owner so it can pay the fee, then have it try to open the steward's seat
  const other = keypairFromPrivate("0f".repeat(32));
  const e = epochOf(GTS) + 3;
  const fund = signTx(buildTxBody({
    network: "devnet", from: steward.address, fromPubKey: steward.publicKey, to: other.address,
    amountUZIR: 2_000_000, feeUZIR: PROTOCOL.BASE_FEE_UZIR, nonce: node.state.provisionalNonce(steward.address),
    kind: "transfer", parents: [], timestamp: e * EPOCH_MS + 5,
  }), steward.privateKey);
  assert.equal(node.submitTx(fund).accepted, true);
  advancePast(node, e * EPOCH_MS + 5);
  const e2 = e + 1;
  const badTx = signTx(buildTxBody({
    network: "devnet", from: other.address, fromPubKey: other.publicKey, to: other.address,
    amountUZIR: 0, feeUZIR: PROTOCOL.BASE_FEE_UZIR, nonce: node.state.provisionalNonce(other.address),
    kind: "anchor_set_contributions", parents: [], timestamp: e2 * EPOCH_MS + 10,
    memo: JSON.stringify({ anchor: "set_contributions", data: { seatIds: ["A-002"], open: true } }),
  }), other.privateKey);
  node.submitTx(badTx);
  advancePast(node, e2 * EPOCH_MS + 10);
  assert.notEqual(node.state.anchorSeats().find((a) => a.id === "A-002")?.contributionsOpen, true, "non-owner cannot open contributions");
});
