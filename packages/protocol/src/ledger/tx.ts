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
  if ((tx.kind === "transfer" || tx.kind === "agent_spend" || tx.kind === "batch_transfer" || tx.kind === "pool_payout") && tx.feeUZIR < PROTOCOL.BASE_FEE_UZIR) {
    return { ok: false, reason: "fee below the base fee" };
  }
  return { ok: true };
}

// Parse a batch_transfer's recipient list from its memo: {"o":[["zir1...",amountUZIR],...]}. Pure and total
// (returns null on anything malformed), so every node derives the identical output set from the signed memo.
// Bounded to 256 outputs; amounts must be positive whole uZIR and addresses well-formed. Shared by the ledger
// apply path (State), the supply audit, and validation so all three agree on where a batch's ZIR went.
export function parseBatchOutputs(memo: string | undefined): [string, number][] | null {
  let p: unknown;
  try { p = JSON.parse(memo ?? ""); } catch { return null; }
  const arr = (p as { o?: unknown } | null)?.o;
  if (!Array.isArray(arr) || arr.length === 0 || arr.length > 256) return null;
  const out: [string, number][] = [];
  for (const item of arr) {
    if (!Array.isArray(item) || item.length !== 2) return null;
    const to = item[0], amt = item[1];
    if (typeof to !== "string" || !/^zir1[0-9a-z]{6,}$/.test(to)) return null;
    if (typeof amt !== "number" || !Number.isInteger(amt) || amt <= 0) return null;
    out.push([to, amt]);
  }
  return out;
}

// Parse a pool_payout memo: {"b":<bucket>,"o":[["zir1...",amount],...]}. Same output rules as
// parseBatchOutputs plus a non-negative integer bucket id (the idempotency key). Pure and total, so every
// node derives the identical (bucket, outputs) from the signed memo.
export function parsePoolPayout(memo: string | undefined): { bucket: number; outputs: [string, number][] } | null {
  let p: unknown;
  try { p = JSON.parse(memo ?? ""); } catch { return null; }
  const obj = p as { b?: unknown; o?: unknown } | null;
  const bucket = obj?.b;
  if (typeof bucket !== "number" || !Number.isInteger(bucket) || bucket < 0) return null;
  const outputs = parseBatchOutputs(JSON.stringify({ o: obj?.o }));
  if (!outputs) return null;
  return { bucket, outputs };
}

/** Split a fee into the burned portion and the kept portion. With FEE_BURN = 1.0 the whole fee is
 *  burned (kept = 0); the field is retained for a future treasury split. */
export function feeAndBurn(feeUZIR: uZIR): { fee: uZIR; burned: uZIR; kept: uZIR } {
  const burned = Math.floor(feeUZIR * PROTOCOL.FEE_BURN);
  return { fee: feeUZIR, burned, kept: feeUZIR - burned };
}
