// packages/protocol/src/ledger/validate.ts
//
// Validate events and the web of parents, and apply them to ledger state. The rules
// live here so neither the coordinator nor the web app can drift. See Part 3.5.
import { PROTOCOL } from "../constants";
import { hashHex, verify as edVerify } from "../crypto";
import { canonical, buildObservationBody } from "../serialize";
import { feeAndBurn, verifyTx } from "./tx";
import { SupplyTracker } from "./supply";
import type { Address, Lock, SignedEvent, SignedObservation, SignedTx, uZIR } from "../types";

export interface LedgerState {
  balances: Record<Address, uZIR>;
  nonces: Record<Address, number>;
  supply: SupplyTracker;
  knownIds: Set<string>;     // every accepted event id, for parent checks and replay
  founderAddress: Address;
  founderAddresses: Set<Address>;
  log: SignedTx[];           // the signed tx log, for audit
}

export function emptyState(founderAddress: Address, supply?: SupplyTracker): LedgerState {
  return {
    balances: {},
    nonces: {},
    supply: supply ?? new SupplyTracker({ reserve: PROTOCOL.RESERVE_UZIR }),
    knownIds: new Set<string>(),
    founderAddress,
    founderAddresses: new Set([founderAddress]),
    log: [],
  };
}

export interface ValidateResult { ok: boolean; reason?: string; }

function balanceOf(state: LedgerState, addr: Address): uZIR { return state.balances[addr] ?? 0; }
function nonceOf(state: LedgerState, addr: Address): number { return state.nonces[addr] ?? 0; }

/** Validate a single event against current state without mutating it. */
export function validateEvent(ev: SignedEvent, state: LedgerState): ValidateResult {
  if (ev.kind === "tx") return validateTx(ev.data, state);
  if (ev.kind === "observation") return validateObservation(ev.data);
  if (ev.kind === "lock") return validateLock(ev.data);
  return { ok: false, reason: "unknown event kind" };
}

function validateTx(tx: SignedTx, state: LedgerState): ValidateResult {
  const base = verifyTx(tx);
  if (!base.ok) return base;
  if (state.knownIds.has(tx.id)) return { ok: false, reason: "duplicate event id" };

  // nonce must be the sender's next nonce, which blocks replay and reorder
  if (tx.nonce !== nonceOf(state, tx.from)) {
    return { ok: false, reason: `bad nonce, expected ${nonceOf(state, tx.from)}` };
  }
  // parents, if given, must be known events
  for (const p of tx.parents) {
    if (!state.knownIds.has(p)) return { ok: false, reason: `unknown parent ${p}` };
  }

  if (tx.kind === "reserve_grant") {
    if (!state.founderAddresses.has(tx.from)) return { ok: false, reason: "reserve_grant must come from an active founder" };
  }
  if (tx.kind === "founder_delegate") {
    if (!state.founderAddresses.has(tx.from)) return { ok: false, reason: "founder_delegate must come from an active founder" };
    if (!tx.to.startsWith("zir1")) return { ok: false, reason: "delegated founder address is invalid" };
    if (tx.amountUZIR !== 0) return { ok: false, reason: "founder_delegate amount must be zero" };
    return { ok: true };
  }
  if (tx.kind === "founder_revoke") {
    if (!state.founderAddresses.has(tx.from)) return { ok: false, reason: "founder_revoke must come from an active founder" };
    if (!tx.to.startsWith("zir1")) return { ok: false, reason: "revoked founder address is invalid" };
    if (tx.to === state.founderAddress) return { ok: false, reason: "genesis founder cannot be revoked" };
    if (tx.amountUZIR !== 0) return { ok: false, reason: "founder_revoke amount must be zero" };
    return { ok: true };
  }
  if (tx.kind === "reward") {
    // rewards are minted, not debited, but must stay within the earned cap
    if (!state.supply.canEmit(tx.amountUZIR)) return { ok: false, reason: "reward would exceed the earned cap" };
    return { ok: true };
  }

  // every other kind debits the sender for amount + fee
  const need = tx.amountUZIR + tx.feeUZIR;
  if (balanceOf(state, tx.from) < need) return { ok: false, reason: "insufficient balance" };
  return { ok: true };
}

