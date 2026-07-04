// node/test/union-payout.test.ts
// The settler pays the UNION of miners vouched by ANY master (aggregateVouchedMiners reads the same gossiped
// heartbeat observations runField uses), so earning does not hinge on which master a miner connected to. These
// tests prove (a) the aggregate is the exact fresh union and ignores stale/non-master vouches, (b) a union-
// sized batch (30+ payees, the live size that went silent) ingests and applies cleanly, and (c) the full
// payee pipeline (own vouches + aggregate -> filter -> sort -> slice -> batch tx) is accepted at ingest.
import test from "node:test";
import assert from "node:assert/strict";
import {
  keypairFromPrivate, buildObservationBody, canonical, hashHex, sign as edSign, signTx, standardGenesis,
  auditSupply, type GenesisDoc, type SignedObservation,
} from "@zira/protocol";
import { State, EPOCH_MS, epochOf, GRACE_MS, SETTLE_ROUNDS } from "../src/core/State.js";

const founder = keypairFromPrivate("0a".repeat(32));
const GTS = 1_700_000_000_000;
const m1 = keypairFromPrivate("11".repeat(32)); // masters[0] = settler
const m2 = keypairFromPrivate("12".repeat(32));
const m3 = keypairFromPrivate("13".repeat(32));
const genesis: GenesisDoc = {
  ...standardGenesis("devnet", founder.address, GTS),
  masters: [m1, m2, m3].map((k) => ({ address: k.address, pubKey: k.publicKey })),
};
const at = (epoch: number): number => (epoch + SETTLE_ROUNDS + 2) * EPOCH_MS + GRACE_MS + 1;

function heartbeat(kp: ReturnType<typeof keypairFromPrivate>, ts: number, vouchedMiners?: string[]): SignedObservation {
  const body = buildObservationBody({
    type: "value", observer: kp.publicKey, timestamp: ts, subject: "ZIRA_FIELD_HEARTBEAT",
    domain: "data", confidence: 0.9, sourceHashes: ["field-heartbeat"], value: 1, storageGiB: 0, vouchedMiners,
  });
  const c = canonical(body);
  return { ...body, id: hashHex(c), sig: edSign(c, kp.privateKey) };
}

function minerAddrs(n: number, seed: number): string[] {
  return Array.from({ length: n }, (_, i) => keypairFromPrivate((0x40 + seed).toString(16).padStart(2, "0").repeat(31) + (0x10 + i).toString(16).padStart(2, "0")).address);
}

test("aggregateVouchedMiners is the exact fresh union across masters and ignores stale + non-master vouches", () => {
  const s = new State(genesis);
  const now = at(epochOf(GTS) + 1);
  const FRESH_MS = 300_000;
  const setA = minerAddrs(10, 1);
  const setB = minerAddrs(10, 2);
  const overlap = setA.slice(0, 3);
  const staleMiner = minerAddrs(1, 3)[0]!;
  const nonMaster = keypairFromPrivate("77".repeat(32));

  assert.equal(s.ingestObservation(heartbeat(m1, now - 10_000, setA)).ok, true);
  assert.equal(s.ingestObservation(heartbeat(m2, now - 20_000, [...setB, ...overlap])).ok, true);
  // A vouch older than the freshness window must not reach the union. The obs pool's own age cutoff may
  // reject it at ingest already (also correct) — either way it stays out of the aggregate.
  s.ingestObservation(heartbeat(m3, now - FRESH_MS - 60_000, [staleMiner]));
  assert.equal(s.ingestObservation(heartbeat(nonMaster, now - 5_000, [staleMiner])).ok, true);      // not a master

  const union = new Set(s.aggregateVouchedMiners(now, FRESH_MS));
  for (const a of [...setA, ...setB]) assert.ok(union.has(a), `union includes ${a.slice(0, 12)}`);
  assert.ok(!union.has(staleMiner), "a stale master vouch is not in the union");
  assert.equal(union.size, new Set([...setA, ...setB]).size, "union is exactly the fresh master vouches");
});

test("a union-sized batch (30 payees) ingests and applies with an exact supply audit", () => {
  const s = new State(genesis);
  const e = epochOf(GTS) + 40; // enough epochs of base emission to fund the live 5000-ZIR pool
  s.advance(at(e));
  const settlerBal = s.balanceOf(m1.address);
  assert.ok(settlerBal > 5_000_000_000, `settler funded (${settlerBal})`);

  const payees = minerAddrs(30, 4).sort();
  const pool = 5_000_000_000;
  const per = Math.floor(pool / payees.length);
  const remainder = pool - per * payees.length;
  const outputs: [string, number][] = payees.map((to, i) => [to, per + (i === 0 ? remainder : 0)]);
  const ts = (e + SETTLE_ROUNDS + 3) * EPOCH_MS + 5;
  const tx = signTx({
    network: genesis.network, from: m1.address, fromPubKey: m1.publicKey, to: m1.address,
    amountUZIR: pool, feeUZIR: 1000, nonce: s.nonceOf(m1.address), kind: "batch_transfer",
    parents: [], timestamp: ts, memo: JSON.stringify({ o: outputs }),
  }, m1.privateKey);

  const r = s.ingestTx(tx);
  assert.equal(r.ok, true, `union-sized batch must ingest (reason: ${r.reason ?? "none"})`);

  s.advance(at(epochOf(ts)));
  for (const [to, amt] of outputs) assert.equal(s.balanceOf(to), amt, "every payee credited exactly");
  // no ZIR minted or lost: the independent supply audit credits each output exactly
  const audit = auditSupply(s.history, founder.address);
  for (const [addr, amt] of outputs) assert.equal(audit.balances[addr], amt, "audit credits each output");
});

test("the full settle payee pipeline (own + aggregate union) composes into an ingestable batch", () => {
  const s = new State(genesis);
  const e = epochOf(GTS) + 1;
  s.advance(at(e));
  const now = at(e) + 1;
  const FRESH_MS = 300_000;
  // masters vouch two overlapping sets, 28 distinct miners total
  const setA = minerAddrs(16, 5);
  const setB = [...minerAddrs(16, 6).slice(0, 12), ...setA.slice(0, 4)];
  assert.equal(s.ingestObservation(heartbeat(m2, now - 10_000, setA)).ok, true);
  assert.equal(s.ingestObservation(heartbeat(m3, now - 10_000, setB)).ok, true);

  // Mirror settleFieldParticipation's exact pipeline
  const own: string[] = [];
  const payees = [...new Set([...own, ...s.aggregateVouchedMiners(now, FRESH_MS)])]
    .filter((a) => /^zir1[0-9a-z]{6,}$/.test(a) && a !== m1.address && !s.isGenesisMaster(a))
    .sort()
    .slice(0, 64);
  assert.equal(payees.length, new Set([...setA, ...setB]).size, "pipeline keeps the full union");

  const pool = 5_000_000_000;
  const per = Math.floor(pool / payees.length);
  const remainder = pool - per * payees.length;
  const outputs: [string, number][] = payees.map((to, i) => [to, per + (i === 0 ? remainder : 0)]);
  const tx = signTx({
    network: genesis.network, from: m1.address, fromPubKey: m1.publicKey, to: m1.address,
    amountUZIR: pool, feeUZIR: 1000, nonce: s.nonceOf(m1.address), kind: "batch_transfer",
    parents: [], timestamp: now, memo: JSON.stringify({ o: outputs }),
  }, m1.privateKey);
  const r = s.ingestTx(tx);
  assert.equal(r.ok, true, `pipeline batch must ingest (reason: ${r.reason ?? "none"})`);
});
