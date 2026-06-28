// Resonator ownership transfer (spec §7). A non-anchor Resonator can be transferred to another ZIR
// address, but ONLY by its current owner: an owner change is accepted only when signed by the current
// owner. This both enables transfer and closes a hijack gap (a third party republishing the record under
// their own owner with a newer timestamp). Soft state, consensus-neutral.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keypairFromPrivate, generateKeypair, signRecord, standardGenesis, PROTOCOL, type Keypair, type Resonator } from "@zira/protocol";
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
function buildNode(): ZiraNode {
  const dir = join(tmpdir(), `zira-res-xfer-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return new ZiraNode(standardGenesis("devnet", founder.address, GTS), founder, fakeNet(), dir);
}
// A signed resonator record with a fixed id and agent wallet; owner + signer vary per scenario.
const AGENT = "zir1agentwalletfixedforthetransfertesthold00000";
function rec(ownerAddr: string, signer: Keypair, updatedAt: number, extra: Record<string, unknown> = {}): Resonator {
  return signRecord({
    id: "res-xfer-1", owner: ownerAddr, address: AGENT, name: "Transfer test", purpose: "p",
    systemPrompt: "s", domains: ["general"], modelPref: "text", zti: 0, ztiByDomain: {},
    resonanceEnabled: false, balanceUZIR: PROTOCOL.RESONATOR_CREATION_COST_UZIR,
    spendLimits: { perTxUZIR: 0, perDayUZIR: 0, minCounterpartyZti: 0, allowedDomains: ["general"] },
    totalEarnedUZIR: 0, totalSpentUZIR: 0, jobsDone: 0, priceUZIR: 0, listed: false,
    createdAt: GTS, updatedAt, status: "idle", ...extra,
  }, signer.privateKey) as unknown as Resonator;
}

test("a Resonator transfers only when the current owner signs the owner change", () => {
  const node = buildNode();
  const alice = generateKeypair(), bob = generateKeypair(), mallory = generateKeypair();
  const owned = () => node.soft.resonators.get("res-xfer-1")?.owner;

  // Alice creates her Resonator (self-signed).
  assert.equal(node.soft.upsertResonator(rec(alice.address, alice, GTS + 1)), true, "owner creates");
  assert.equal(owned(), alice.address);

  // Alice transfers it to Bob: the owner change is signed by the CURRENT owner (Alice).
  assert.equal(node.soft.upsertResonator(rec(bob.address, alice, GTS + 2)), true, "current owner authorizes transfer");
  assert.equal(owned(), bob.address, "owner is now Bob");

  // Hijack attempt: Mallory republishes it under herself with a newer timestamp. Rejected.
  assert.equal(node.soft.upsertResonator(rec(mallory.address, mallory, GTS + 3)), false, "hijack by a non-owner is rejected");
  assert.equal(owned(), bob.address, "ownership unchanged after the hijack attempt");

  // The former owner (Alice) can no longer change the owner either.
  assert.equal(node.soft.upsertResonator(rec(alice.address, alice, GTS + 4)), false, "former owner cannot reclaim it");
  assert.equal(owned(), bob.address);

  // The new owner (Bob) now controls it with his own self-signed updates.
  assert.equal(node.soft.upsertResonator(rec(bob.address, bob, GTS + 5, { name: "Bob's Resonator" })), true, "new owner controls it");
  assert.equal(node.soft.resonators.get("res-xfer-1")?.name, "Bob's Resonator");
});