function validateObservation(obs: SignedObservation): ValidateResult {
  // Single source of truth for the signed observation shape (buildObservationBody), so the canonical form
  // here can never drift from where observations are built/ingested — a drift would break id/sig checks.
  const c = canonical(buildObservationBody(obs));
  if (hashHex(c) !== obs.id) return { ok: false, reason: "observation id mismatch" };
  if (!edVerify(c, obs.sig, obs.observer)) return { ok: false, reason: "observation signature invalid" };
  if (obs.confidence < 0 || obs.confidence > 1) return { ok: false, reason: "confidence out of range" };
  return { ok: true };
}

function validateLock(lock: Lock): ValidateResult {
  if (lock.observationCount < PROTOCOL.MIN_OBSERVATIONS) return { ok: false, reason: "too few observations for a lock" };
  if (lock.supportingTrust < PROTOCOL.FINALITY_THRESHOLD) return { ok: false, reason: "supporting trust below finality" };
  if (!(lock.cv < PROTOCOL.CV_THRESHOLD)) return { ok: false, reason: "cv above threshold" };
  return { ok: true };
}

/** Apply an event to a copy of state, returning the new state or an error. */
export function applyEvent(ev: SignedEvent, state: LedgerState): { state: LedgerState; result: ValidateResult } {
  const check = validateEvent(ev, state);
  if (!check.ok) return { state, result: check };
  if (ev.kind !== "tx") {
    // observations and locks do not change balances; record the id
    const next = cloneState(state);
    return { state: next, result: { ok: true } };
  }

  const tx = ev.data;
  const next = cloneState(state);

  if (tx.kind === "reward") {
    next.balances[tx.to] = (next.balances[tx.to] ?? 0) + tx.amountUZIR;
    next.supply.recordEmission(tx.amountUZIR);
  } else if (tx.kind === "founder_delegate") {
    next.founderAddresses.add(tx.to);
    next.nonces[tx.from] = (next.nonces[tx.from] ?? 0) + 1;
  } else if (tx.kind === "founder_revoke") {
    if (tx.to !== next.founderAddress) next.founderAddresses.delete(tx.to);
    next.founderAddresses.add(next.founderAddress);
    next.nonces[tx.from] = (next.nonces[tx.from] ?? 0) + 1;
  } else {
    const { burned } = feeAndBurn(tx.feeUZIR);
    next.balances[tx.from] = (next.balances[tx.from] ?? 0) - (tx.amountUZIR + tx.feeUZIR);
    if (tx.kind === "bond_burn") {
      next.supply.recordBurn(tx.amountUZIR);
    } else {
      next.balances[tx.to] = (next.balances[tx.to] ?? 0) + tx.amountUZIR;
    }
    next.supply.recordBurn(burned);
    if (tx.kind === "reserve_grant" && tx.from === next.founderAddress) {
      next.supply.recordReserveGrant(tx.amountUZIR);
    }
    next.nonces[tx.from] = (next.nonces[tx.from] ?? 0) + 1;
  }

  next.knownIds.add(tx.id);
  next.log.push(tx);
  return { state: next, result: { ok: true } };
}

function cloneState(state: LedgerState): LedgerState {
  return {
    balances: { ...state.balances },
    nonces: { ...state.nonces },
    supply: new SupplyTracker({ emitted: state.supply.emitted, burned: state.supply.burned, reserve: state.supply.reserve }),
    knownIds: new Set(state.knownIds),
    founderAddress: state.founderAddress,
    founderAddresses: new Set(state.founderAddresses),
    log: [...state.log],
  };
}
