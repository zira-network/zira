// packages/protocol/src/serialize.ts
//
// One canonical encoding, identical to the PHP side (server/src/Canonical.php).
// A signature made in the browser MUST verify in PHP, so the byte string we sign
// has to be produced the same way on both sides. The rules:
//   - object keys sorted recursively (lexicographic, by code unit)
//   - undefined values dropped (optional fields that were not set)
//   - integers printed as integers, other finite numbers via shortest round-trip
//     (JS JSON.stringify, matched in PHP by json_encode with serialize_precision = -1)
//   - arrays kept in order
//   - strings JSON escaped
//   - no whitespace anywhere
//
// PHP parity note: Canonical.php sorts keys with ksort recursively, drops nulls,
// and encodes scalars with json_encode under serialize_precision = -1, which gives
// the same shortest float representation Node uses.

import type { ObservationBody, TxBody, ObservationType, PublicKey, Hex, Address, TxKind, uZIR } from "./types";
import type { Domain, NetworkId } from "./constants";

function encodeValue(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) throw new Error("canonical: non finite number");
    return JSON.stringify(n); // shortest round trip, matches PHP serialize_precision = -1
  }
  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(encodeValue).join(",") + "]";
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + encodeValue(obj[k])).join(",") + "}";
  }
  throw new Error("canonical: unsupported type " + t);
}

/** Deterministic canonical string for any plain object built from JSON safe values. */
export function canonical(body: unknown): string {
  return encodeValue(body);
}

/** Assemble the exact ObservationBody shape that gets hashed and signed. */
export function buildObservationBody(input: {
  type: ObservationType; observer: PublicKey; timestamp: number;
  subject: string; domain: Domain; value?: number; proofRef?: Hex;
  confidence: number; sourceHashes: Hex[]; storageGiB?: number; vouchedMiners?: string[];
}): ObservationBody {
  const body: ObservationBody = {
    type: input.type,
    observer: input.observer,
    timestamp: input.timestamp,
    subject: input.subject,
    domain: input.domain,
    confidence: input.confidence,
    sourceHashes: input.sourceHashes,
  };
  if (input.value !== undefined) body.value = input.value;
  if (input.proofRef !== undefined) body.proofRef = input.proofRef;
  // Only included when the observer reports storage, so observations without it hash exactly as before.
  if (input.storageGiB !== undefined) body.storageGiB = input.storageGiB;
  // Storage vouches: deduped, sorted, bounded so the canonical form is deterministic across nodes. Absent
  // when empty => identical hash to before.
  if (input.vouchedMiners && input.vouchedMiners.length > 0) {
    body.vouchedMiners = [...new Set(input.vouchedMiners)].filter((a) => /^zir1[0-9a-z]{6,}$/.test(a)).sort().slice(0, 64);
  }
  return body;
}

/** Assemble the exact TxBody shape that gets hashed and signed. */
export function buildTxBody(input: {
  network: NetworkId; from: Address; fromPubKey: PublicKey; to: Address;
  amountUZIR: uZIR; feeUZIR: uZIR; nonce: number; kind: TxKind;
  memo?: string; parents: Hex[]; timestamp: number;
}): TxBody {
  const body: TxBody = {
    network: input.network,
    from: input.from,
    fromPubKey: input.fromPubKey,
    to: input.to,
    amountUZIR: input.amountUZIR,
    feeUZIR: input.feeUZIR,
    nonce: input.nonce,
    kind: input.kind,
    parents: input.parents,
    timestamp: input.timestamp,
  };
  if (input.memo !== undefined) body.memo = input.memo;
  return body;
}
