// node/test/anchor-resonators.test.ts
// The 512 anchor RESONATORS as operating entities: the steward anchor-reserve wallet owns one resonator
// per anchor POSITION, each seeded with its class ZTI, tied to its position. They transfer together with
// the position to an owner, and the new owner holds the resonator (re-keyed by the steward authority on
// the settled position_transfer). Soft state, mints no ZIR, consensus-neutral.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  keypairFromPrivate, generateKeypair, signTx, signRecord, buildTxBody, hashHex, standardGenesis, PROTOCOL,
  ANCHOR_CLASS_ZTI, anchorResonatorId, type AnchorClass, type Resonator,
} from "@zira/protocol";
import { ZiraNode } from "../src/core/ZiraNode.js";
import { EPOCH_MS, epochOf, GRACE_MS, SETTLE_ROUNDS } from "../src/core/State.js";
import type { ZiraNetwork } from "../src/p2p/Network.js";

const founder = keypairFromPrivate("0a".repeat(32));
const steward = keypairFromPrivate("0e".repeat(32)); // the anchor-reserve / steward wallet
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

function buildStewardNode(seats: { seatId: string; classCode: AnchorClass; seatIndex: number; code: string }[]) {
  const anchorGenesis = {
    ...standardGenesis("devnet", founder.address, GTS),
    anchors: seats.map((s) => ({ seatId: s.seatId, classCode: s.classCode, seatIndex: s.seatIndex, codeHash: hashHex(s.code) })),
    anchorOwnership: seats.map((s) => ({ seatId: s.seatId, owner: steward.address })),
  };
  const dir = join(tmpdir(), `zira-anchor-res-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
}

test("steward seeds one anchor resonator per owned position, at its class ZTI", () => {
  const node = buildStewardNode([
    { seatId: "A-001", classCode: "A", seatIndex: 1, code: "C-A-001" },
    { seatId: "C-010", classCode: "C", seatIndex: 10, code: "C-C-010" },
    { seatId: "F-073", classCode: "F", seatIndex: 73, code: "C-F-073" },
  ]);
  node.seedStewardResonators();

  for (const [seatId, code] of [["A-001", "A"], ["C-010", "C"], ["F-073", "F"]] as const) {
    const r = node.soft.resonators.get(anchorResonatorId(seatId));
    assert.ok(r, `${seatId} anchor resonator seeded`);
    assert.equal(r!.owner, steward.address, `${seatId} owned by the steward at genesis`);
    assert.equal(r!.zti, ANCHOR_CLASS_ZTI[code], `${seatId} seeded at class ${code} ZTI`);
    assert.equal(r!.ztiByDomain[r!.domains[0]!], ANCHOR_CLASS_ZTI[code], "per-domain seed ZTI applied");
    assert.equal(r!.listed, true, "anchor resonator is listed in the Field Exchange");
  }
  // idempotent: re-seeding does not duplicate
  const before = node.soft.resonators.size;
  node.seedStewardResonators();
  assert.equal(node.soft.resonators.size, before, "re-seeding is idempotent");
});

test("an anchor resonator follows its position to the new owner; standing carries; no ZIR minted", { timeout: 20_000 }, () => {
  const node = buildStewardNode([{ seatId: "A-009", classCode: "A", seatIndex: 9, code: "C-A-009" }]);
  const owner = generateKeypair();
  const alloc = node.state.anchorSeat("A-009")!.zirReserveUZIR;
  seedSteward(node, alloc + 100 * PROTOCOL.UZIR_PER_ZIR);
  node.seedStewardResonators();

  const before = node.soft.resonators.get(anchorResonatorId("A-009"))!;
  assert.equal(before.owner, steward.address);
  let supplyBefore = 0; for (const a of node.state.accounts.values()) supplyBefore += a.balance; supplyBefore += node.state.supply.burned;

  // transfer the POSITION via the existing path; the seat owner changes after the epoch settles
  const res = node.transferAnchorPositions(["A-009"], owner.address);
  assert.equal(res.ok, true, res.reason);
  advancePast(node, res.vestStartAt!);
  assert.equal(node.state.anchorSeat("A-009")!.owner, owner.address, "position moved on-chain");

  // re-seed re-keys the operating resonator to follow its position
  node.seedStewardResonators();
  const after = node.soft.resonators.get(anchorResonatorId("A-009"))!;
  assert.equal(after.owner, owner.address, "anchor resonator follows the position to the new owner");
  assert.equal(after.zti, ANCHOR_CLASS_ZTI.A, "class ZTI standing carried with the resonator");

  let supplyAfter = 0; for (const a of node.state.accounts.values()) supplyAfter += a.balance; supplyAfter += node.state.supply.burned;
  assert.ok(supplyAfter <= supplyBefore, "no new ZIR minted by seeding/transfer");
});

test("a third party cannot forge an anchor resonator (not signed by the steward authority)", () => {
  const node = buildStewardNode([{ seatId: "B-005", classCode: "B", seatIndex: 5, code: "C-B-005" }]);
  const attacker = generateKeypair();
  // an attacker tries to publish a high-ZTI anchor resonator they "own"
  const rec = signRecord({
    id: anchorResonatorId("B-005"), owner: attacker.address, address: attacker.address,
    name: "Anchor B-005 (Meridian)", purpose: "forged", systemPrompt: "x", domains: ["general"], modelPref: "text",
    zti: 0.85, ztiByDomain: {}, resonanceEnabled: true, balanceUZIR: 0,
    spendLimits: { perTxUZIR: 0, perDayUZIR: 0, minCounterpartyZti: 0, allowedDomains: ["general"] },
    totalEarnedUZIR: 0, totalSpentUZIR: 0, jobsDone: 0, priceUZIR: 0, listed: true,
    createdAt: 1, updatedAt: 1, status: "learning",
  }, attacker.privateKey) as Resonator;
  assert.equal(node.soft.upsertResonator(rec), false, "forged anchor resonator rejected (wrong signer)");
});
