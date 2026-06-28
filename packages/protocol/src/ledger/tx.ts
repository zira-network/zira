// packages/protocol/src/ledger/tx.ts
//
// Build, sign, and verify transactions. This makes ZIR real and auditable: every
// transfer is signed by the sender and verifiable by anyone. See Part 3.5.
import { PROTOCOL } from "../constants";
import { addressFromPubKey, hashHex, sign as edSign, verify as edVerify } from "../crypto";
import { buildTxBody, canonical } from "../serialize";
import type { Hex, SignedTx, TxBody, uZIR } from "../types";

/** Compute the canonical body and the sha3 id for a transaction body. */
export function buildTx(body: TxBody): { body: TxBody; canonical: string; id: Hex } {
  const normalized = buildTxBody(body);
  const c = canonical(normalized);
  return { body: normalized, canonical: c, id: hashHex(c) };
}

/** Sign a tx body with a private key, returning a SignedTx. */
export function signTx(body: TxBody, privateKey: Hex): SignedTx {
  const built = buildTx(body);
  const sig = edSign(built.canonical, privateKey);
  return { ...built.body, id: built.id, sig };
}

export interface TxCheck { ok: boolean; reason?: string; }

/**
 * Verify a SignedTx fully:
 *  - integer, non negative amount and fee
 *  - the id recomputes from the canonical body
 *  - the signature verifies against fromPubKey
 *  - addressFromPubKey(fromPubKey) equals from
 *  - fee >= BASE_FEE_UZIR for ordinary transfers
 */
export function verifyTx(tx: SignedTx): TxCheck {
  if (!Number.isInteger(tx.amountUZIR) || tx.amountUZIR < 0) return { ok: false, reason: "amount must be a non negative integer" };
  if (!Number.isInteger(tx.feeUZIR) || tx.feeUZIR < 0) return { ok: false, reason: "fee must be a non negative integer" };
  if (!Number.isInteger(tx.nonce) || tx.nonce < 0) return { ok: false, reason: "nonce must be a non negative integer" };

  const body: TxBody = {
    network: tx.network, from: tx.from, fromPubKey: tx.fromPubKey, to: tx.to,
    amountUZIR: tx.amountUZIR, feeUZIR: tx.feeUZIR, nonce: tx.nonce, kind: tx.kind,
    parents: tx.parents, timestamp: tx.timestamp,
    ...(tx.memo !== undefined ? { memo: tx.memo } : {}),
  };
  const built = buildTx(body);
  if (built.id !== tx.id) return { ok: false, reason: "id does not match canonical body" };
  if (addressFromPubKey(tx.fromPubKey) !== tx.from) return { ok: false, reason: "from address does not derive from fromPubKey" };
  if (!edVerify(built.canonical, tx.sig, tx.fromPubKey)) return { ok: false, reason: "signature does not verify" };

  // Value-moving kinds that credit a recipient must pay at least the base fee, so there is no free transfer
  // channel and every payment burns into the supply accounting. transfer and agent_spend both credit `to`;
  // all legitimate agent_spend callers (coordination payouts, resonator hires, query coordination) already
  // pay BASE_FEE, so this only closes the free-payment hole (e.g. a forged zero-fee "coordination payout").
  if ((tx.kind === "transfer" || tx.kind === "agent_spend") && tx.feeUZIR < PROTOCOL.BASE_FEE_UZIR) {
    return { ok: false, reason: "fee below the base fee" };
  }
  return { ok: true };
}

/** Split a fee into the burned portion and the kept portion. With FEE_BURN = 1.0 the whole fee is
 *  burned (kept = 0); the field is retained for a future treasury split. */
export function feeAndBurn(feeUZIR: uZIR): { fee: uZIR; burned: uZIR; kept: uZIR } {
  const burned = Math.floor(feeUZIR * PROTOCOL.FEE_BURN);
  return { fee: feeUZIR, burned, kept: feeUZIR - burned };
}
