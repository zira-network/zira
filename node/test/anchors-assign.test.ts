// node/test/anchors-assign.test.ts
// Anchor seat assignment by CONTRIBUTION with ONE-YEAR LINEAR VESTING (no codes). At genesis the steward
// anchor-reserve wallet owns every seat; after a USDT contribution confirms, the steward transfers the
// reserve-held seat to the contributor with transferAnchorPositions(), which opens a one-year linear
// vesting of the seat's class allocation to the new owner. The allocation is NOT paid out instantly:
// releaseAnchorVesting() releases the claimable delta over ~12 months. These tests prove the schedule is
// set up (not an instant transfer), that it releases linearly, that supply is never inflated, and that
// reassignment/edge cases are handled.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  keypairFromPrivate, generateKeypair, signTx, buildTxBody, hashHex, standardGenesis, PROTOCOL,
  ANCHOR_VESTING_DURATION_MS, anchorVestedToDate, anchorVestingClaimableUZIR,
  ANCHOR_CLASSES, TOTAL_ANCHOR_SEATS,
} from "@zira/protocol";
import { ZiraNode } from "../src/core/ZiraNode.js";
import { EPOCH_MS, epochOf, GRACE_MS, SETTLE_ROUNDS } from "../src/core/State.js";
import type { ZiraNetwork } from "../src/p2p/Network.js";

const founder = keypairFromPrivate("0a".repeat(32));
const reserve = keypairFromPrivate("0e".repeat(32)); // the anchor-reserve wallet (founder-held)
const GTS = 1_700_000_000_000;

// An in-process no-op network: the assignment flow only needs local state + store, never the wire.
function fakeNet(): ZiraNetwork {
  return {
    start: async () => {},
    stop: async () => {},
    publish: async () => {},
    onMessage: () => {},
    setSyncProvider: () => {},
    onSyncFrame: () => {},
    handle: () => {},
    request: async () => [],
    onPeerConnect: () => {},
    dial: async () => {},
    multiaddrs: () => [],
    peerId: () => "test-peer",
    peerCount: () => 0,
    peers: () => [],
  };
}

// a wall clock time at which exactly `epoch` becomes closable (and no later epoch)
function at(epoch: number): number { return (epoch + SETTLE_ROUNDS + 1) * EPOCH_MS + GRACE_MS + 1; }

// Advance state far enough that every event stamped at or before `ts` has settled. Release txs are
// stamped with a (possibly future, relative to real wall clock) `now`, so we settle relative to `ts`.
function advancePast(node: ZiraNode, ts: number): void {
  node.state.advance(at(epochOf(ts) + 1));
}

// Total ZIR live in accounts plus what has been burned. Transfers move balance between accounts and
// fees are burned, so this is NON-INCREASING under any sequence of transfers/vesting releases: nothing
// is ever minted. (It decreases slightly as fees burn.) The safety property is "never inflated".
function totalAccountedUZIR(node: ZiraNode): number {
  let bal = 0;
  for (const a of node.state.accounts.values()) bal += a.balance;
  return bal + node.state.supply.burned;
}

