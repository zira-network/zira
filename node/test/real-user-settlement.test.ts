// node/test/real-user-settlement.test.ts
// End-to-end proof of PAID real-user answering (Serve-the-Field P2), ARMED via env. A real user funds a
// query-tier charge to the network coordination wallet; the settler reads that charge straight from the
// ledger and pays the miners whose answers converged, via the same single settler-signed batch_transfer as
// autonomous coordination (fork-safe). Asserts: the converged answerers are paid from the charge, and a
// second settle pass never double-pays (idempotent). Uses the synchronous single-settler harness (no p2p).
//
// Armed here ONLY (process env), so this proves the money path works when turned on WITHOUT changing the
// shipped default: on mainnet the feature stays dormant until the activation epoch is set.
process.env.ZIRA_REAL_USER_PAYOUT_EPOCH = "1";
process.env.ZIRA_QUERY_TIER_EPOCH = "1";

import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keypairFromPrivate, generateKeypair, signTx, buildTxBody, sign as edSign, standardGenesis, PROTOCOL } from "@zira/protocol";
import { ZiraNode } from "../src/core/ZiraNode.js";
import { EPOCH_MS, epochOf, GRACE_MS, SETTLE_ROUNDS } from "../src/core/State.js";
import { settlementWalletsFor } from "../src/genesis-docs.js";
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

