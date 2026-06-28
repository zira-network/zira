import { describe, it, expect } from "vitest";
import { generateKeypair, keypairFromPrivate } from "../src/crypto";
import { buildTxBody } from "../src/serialize";
import { signTx, verifyTx, feeAndBurn } from "../src/ledger/tx";
import { SupplyTracker, auditSupply } from "../src/ledger/supply";
import { emptyState, applyEvent, type LedgerState } from "../src/ledger/validate";
import { PROTOCOL } from "../src/constants";
import type { SignedTx } from "../src/types";

const founder = keypairFromPrivate("02".repeat(32));
const alice = keypairFromPrivate("03".repeat(32));
const bob = keypairFromPrivate("04".repeat(32));

function mkTx(from = alice, to = bob, amount = 1000, nonce = 0, kind: SignedTx["kind"] = "transfer", fee = PROTOCOL.BASE_FEE_UZIR): SignedTx {
  return signTx(buildTxBody({
    network: "devnet", from: from.address, fromPubKey: from.publicKey, to: to.address,
    amountUZIR: amount, feeUZIR: fee, nonce, kind, parents: [], timestamp: 1700000000000,
  }), from.privateKey);
}

function seeded(): LedgerState {
  let state = emptyState(founder.address, new SupplyTracker({ reserve: PROTOCOL.RESERVE_UZIR }));
  // hand seed alice with some balance via a reward (minted)
  const reward = signTx(buildTxBody({
    network: "devnet", from: alice.address, fromPubKey: alice.publicKey, to: alice.address,
    amountUZIR: 1_000_000, feeUZIR: 0, nonce: 0, kind: "reward", parents: [], timestamp: 1,
  }), alice.privateKey);
  const r = applyEvent({ kind: "tx", data: reward }, state);
  expect(r.result.ok).toBe(true);
  return r.state;
}

describe("transactions", () => {
  it("a valid transfer verifies and debits with fee and burn, credits, bumps nonce", () => {
    let state = seeded();
    const tx = mkTx();
    expect(verifyTx(tx).ok).toBe(true);
    const { state: next, result } = applyEvent({ kind: "tx", data: tx }, state);
    expect(result.ok).toBe(true);
    const { burned } = feeAndBurn(PROTOCOL.BASE_FEE_UZIR);
    expect(next.balances[alice.address]).toBe(1_000_000 - 1000 - PROTOCOL.BASE_FEE_UZIR);
    expect(next.balances[bob.address]).toBe(1000);
    expect(next.nonces[alice.address]).toBe(1);
    expect(next.supply.burned).toBe(burned);
  });

  it("a replay (same nonce) is rejected", () => {
    let state = seeded();
    const tx = mkTx();
    const after = applyEvent({ kind: "tx", data: tx }, state).state;
    const replay = applyEvent({ kind: "tx", data: tx }, after);
    expect(replay.result.ok).toBe(false);
  });

  it("overspending is rejected", () => {
    let state = seeded();
    const tx = mkTx(alice, bob, 5_000_000, 0);
    const res = applyEvent({ kind: "tx", data: tx }, state);
    expect(res.result.ok).toBe(false);
    expect(res.result.reason).toMatch(/insufficient/);
  });

  it("a forged signature is rejected", () => {
    const tx = mkTx();
    const forged = { ...tx, sig: "00".repeat(64) };
    expect(verifyTx(forged).ok).toBe(false);
  });

  it("a transfer below base fee is rejected", () => {
    const tx = mkTx(alice, bob, 1000, 0, "transfer", 10);
    expect(verifyTx(tx).ok).toBe(false);
  });
});

describe("supply", () => {
  it("emission cannot exceed the earned cap", () => {
    const s = new SupplyTracker();
    const cap = Math.round(PROTOCOL.MAX_SUPPLY_UZIR * PROTOCOL.EARNED_SHARE);
    expect(s.canEmit(cap)).toBe(true);
    // Note: total supply in uZIR (~2.87e16) exceeds Number.MAX_SAFE_INTEGER, so we
    // test the boundary with a representable delta (1 ZIR). PHP uses exact BIGINT.
    s.recordEmission(cap - PROTOCOL.UZIR_PER_ZIR); // emit all but 1 ZIR
    expect(s.canEmit(PROTOCOL.UZIR_PER_ZIR)).toBe(true);       // exactly fills the cap
    expect(s.canEmit(2 * PROTOCOL.UZIR_PER_ZIR)).toBe(false);  // 1 ZIR over the cap
    expect(() => s.recordEmission(2 * PROTOCOL.UZIR_PER_ZIR)).toThrow();
  });

  it("a reserve_grant from a non founder address is rejected", () => {
    let state = seeded();
    // alice was credited via a reward (which does not bump nonce), so her nonce is 0
    const grant = mkTx(alice, bob, 1000, 0, "reserve_grant");
    const res = applyEvent({ kind: "tx", data: grant }, state);
    expect(res.result.ok).toBe(false);
    expect(res.result.reason).toMatch(/founder/);
  });

  it("an active founder can revoke a delegated founder but not the genesis founder", () => {
    let state = seeded();
    const delegate = mkTx(founder, alice, 0, 0, "founder_delegate", 0);
    const delegated = applyEvent({ kind: "tx", data: delegate }, state);
    expect(delegated.result.ok).toBe(true);
    expect(delegated.state.founderAddresses.has(alice.address)).toBe(true);

    const revoke = mkTx(founder, alice, 0, 1, "founder_revoke", 0);
    const revoked = applyEvent({ kind: "tx", data: revoke }, delegated.state);
    expect(revoked.result.ok).toBe(true);
    expect(revoked.state.founderAddresses.has(alice.address)).toBe(false);
    expect(revoked.state.founderAddresses.has(founder.address)).toBe(true);

    const revokeGenesis = mkTx(founder, founder, 0, 2, "founder_revoke", 0);
    const rejected = applyEvent({ kind: "tx", data: revokeGenesis }, revoked.state);
    expect(rejected.result.ok).toBe(false);
    expect(rejected.result.reason).toMatch(/genesis founder/);
  });

  it("auditSupply reproduces balances and totals", () => {
    let state = seeded();
    const tx = mkTx();
    state = applyEvent({ kind: "tx", data: tx }, state).state;
    const audit = auditSupply(state.log, founder.address);
    expect(audit.balances[bob.address]).toBe(1000);
    expect(audit.balances[alice.address]).toBe(1_000_000 - 1000 - PROTOCOL.BASE_FEE_UZIR);
    expect(audit.emitted).toBe(1_000_000);
    expect(audit.withinCap).toBe(true);
    // burned matches the supply tracker
    expect(audit.burned).toBe(state.supply.burned);
  });
});