function buildAnchorNode(seatCode: string, seatId: string, classCode: "A" | "B" | "C" | "D" | "E" | "F") {
  const anchorGenesis = {
    ...standardGenesis("devnet", founder.address, GTS),
    anchors: [{ seatId, classCode, seatIndex: 1, codeHash: hashHex(seatCode) }],
    anchorOwnership: [{ seatId, owner: reserve.address }], // steward reserve owns every seat at genesis
  };
  const dir = join(tmpdir(), `zira-anchor-vest-${classCode}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return new ZiraNode(anchorGenesis, founder, fakeNet(), dir, { anchorReserveKey: reserve.privateKey });
}

// Seed the anchor-reserve wallet from the founder reserve so it can pay fees and fund the full
// vesting allocation. Returns the epoch after which the seed has settled.
function seedReserve(node: ZiraNode, amountUZIR: number): void {
  const e1 = epochOf(GTS) + 1;
  const seed = signTx(buildTxBody({
    network: "devnet", from: founder.address, fromPubKey: founder.publicKey, to: reserve.address,
    amountUZIR, feeUZIR: PROTOCOL.BASE_FEE_UZIR, nonce: 0, kind: "reserve_grant", parents: [], timestamp: e1 * EPOCH_MS + 10,
  }), founder.privateKey);
  assert.equal(node.submitTx(seed).accepted, true);
  node.state.advance(at(e1));
  assert.equal(node.state.balanceOf(reserve.address), amountUZIR);
}

test("the pure vesting math is linear, integer, and clamped to the total", () => {
  const total = 12_000_000;
  const start = 1_000_000;
  const sched = { totalUZIR: total, startAt: start, durationMs: 12_000 }; // 12s for a tight test
  assert.equal(anchorVestedToDate(sched, start - 1), 0, "nothing before start");
  assert.equal(anchorVestedToDate(sched, start), 0, "zero at start");
  assert.equal(anchorVestedToDate(sched, start + 6_000), 6_000_000, "half-way is half (linear)");
  assert.equal(anchorVestedToDate(sched, start + 12_000), total, "fully vested at end");
  assert.equal(anchorVestedToDate(sched, start + 100_000), total, "never exceeds the total");
  // claimable nets out what has already been released
  assert.equal(anchorVestingClaimableUZIR(sched, 4_000_000, start + 6_000), 2_000_000);
  assert.equal(anchorVestingClaimableUZIR(sched, 6_000_000, start + 6_000), 0, "nothing new yet");
  assert.equal(anchorVestingClaimableUZIR(sched, total, start + 100_000), 0, "fully released");
});

test("assigning an anchor sets up a one-year vesting, NOT an instant full transfer", { timeout: 20_000 }, () => {
  const seatCode = "ZIRA-ANCHOR-A-001-SECRET";
  const node = buildAnchorNode(seatCode, "A-001", "A");
  const requester = generateKeypair();
  const seatAllocUZIR = node.state.anchorSeat("A-001")!.zirReserveUZIR;
  seedReserve(node, seatAllocUZIR + 100 * PROTOCOL.UZIR_PER_ZIR);

  const supplyBefore = totalAccountedUZIR(node);

  // The contribution is confirmed; the steward transfers the reserve-held seat to the contributor.
  const assign = node.transferAnchorPositions(["A-001"], requester.address);
  assert.equal(assign.ok, true, assign.reason);
  assert.equal(assign.vestingUZIR, seatAllocUZIR, "the full class allocation is scheduled to vest");
  assert.equal(assign.vestEndAt! - assign.vestStartAt!, ANCHOR_VESTING_DURATION_MS, "a one-year window");

  // Settle the claim/vest_start/transfer chain.
  advancePast(node, assign.vestStartAt!);

  const seat = node.state.anchorSeat("A-001")!;
  assert.equal(seat.owner, requester.address, "ownership moved to the requester");
  assert.equal(seat.status, "owned");
  assert.equal(seat.vestTotalUZIR, seatAllocUZIR, "the schedule total is the class allocation");
  assert.equal(seat.vestBeneficiary, requester.address);
  assert.equal(seat.vestFunder, reserve.address, "the reserve wallet funds/authors the schedule");
  assert.equal(seat.vestedUZIR, 0, "nothing released at assignment time");

  // CRITICAL: the requester did NOT receive the full allocation up front.
  assert.equal(node.state.balanceOf(requester.address), 0, "no instant payout");

  // Supply is never inflated: assignment only burned fees, it minted nothing.
  assert.ok(totalAccountedUZIR(node) <= supplyBefore, "supply not inflated by assignment");
});

test("vesting releases linearly over time and never exceeds the allocation; supply stays exact", { timeout: 30_000 }, () => {
  const seatCode = "ZIRA-ANCHOR-F-001-SECRET";
  const node = buildAnchorNode(seatCode, "F-001", "F");
  const requester = generateKeypair();
  const seatAllocUZIR = node.state.anchorSeat("F-001")!.zirReserveUZIR;
  seedReserve(node, seatAllocUZIR + 100 * PROTOCOL.UZIR_PER_ZIR);
  const supplyAtSeed = totalAccountedUZIR(node);

  const assign = node.transferAnchorPositions(["F-001"], requester.address);
  assert.equal(assign.ok, true, assign.reason);
  const start = assign.vestStartAt!;
  advancePast(node, start); // settle the assignment chain

  // Drive vesting to ~half way. Override the schedule to a short duration so the test runs fast: the
  // schedule lives on the seat, so we shorten it directly (deterministic, same as a short-duration vest).
  const seat = node.state.anchorSeat("F-001")!;
  seat.vestDurationMs = 100_000; // 100s
  const half = start + 50_000;

  // Release at the half-way mark via the node's driver (submits transfer + accounting from the reserve).
  node.releaseAnchorVesting(half);
  advancePast(node, half);

  const expectedHalf = anchorVestedToDate({ totalUZIR: seatAllocUZIR, startAt: start, durationMs: 100_000 }, half);
  assert.equal(node.state.anchorSeat("F-001")!.vestedUZIR, expectedHalf, "released high-water mark tracks the linear schedule");
  assert.equal(node.state.balanceOf(requester.address), expectedHalf, "requester received exactly the vested-to-date amount");
  assert.ok(expectedHalf > 0 && expectedHalf < seatAllocUZIR, "half-way is a partial release, not full and not zero");
  assert.ok(totalAccountedUZIR(node) <= supplyAtSeed, "supply not inflated through partial release");

  // Drive past the end of the schedule: the full allocation should be released, and no more.
  const afterEnd = start + 100_000 + 10_000;
  // multiple ticks must not over-release: call the driver repeatedly, settling between.
  for (let i = 0; i < 3; i++) {
    node.releaseAnchorVesting(afterEnd + i * EPOCH_MS);
    advancePast(node, afterEnd + i * EPOCH_MS);
  }
  assert.equal(node.state.anchorSeat("F-001")!.vestedUZIR, seatAllocUZIR, "fully vested at the end");
  assert.equal(node.state.balanceOf(requester.address), seatAllocUZIR, "requester holds the full allocation, no more");
  assert.ok(totalAccountedUZIR(node) <= supplyAtSeed, "supply not inflated through full release");

  // A further release after full vesting is a no-op: balance unchanged.
  node.releaseAnchorVesting(afterEnd + 1_000_000);
  advancePast(node, afterEnd + 1_000_000);
  assert.equal(node.state.balanceOf(requester.address), seatAllocUZIR, "no over-release after full vesting");
});

test("the reserve backs all 512 positions: the genesis anchor reserve covers the sum of class allocations", () => {
  // The mainnet anchor-reserve (30% of cap) must be at least the sum over classes of count x allocation.
  let seats = 0;
  let totalAllocUZIR = 0n;
  for (const meta of Object.values(ANCHOR_CLASSES)) {
    seats += meta.seats;
    totalAllocUZIR += BigInt(meta.seats) * BigInt(meta.stakeZIR) * BigInt(PROTOCOL.UZIR_PER_ZIR);
  }
  assert.equal(seats, TOTAL_ANCHOR_SEATS, "all 512 positions are accounted for");
  assert.ok(totalAllocUZIR <= BigInt(PROTOCOL.ANCHOR_RESERVE_UZIR), "the 30% anchor reserve backs every position's allocation");
});

test("transferAnchorPositions is refused when the anchor-reserve key is not configured", () => {
  const seatCode = "ZIRA-ANCHOR-B-001-SECRET";
  const anchorGenesis = {
    ...standardGenesis("devnet", founder.address, GTS),
    anchors: [{ seatId: "B-001", classCode: "B" as const, seatIndex: 1, codeHash: hashHex(seatCode) }],
    anchorOwnership: [{ seatId: "B-001", owner: reserve.address }],
  };
  const dir = join(tmpdir(), `zira-anchor-noassign-${process.pid}-${Date.now()}`);
  const node = new ZiraNode(anchorGenesis, founder, fakeNet(), dir); // no anchorReserveKey
  const requester = generateKeypair();

  const res = node.transferAnchorPositions(["B-001"], requester.address);
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /not configured/);
});

test("a second assignment of an owned seat is refused, and the schedule is not overwritten", { timeout: 20_000 }, () => {
  const seatCode = "ZIRA-ANCHOR-C-001-SECRET";
  const node = buildAnchorNode(seatCode, "C-001", "C");
  const requester = generateKeypair();
  const seatAllocUZIR = node.state.anchorSeat("C-001")!.zirReserveUZIR;
  seedReserve(node, seatAllocUZIR + 100 * PROTOCOL.UZIR_PER_ZIR);

  const firstAssign = node.transferAnchorPositions(["C-001"], requester.address);
  assert.equal(firstAssign.ok, true);
  advancePast(node, firstAssign.vestStartAt!);
  const startAt = node.state.anchorSeat("C-001")!.vestStartAt;

  // Once transferred out, the seat is no longer owned by the reserve: a repeat transfer is refused and
  // does not disturb the original schedule.
  const second = node.transferAnchorPositions(["C-001"], requester.address);
  assert.equal(second.ok, false);
  assert.match(second.reason ?? "", /not owned by the steward reserve/);
  assert.equal(node.state.anchorSeat("C-001")!.vestStartAt, startAt, "the original schedule is untouched");
});
