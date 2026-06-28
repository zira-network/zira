// node/test/anchor-resonators-materialize.test.ts
// Task 1: the 512 anchor RESONATORS must appear on the anchor-reserve wallet on EVERY node, derived
// deterministically from genesis (like the anchor positions + class ZTI), NOT gated on a live steward
// signer. This proves a fresh node started with NO steward/anchor-reserve key still lists all 512 anchor
// resonators owned by the anchor-reserve wallet, each at its correct class ZTI and deterministic id.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  keypairFromPrivate, standardGenesis,
  TOTAL_ANCHOR_SEATS, ANCHOR_CLASS_ZTI, MAINNET_ANCHOR_STEWARD,
  anchorResonatorId, anchorResonatorAgentAddress,
  type AnchorClass,
} from "@zira/protocol";
import { ZiraNode } from "../src/core/ZiraNode.js";
import type { ZiraNetwork } from "../src/p2p/Network.js";

const founder = keypairFromPrivate("0a".repeat(32));
const GTS = 1_700_000_000_000;

function fakeNet(): ZiraNetwork {
  return {
    start: async () => {}, stop: async () => {}, publish: async () => {}, onMessage: () => {},
    setSyncProvider: () => {}, onSyncFrame: () => {}, handle: () => {}, request: async () => [],
    onPeerConnect: () => {}, dial: async () => {}, multiaddrs: () => [], peerId: () => "test-peer",
    peerCount: () => 0, peers: () => [],
  } as unknown as ZiraNetwork;
}

function freshMainnetNodeNoStewardKey(): ZiraNode {
  // Mainnet genesis: the steward anchor-reserve wallet owns all 512 positions. Crucially we pass NO
  // anchorReserveKey, so this node has no steward signer at all (mirrors a dedicated-wallet VPS node).
  const genesis = standardGenesis("mainnet", founder.address, GTS);
  const dir = join(tmpdir(), `zira-anchor-mat-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return new ZiraNode(genesis, founder, fakeNet(), dir, {});
}

test("a fresh node with NO steward key materializes all 512 anchor resonators on the anchor-reserve wallet", () => {
  const node = freshMainnetNodeNoStewardKey();
  const anchorResonators = [...node.soft.resonators.values()].filter((r) => r.id.startsWith("anchor-"));
  assert.equal(anchorResonators.length, TOTAL_ANCHOR_SEATS, "all 512 anchor resonators materialized without a steward key");
  // every one is owned by the anchor-reserve / steward wallet at genesis
  assert.ok(anchorResonators.every((r) => r.owner === MAINNET_ANCHOR_STEWARD), "every anchor resonator owned by the anchor-reserve wallet");
});

test("each materialized anchor resonator carries its correct class ZTI and deterministic id/address", () => {
  const node = freshMainnetNodeNoStewardKey();
  for (const seat of node.state.anchorSeats()) {
    const code = seat.classCode as AnchorClass;
    const r = node.soft.resonators.get(anchorResonatorId(seat.id));
    assert.ok(r, `resonator for seat ${seat.id} exists`);
    assert.equal(r!.zti, ANCHOR_CLASS_ZTI[code], `${seat.id} seeded at class ${code} ZTI`);
    // class ZTI applies to every coordination domain on the fresh record
    for (const d of r!.domains) assert.equal(r!.ztiByDomain[d], ANCHOR_CLASS_ZTI[code]);
    // the agent wallet is the deterministic public-namespace address (identical on every node)
    assert.equal(r!.address, anchorResonatorAgentAddress(seat.id), `${seat.id} agent address is deterministic`);
    assert.equal(r!.listed, true, `${seat.id} resonator is listed`);
  }
});

test("materialization is deterministic: two independent fresh nodes produce identical anchor-resonator sets", () => {
  const a = freshMainnetNodeNoStewardKey();
  const b = freshMainnetNodeNoStewardKey();
  const setOf = (n: ZiraNode) => [...n.soft.resonators.values()]
    .filter((r) => r.id.startsWith("anchor-"))
    .map((r) => `${r.id}|${r.owner}|${r.address}|${r.zti}`)
    .sort();
  assert.deepEqual(setOf(a), setOf(b), "every node reconstructs the identical canonical anchor-resonator set");
});
