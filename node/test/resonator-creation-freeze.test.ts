// Resonator-creation freeze (Case B). Once armed (RESONATOR_CREATION_FREEZE_ACTIVATION_EPOCH > 0 and the
// current epoch has reached it), nodes refuse a BRAND-NEW user Resonator until every anchor seat is secured
// by a user. Enforcement is on the accept path (upsertResonator), so old app releases cannot bypass it.
// Existing Resonators (createdAt before the activation epoch) are grandfathered; the seeded anchor/steward
// Resonators are always exempt. Resonators are soft state (off the state root), so this is consensus-neutral.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keypairFromPrivate, generateKeypair, signRecord, standardGenesis, PROTOCOL, type Keypair, type Resonator } from "@zira/protocol";
import { ZiraNode } from "../src/core/ZiraNode.js";
import type { ZiraNetwork } from "../src/p2p/Network.js";

const founder = keypairFromPrivate("0a".repeat(32));
const GTS = 1_700_000_000_000;
const ROUND = PROTOCOL.ACCOUNTING_ROUND_MS;
const ACTIVATION = Math.floor(GTS / ROUND);                 // the epoch of the genesis timestamp
const POST = GTS + ROUND * 5;                               // createdAt whose epoch is >= ACTIVATION (a new one)
const PRE = GTS - ROUND * 5;                                // createdAt whose epoch is < ACTIVATION (grandfathered)

function fakeNet(): ZiraNetwork {
  return {
    start: async () => {}, stop: async () => {}, publish: async () => {}, onMessage: () => {},
    setSyncProvider: () => {}, onSyncFrame: () => {}, handle: () => {}, request: async () => [],
    onPeerConnect: () => {}, dial: async () => {}, multiaddrs: () => [], peerId: () => "test-peer",
    peerCount: () => 0, peers: () => [],
  } as unknown as ZiraNetwork;
}
function buildNode(): ZiraNode {
  const dir = join(tmpdir(), `zira-res-freeze-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return new ZiraNode(standardGenesis("devnet", founder.address, GTS), founder, fakeNet(), dir);
}
// A funded, self-signed user Resonator with the given id/owner and createdAt (drives the grandfather test).
function rec(id: string, owner: Keypair, createdAt: number, updatedAt: number, extra: Record<string, unknown> = {}): Resonator {
  return signRecord({
    id, owner: owner.address, address: `zir1agent${id.replace(/[^a-z0-9]/g, "").slice(0, 30)}`, name: `R ${id}`, purpose: "p",
    systemPrompt: "s", domains: ["general"], modelPref: "text", zti: 0, ztiByDomain: {},
    resonanceEnabled: false, balanceUZIR: PROTOCOL.RESONATOR_CREATION_COST_UZIR,
    spendLimits: { perTxUZIR: 0, perDayUZIR: 0, minCounterpartyZti: 0, allowedDomains: ["general"] },
    totalEarnedUZIR: 0, totalSpentUZIR: 0, jobsDone: 0, priceUZIR: 0, listed: false,
    createdAt, updatedAt, status: "idle", ...extra,
  }, owner.privateKey) as unknown as Resonator;
}

function withActivation(epoch: number, fn: () => void): void {
  const prev = (PROTOCOL as { RESONATOR_CREATION_FREEZE_ACTIVATION_EPOCH: number }).RESONATOR_CREATION_FREEZE_ACTIVATION_EPOCH;
  (PROTOCOL as { RESONATOR_CREATION_FREEZE_ACTIVATION_EPOCH: number }).RESONATOR_CREATION_FREEZE_ACTIVATION_EPOCH = epoch;
  try { fn(); } finally { (PROTOCOL as { RESONATOR_CREATION_FREEZE_ACTIVATION_EPOCH: number }).RESONATOR_CREATION_FREEZE_ACTIVATION_EPOCH = prev; }
}

test("freeze OFF (flag false): a new user Resonator is accepted (today's behavior)", () => {
  const node = buildNode();
  const alice = generateKeypair();
  assert.equal(node.soft.upsertResonator(rec("free-1", alice, POST, GTS + 1), undefined, false), true);
  assert.ok(node.soft.resonators.has("free-1"));
});

test("freeze ON: a brand-new user Resonator (created after activation) is rejected", () => {
  withActivation(ACTIVATION, () => {
    const node = buildNode();
    const alice = generateKeypair();
    assert.equal(node.soft.upsertResonator(rec("new-1", alice, POST, GTS + 1), undefined, true), false, "new user resonator refused while frozen");
    assert.equal(node.soft.resonators.has("new-1"), false);
  });
});

test("freeze ON: an existing Resonator created BEFORE activation is grandfathered", () => {
  withActivation(ACTIVATION, () => {
    const node = buildNode();
    const alice = generateKeypair();
    assert.equal(node.soft.upsertResonator(rec("old-1", alice, PRE, GTS + 1), undefined, true), true, "pre-activation resonator still accepted (fresh-node sync safe)");
    assert.ok(node.soft.resonators.has("old-1"));
  });
});

test("freeze ON: the seeded system Resonator is exempt", () => {
  withActivation(ACTIVATION, () => {
    const node = buildNode();
    const alice = generateKeypair();
    assert.equal(node.soft.upsertResonator(rec("zira", alice, POST, GTS + 1), undefined, true), true, "seeded 'zira' resonator is never frozen");
    assert.ok(node.soft.resonators.has("zira"));
  });
});

test("freeze ON: updates to an already-known Resonator still apply (only creation is blocked)", () => {
  withActivation(ACTIVATION, () => {
    const node = buildNode();
    const alice = generateKeypair();
    // Create while open, then update while frozen: the update is not a new creation, so it applies.
    assert.equal(node.soft.upsertResonator(rec("upd-1", alice, POST, GTS + 1), undefined, false), true, "created while open");
    assert.equal(node.soft.upsertResonator(rec("upd-1", alice, POST, GTS + 2, { name: "renamed" }), undefined, true), true, "update applies while frozen");
    assert.equal(node.soft.resonators.get("upd-1")?.name, "renamed");
  });
});

test("wiring: pricing().resonatorCreationOpen reflects the armed freeze (dormant by default)", () => {
  const node = buildNode();
  // Dormant (activation epoch 0): creation is open.
  assert.equal(node.pricing().resonatorCreationOpen, true, "open while dormant");
  // Armed and anchors not all secured (devnet has no secured seats): creation is closed.
  withActivation(1, () => {
    assert.equal(node.pricing().resonatorCreationOpen, false, "closed once armed and anchors not all secured");
  });
});