function buildFounderNode(): ZiraNode {
  const genesis = standardGenesis("devnet", founder.address, GTS);
  const dir = join(tmpdir(), `zira-ru-settle-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return new ZiraNode(genesis, founder, fakeNet(), dir, {});
}
function answerFrom(m: ReturnType<typeof generateKeypair>, q: QueryMsg, text: string, now: number): AnswerMsg {
  return { id: m.address + ":" + q.id, queryId: q.id, provider: m.publicKey, answer: text, confidence: 0.8, sig: edSign(q.id + "\n" + text, m.privateKey), ts: now };
}

// Monotonic clock: each phase is stamped LATER than the last (but all within the 30-min settle window), so
// every tx always lands in the advancing chain's FUTURE. (Advancing the ledger between phases pushes its
// processed epoch forward; a later tx stamped in the past would be orphaned, never applied.)
const MIN = 60_000;

test("a paid real-user query settles to the converged answerers from the on-chain charge, idempotently", () => {
  const node = buildFounderNode();
  assert.equal(node.realUserPayoutActive(), true, "feature is armed via env");
  const networkWallet = settlementWalletsFor("devnet").network;
  const clock = Date.now();

  // Phase 1: fund an asker from the founder reserve (12 min ago on the monotonic clock).
  const asker = generateKeypair();
  const fund = signTx(buildTxBody({
    network: "devnet", from: founder.address, fromPubKey: founder.publicKey, to: asker.address,
    amountUZIR: 50_000_000, feeUZIR: PROTOCOL.BASE_FEE_UZIR, nonce: node.state.provisionalNonce(founder.address),
    kind: "transfer", parents: [], timestamp: clock - 12 * MIN, memo: "fund asker",
  }), founder.privateKey);
  assert.ok(node.submitTx(fund).accepted, "asker funding accepted");
  advancePast(node, clock - 12 * MIN);
  assert.ok(node.state.balanceOf(asker.address) > 0, "asker is funded");

  // Phase 2: the asker signs the query-tier CHARGE to the network coordination wallet, tagged to a `ru-` id
  // (8 min ago), and it commits to the ledger/history the settler reads.
  const queryId = "ru-det-1";
  const chargeAmt = 5_000_000; // 5 ZIR
  const charge = signTx(buildTxBody({
    network: "devnet", from: asker.address, fromPubKey: asker.publicKey, to: networkWallet,
    amountUZIR: chargeAmt, feeUZIR: PROTOCOL.BASE_FEE_UZIR, nonce: node.state.provisionalNonce(asker.address),
    kind: "transfer", parents: [], timestamp: clock - 8 * MIN, memo: ZiraNode.queryChargeMemo(queryId),
  }), asker.privateKey);
  assert.ok(node.submitTx(charge).accepted, "charge accepted");
  advancePast(node, clock - 8 * MIN);
  assert.ok(node.state.balanceOf(networkWallet) >= chargeAmt, "charge credited the network coordination wallet");

  // Phase 3: the query plus two independent, converged, model-backed answers.
  const query: QueryMsg = { id: queryId, domain: "reasoning", question: "a paid, considered question", history: [], asker: asker.address, postedAt: GTS };
  node.publishQuery(query);
  const a1 = generateKeypair(), a2 = generateKeypair();
  node.publishAnswer(answerFrom(a1, query, "A careful, well-reasoned answer that converges with peers.", clock - 6 * MIN));
  node.publishAnswer(answerFrom(a2, query, "An independent answer reaching the same considered conclusion.", clock - 6 * MIN));

  // Phase 4: the settler reads the charge and pays the answerers (>= 2 converged -> full charged budget).
  node.settleRealUserQueriesNow(clock);
  advancePast(node, clock);
  const paidA1 = node.state.balanceOf(a1.address);
  const paidA2 = node.state.balanceOf(a2.address);
  assert.ok(paidA1 > 0 && paidA2 > 0, "both converged answerers were paid from the asker's charge");

  // Idempotent: the same charge must never settle twice, even though it is still on-chain.
  node.settleRealUserQueriesNow(clock);
  advancePast(node, clock);
  assert.equal(node.state.balanceOf(a1.address), paidA1, "no double-pay for a1 on a second settle pass");
  assert.equal(node.state.balanceOf(a2.address), paidA2, "no double-pay for a2 on a second settle pass");
});

test("a charge for a NON-namespaced (autonomous-style) query id is ignored by the real-user settler", () => {
  const node = buildFounderNode();
  const networkWallet = settlementWalletsFor("devnet").network;
  const clock = Date.now();
  const asker = generateKeypair();
  const fund = signTx(buildTxBody({
    network: "devnet", from: founder.address, fromPubKey: founder.publicKey, to: asker.address,
    amountUZIR: 20_000_000, feeUZIR: PROTOCOL.BASE_FEE_UZIR, nonce: node.state.provisionalNonce(founder.address),
    kind: "transfer", parents: [], timestamp: clock - 12 * MIN, memo: "fund asker",
  }), founder.privateKey);
  node.submitTx(fund); advancePast(node, clock - 12 * MIN);

  // A charge crafted for a NON-"ru-" id (as an autonomous hashed id would be) — the settler must ignore it.
  const queryId = "deadbeefcafe0001"; // hex, like an autonomous hashHex id: outside the ru- namespace
  const charge = signTx(buildTxBody({
    network: "devnet", from: asker.address, fromPubKey: asker.publicKey, to: networkWallet,
    amountUZIR: 5_000_000, feeUZIR: PROTOCOL.BASE_FEE_UZIR, nonce: node.state.provisionalNonce(asker.address),
    kind: "transfer", parents: [], timestamp: clock - 8 * MIN, memo: ZiraNode.queryChargeMemo(queryId),
  }), asker.privateKey);
  node.submitTx(charge); advancePast(node, clock - 8 * MIN);
  assert.ok(node.state.balanceOf(networkWallet) >= 5_000_000, "the (out-of-namespace) charge did commit on-chain");

  const query: QueryMsg = { id: queryId, domain: "reasoning", question: "not a real-user query", history: [], asker: asker.address, postedAt: GTS };
  node.publishQuery(query);
  const a1 = generateKeypair();
  node.publishAnswer(answerFrom(a1, query, "A careful, well-reasoned answer that converges with peers.", clock - 6 * MIN));
  node.publishAnswer(answerFrom(generateKeypair(), query, "An independent answer reaching the same considered conclusion.", clock - 6 * MIN));

  node.settleRealUserQueriesNow(clock);
  advancePast(node, clock);
  assert.equal(node.state.balanceOf(a1.address), 0, "an out-of-namespace charge never pays an answerer");
});
