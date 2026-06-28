// node/test/mining-earns.test.ts
// CRITICAL: a node that contributes accepted coordination work must actually EARN ZIR. Previously
// publishAnswer only added a soft-state answer and nobody paid, so a miner's balance never grew. Now the
// funding (founder/steward) wallet settles a real coordination payout to the providers whose accepted
// answers converged a query: balances grow from coordination + Proof of Resonance, split by domain
// ZTI x confidence after the small steward-ops share, drawn from already-allocated ZIR (no minting).
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  keypairFromPrivate, generateKeypair, signTx, buildTxBody, sign as edSign, standardGenesis, PROTOCOL,
} from "@zira/protocol";
import { ZiraNode } from "../src/core/ZiraNode.js";
import { EPOCH_MS, epochOf, GRACE_MS, SETTLE_ROUNDS } from "../src/core/State.js";
import type { ZiraNetwork } from "../src/p2p/Network.js";
import type { QueryMsg, AnswerMsg } from "../src/core/types.js";

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
function at(epoch: number): number { return (epoch + SETTLE_ROUNDS + 1) * EPOCH_MS + GRACE_MS + 1; }
function advancePast(node: ZiraNode, ts: number): void { node.state.advance(at(epochOf(ts) + 1)); }

// A founder node (its identity IS the genesis founder, so it funds coordination), with founder-ops balance.
function buildFounderNode() {
  const genesis = standardGenesis("devnet", founder.address, GTS);
  const dir = join(tmpdir(), `zira-mine-earn-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return new ZiraNode(genesis, founder, fakeNet(), dir, {});
}

function answerFrom(miner: ReturnType<typeof generateKeypair>, query: QueryMsg, text: string, now: number): AnswerMsg {
  return {
    id: miner.address + ":" + query.id,
    queryId: query.id,
    provider: miner.publicKey,
    answer: text,
    confidence: 0.8,
    sig: edSign(query.id + "\n" + text, miner.privateKey),
    ts: now,
  };
}

test("a mining contributor's balance grows after its accepted answer settles a coordinated query", () => {
  const node = buildFounderNode();
  // the founder starts with the full devnet reserve; that funds coordination payouts (no minting)
  const founderBefore = node.state.balanceOf(founder.address);
  assert.ok(founderBefore > 0, "founder holds the funding balance");

  const miner = generateKeypair();
  const miner2 = generateKeypair();
  const balBefore = node.state.balanceOf(miner.address);
  assert.equal(balBefore, 0, "the miner starts with nothing");

  const query: QueryMsg = {
    id: "q-coord-1", domain: "reasoning", question: "coordinate a trustworthy answer", history: [],
    asker: founder.address, postedAt: GTS,
  };
  node.publishQuery(query);
  // two independent miners contribute accepted answers (>= 24 chars, confidence >= 0.4, not fallback)
  node.publishAnswer(answerFrom(miner, query, "A careful, well-reasoned answer that converges with peers.", GTS + 10));
  node.publishAnswer(answerFrom(miner2, query, "An independent answer reaching the same considered conclusion.", GTS + 20));

  // the founder funding wallet settles a real coordination payout (the money path)
  const budget = 2_000_000; // 2 ZIR
  const result = node.settleQueryCoordination(query.id, budget);
  assert.equal(result.ok, true, result.reason);
  assert.ok((result.payouts?.length ?? 0) >= 2, "both contributors are paid");

  // settle the epoch so the payout transfers apply to the ledger. The payout txs are stamped at the
  // real wall clock (Date.now), so advance the chain past now for them to be processed.
  advancePast(node, Date.now());

  const balAfter = node.state.balanceOf(miner.address);
  const bal2After = node.state.balanceOf(miner2.address);
  console.log("miner balance before/after:", balBefore, balAfter, "| miner2 after:", bal2After);
  assert.ok(balAfter > balBefore, "the mining contributor EARNED ZIR from coordination");
  assert.ok(bal2After > 0, "the second contributor also earned");
  // payouts + steward-ops sum to the funded budget (no minting): founder spent exactly budget + fees
  const paidSum = (result.payouts ?? []).reduce((s, p) => s + p.amountUZIR, 0);
  assert.ok(paidSum > 0 && paidSum <= budget, "payouts are funded from the budget, never minted");
  // supply emitted is unchanged by coordination settlement (it is a transfer, not a reward)
  assert.equal(node.state.supply.emitted, 0, "coordination mints no new ZIR");
});

test("higher domain ZTI x confidence earns a larger coordination share", () => {
  const node = buildFounderNode();
  const strong = generateKeypair();
  const weak = generateKeypair();
  // give `strong` domain trust so it should out-earn `weak` on the same query
  const sa = node.state.accounts.get(strong.address) ?? (node.state.accounts.set(strong.address, { address: strong.address, pubkey: strong.publicKey, balance: 0, nonce: 0, zti: 0.9, ztiByDomain: { reasoning: 0.9 }, accuracy: 0, consistency: 1, uptime: 0, isMaster: false }), node.state.accounts.get(strong.address)!);
  void sa;
  const query: QueryMsg = { id: "q-weighted", domain: "reasoning", question: "weighted coordination", history: [], asker: founder.address, postedAt: GTS };
  node.publishQuery(query);
  node.publishAnswer(answerFrom(strong, query, "A high-trust, well-reasoned converging contribution.", GTS + 5));
  node.publishAnswer(answerFrom(weak, query, "A lower-trust but still aligned contribution here.", GTS + 6));

  const r = node.settleQueryCoordination(query.id, 2_000_000);
  assert.equal(r.ok, true, r.reason);
  advancePast(node, Date.now());
  const strongEarned = node.state.balanceOf(strong.address);
  const weakEarned = node.state.balanceOf(weak.address);
  console.log("strong earned:", strongEarned, "weak earned:", weakEarned);
  assert.ok(strongEarned > weakEarned, "the higher domain-ZTI contributor earns more");
  assert.ok(weakEarned > 0, "the lower-trust contributor still earns a share");
});
