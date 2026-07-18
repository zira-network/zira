// node/test/push-vouch.test.ts
// NAT/CGNAT earning: a home miner whose churning connection the master can't reverse-probe still has to earn.
// The fix is push liveness: the miner PUSHES a signed liveness assertion to the master over its OWN outbound
// connection, the master records it keyed by the connection's peer id, and freshVouchedMiners honours it for a
// freshness window so the miner lands in the field-participation payee set. This test pins that new path:
//   push -> serveLiveness (master-only, signature+freshness checked) -> pushVouch -> freshVouchedMiners
// The credit half of the chain (a payee in the settler's signed batch_transfer is credited exactly) is already
// proven by union-payout.test.ts, so together they cover push -> vouched -> paid end to end.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keypairFromPrivate, generateKeypair, standardGenesis, sign as edSign, type GenesisDoc } from "@zira/protocol";
import { ZiraNode } from "../src/core/ZiraNode.js";
import type { ZiraNetwork } from "../src/p2p/Network.js";

const founder = keypairFromPrivate("0a".repeat(32));
const masters = [
  keypairFromPrivate("51".repeat(32)),
  keypairFromPrivate("52".repeat(32)),
  keypairFromPrivate("53".repeat(32)),
  keypairFromPrivate("54".repeat(32)),
];
const genesis: GenesisDoc = {
  ...standardGenesis("devnet", founder.address, 1_700_000_000_000),
  masters: masters.map((k) => ({ address: k.address, pubKey: k.publicKey })),
};

