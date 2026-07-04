// node/test/settler-failover.test.ts
// Settler FAILOVER (v2.0.2): the active settler is the lowest-index genesis master that is LIVE (beaconed a
// field heartbeat within the failover window). Normally that is masters[0] (box1). If box1 goes offline its
// heartbeat ages out and masters[1] takes over paying miners + resonators, so box1 is not a hard single point
// of failure. Who-settles is soft state (never in the root); failover only changes who ISSUES payout txs.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keypairFromPrivate, buildObservationBody, canonical, hashHex, sign as edSign, standardGenesis, PROTOCOL, type GenesisDoc } from "@zira/protocol";
import { ZiraNode } from "../src/core/ZiraNode.js";

const founder = keypairFromPrivate("0a".repeat(32));
const m1 = keypairFromPrivate("11".repeat(32)); // masters[0] = primary settler
const m2 = keypairFromPrivate("12".repeat(32)); // masters[1] = first failover
const m3 = keypairFromPrivate("13".repeat(32));
const genesis: GenesisDoc = {
  ...standardGenesis("devnet", founder.address, 1_700_000_000_000),
  masters: [m1, m2, m3].map((k) => ({ address: k.address, pubKey: k.publicKey })),
};

function netStub() {
  return { peerId: () => "p", peers: () => [], handle() {}, request: async () => [], publish: async () => {},
    onMessage() {}, setSyncProvider() {}, onSyncFrame() {}, onPeerConnect() {}, dial: async () => {},
    start: async () => {}, stop: async () => {}, multiaddrs: () => [], peerCount: () => 0 } as any;
}
function mkNode(identity: ReturnType<typeof keypairFromPrivate>) {
  return new ZiraNode(genesis, identity, netStub(), join(tmpdir(), `zira-fo-${process.pid}-${identity.address.slice(4, 12)}-${Date.now()}-${Math.random()}`));
}
// A live heartbeat carries a REAL-clock timestamp so it lands inside the failover window (activeSettlerIndex
// compares against Date.now()). agoMs>window simulates an offline master whose beacon has aged out.
function beat(node: ZiraNode, kp: ReturnType<typeof keypairFromPrivate>, agoMs: number) {
  const body = buildObservationBody({
    type: "value", observer: kp.publicKey, timestamp: Date.now() - agoMs, subject: PROTOCOL.FIELD_HEARTBEAT_SUBJECT,
    domain: "data", confidence: 0.9, sourceHashes: ["field-heartbeat"], value: 1, storageGiB: 0,
  });
  const c = canonical(body);
  return node.submitObservation({ ...body, id: hashHex(c), sig: edSign(c, kp.privateKey) });
}

test("primary (masters[0]) settles while it is live; masters[1] does NOT", () => {
  const node2 = mkNode(m2);
  beat(node2, m1, 5_000);   // box1 fresh
  beat(node2, m2, 5_000);   // node2 fresh too
  const s = node2.settlerStatus();
  assert.equal(s.activeIndex, 0, "lowest live index is masters[0]");
  assert.equal(s.isSettler, false, "masters[1] is not the settler while masters[0] is live");

  const node1 = mkNode(m1);
  beat(node1, m1, 5_000);
  assert.equal(node1.settlerStatus().isSettler, true, "masters[0] settles while live");
});

test("masters[1] TAKES OVER when masters[0] goes offline (its heartbeat ages out)", () => {
  const node2 = mkNode(m2);
  beat(node2, m1, 5_000);
  beat(node2, m2, 5_000);
  assert.equal(node2.settlerStatus().isSettler, false, "not settler while box1 live");

  // box1 goes offline: a FRESH node started later only ever sees box1's stale beacon + its own fresh one.
  const node2b = mkNode(m2);
  beat(node2b, m1, 5 * 60_000); // box1 last beaconed 5 min ago -> outside the 90s failover window
  beat(node2b, m2, 5_000);      // node2 still beaconing
  const s = node2b.settlerStatus();
  assert.equal(s.activeIndex, 1, "masters[0] aged out -> masters[1] is the active settler");
  assert.equal(s.isSettler, true, "masters[1] takes over paying when box1 is offline");
});

test("masters[2] only settles when BOTH masters[0] and masters[1] are offline (ordered failover)", () => {
  const node3 = mkNode(m3);
  beat(node3, m2, 5_000);   // masters[1] live, masters[0] absent
  beat(node3, m3, 5_000);
  assert.equal(node3.settlerStatus().activeIndex, 1, "masters[1] takes precedence over masters[2]");
  assert.equal(node3.settlerStatus().isSettler, false, "masters[2] waits while masters[1] is live");

  const node3b = mkNode(m3);
  beat(node3b, m3, 5_000);  // only masters[2] live
  assert.equal(node3b.settlerStatus().activeIndex, 2);
  assert.equal(node3b.settlerStatus().isSettler, true, "masters[2] settles when 0 and 1 are both offline");
});

test("no master heartbeat seen yet -> masters[0] holds the settler role (no premature failover)", () => {
  const node2 = mkNode(m2);
  const s = node2.settlerStatus();
  assert.equal(s.liveMasters, 0);
  assert.equal(s.activeIndex, 0, "with nothing observed, default to masters[0]");
  assert.equal(node2.settlerStatus().isSettler, false, "masters[1] does not grab the role on an empty view");
});