function fakeNet(): ZiraNetwork {
  return {
    start: async () => {}, stop: async () => {}, publish: async () => {}, onMessage: () => {},
    setSyncProvider: () => {}, onSyncFrame: () => {}, handle: () => {}, request: async () => [],
    onPeerConnect: () => {}, dial: async () => {}, multiaddrs: () => [], peerId: () => "test-peer",
    peerCount: () => 0, peers: () => [], seedPeers: () => [],
  } as unknown as ZiraNetwork;
}
function nodeFor(id: ReturnType<typeof keypairFromPrivate>, tag: string): ZiraNode {
  const dir = join(tmpdir(), `zira-pushvouch-${process.pid}-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return new ZiraNode(genesis, id, fakeNet(), dir, {});
}

// Build the exact bytes a miner pushes: {push:true, address, pubKey, ts, sig:sign("zira-live-push:"+ts)}.
function pushBytes(miner: ReturnType<typeof generateKeypair>, ts: number): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({
    push: true, address: miner.address, pubKey: miner.publicKey, ts,
    sig: edSign("zira-live-push:" + ts, miner.privateKey),
  }));
}
async function deliver(node: ZiraNode, bytes: Uint8Array, from: string): Promise<void> {
  // serveLiveness is a private async generator; drain it so the push branch runs.
  for await (const _ of (node as unknown as { serveLiveness(r: Uint8Array, f: string): AsyncIterable<Uint8Array> }).serveLiveness(bytes, from)) { /* drain */ }
}
function fresh(node: ZiraNode, now: number): string[] {
  return (node as unknown as { freshVouchedMiners(n: number): string[] }).freshVouchedMiners(now);
}

test("a master vouches a valid pushed miner, and it appears in freshVouchedMiners", async () => {
  const master = nodeFor(masters[0]!, "m0");
  const miner = generateKeypair();
  const now = Date.now();
  await deliver(master, pushBytes(miner, now), "peerA");
  assert.ok(fresh(master, now).includes(miner.address), "pushed miner is vouched by the master");
});

test("a fresh push stays vouched for its window but is pruned once it ages out", async () => {
  const master = nodeFor(masters[0]!, "age");
  const miner = generateKeypair();
  const now = Date.now();
  await deliver(master, pushBytes(miner, now), "peerA");
  const maxAge = Number(process.env.ZIRA_PUSH_LIVENESS_MAX_AGE_MS ?? 90_000);
  // The push records its ts at DELIVERY (a few ms after `now`), so query with a margin larger than any
  // plausible delivery delay to stay unambiguously inside / outside the window.
  assert.ok(fresh(master, now + maxAge - 1_000).includes(miner.address), "still vouched within the freshness window");
  assert.ok(!fresh(master, now + maxAge + 5_000).includes(miner.address), "pruned once the push ages out");
});

test("a push binds by SIGNED ADDRESS, not by connection: one link can relay several signed miners, and a re-push of the same address does not accumulate", async () => {
  const master = nodeFor(masters[0]!, "sybil");
  const a = generateKeypair(), b = generateKeypair();
  const now = Date.now();
  // Two DIFFERENT validly-signed miners arriving over the SAME connection (the relay-forward / NAT case): each
  // carries its own miner signature, so both are vouched. The sybil bound is earned standing + the per-address
  // signature, NOT one-address-per-connection, so a public relay can carry many home miners on a single link.
  await deliver(master, pushBytes(a, now), "peerA");
  await deliver(master, pushBytes(b, now + 1), "peerA");
  const v = fresh(master, now + 2);
  assert.ok(v.includes(a.address) && v.includes(b.address), "both distinct signed miners are vouched over one connection");
  // A re-push of the SAME address only refreshes it (the vouch map is keyed by signed address) — never duplicates.
  await deliver(master, pushBytes(a, now + 3), "peerA");
  const v2 = fresh(master, now + 4);
  assert.equal(v2.filter((x) => x === a.address).length, 1, "a re-push of the same address does not accumulate a duplicate");
});

test("distinct connections each vouch their own miner", async () => {
  const master = nodeFor(masters[0]!, "two");
  const a = generateKeypair(), b = generateKeypair();
  const now = Date.now();
  await deliver(master, pushBytes(a, now), "peerA");
  await deliver(master, pushBytes(b, now), "peerB");
  const v = fresh(master, now);
  assert.ok(v.includes(a.address) && v.includes(b.address), "both connections' miners are vouched");
});

test("a non-master ignores pushes (only masters vouch)", async () => {
  const plain = nodeFor(generateKeypair(), "plain"); // identity is not in the master set
  const miner = generateKeypair();
  const now = Date.now();
  await deliver(plain, pushBytes(miner, now), "peerA");
  assert.ok(!fresh(plain, now).includes(miner.address), "a non-master does not record push vouches");
});

test("a forged push (bad signature) is rejected", async () => {
  const master = nodeFor(masters[0]!, "forge");
  const miner = generateKeypair();
  const now = Date.now();
  const bytes = new TextEncoder().encode(JSON.stringify({
    push: true, address: miner.address, pubKey: miner.publicKey, ts: now,
    sig: edSign("zira-live-push:" + (now + 5), miner.privateKey), // signature over the WRONG timestamp
  }));
  await deliver(master, bytes, "peerA");
  assert.ok(!fresh(master, now).includes(miner.address), "a push whose signature does not match is not vouched");
});

test("a stale-timestamp push is rejected even with a valid signature", async () => {
  const master = nodeFor(masters[0]!, "stale");
  const miner = generateKeypair();
  const now = Date.now();
  const old = now - 10 * 60_000; // 10 minutes old: well outside the max-age freshness bound
  await deliver(master, pushBytes(miner, old), "peerA");
  assert.ok(!fresh(master, now).includes(miner.address), "an old push is not vouched");
});

test("a master will not vouch another genesis master via push (masters are not mining payees)", async () => {
  const master = nodeFor(masters[0]!, "selfm");
  const now = Date.now();
  // masters[1] is a genesis master; a push claiming its address must be refused.
  await deliver(master, pushBytes(masters[1]!, now), "peerA");
  assert.ok(!fresh(master, now).includes(masters[1]!.address), "a genesis master is never a push-vouched miner");
});

// SENDING side (the v2.0.12 fix). The regression: a home/NAT miner reaches the masters via discovery or a relay,
// not via an exact "/p2p/<id>" configured-seed multiaddr, so seedPeers() is empty and the old code returned
// without ever pushing — connected and syncing, yet never vouched or paid. The miner must push to EVERY connected
// peer (masters record it, non-masters ignore it), so it no longer depends on the connected master being a seed.
function capturingNet(peers: string[], seeds: string[], calls: string[]): ZiraNetwork {
  return {
    start: async () => {}, stop: async () => {}, publish: async () => {}, onMessage: () => {},
    setSyncProvider: () => {}, onSyncFrame: () => {}, handle: () => {}, onPeerConnect: () => {},
    dial: async () => {}, multiaddrs: () => [], peerId: () => "self", peerCount: () => peers.length,
    peers: () => peers, seedPeers: () => seeds,
    request: async (peerId: string) => { calls.push(peerId); return []; },
  } as unknown as ZiraNetwork;
}
async function pushLiveness(miner: ReturnType<typeof generateKeypair>, net: ZiraNetwork): Promise<void> {
  const dir = join(tmpdir(), `zira-pushall-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const node = new ZiraNode(genesis, miner, net, dir, {});
  await (node as unknown as { models: { setMining(p: { enabled: boolean }): Promise<unknown> } }).models.setMining({ enabled: true });
  await (node as unknown as { contributePushLiveness(n: number): Promise<void> }).contributePushLiveness(Date.now());
}

test("a miner pushes liveness to EVERY connected peer even when seedPeers() is empty (the NAT earn fix)", async () => {
  const calls: string[] = [];
  await pushLiveness(generateKeypair(), capturingNet(["pA", "pB", "pC"], [], calls));
  assert.deepEqual([...calls].sort(), ["pA", "pB", "pC"], "pushed to all connected peers despite no configured-seed match");
});

test("push targets are the union of seeds and connected peers, de-duplicated", async () => {
  const calls: string[] = [];
  // seedPeers() reports pA (a seed we are connected to); peers() reports pA + two discovered peers.
  await pushLiveness(generateKeypair(), capturingNet(["pA", "pB", "pC"], ["pA"], calls));
  assert.deepEqual([...calls].sort(), ["pA", "pB", "pC"], "each peer pushed exactly once (no duplicate for the seed)");
});
