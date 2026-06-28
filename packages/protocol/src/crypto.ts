// packages/protocol/src/crypto.ts
import { ed25519 } from "@noble/curves/ed25519";
import { sha3_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { bech32m } from "@scure/base";
import { CRYPTO } from "./constants";
import { canonical } from "./serialize";
import type { Address, Hex, PublicKey, Signature, Signed } from "./types";

export interface Keypair { privateKey: Hex; publicKey: PublicKey; address: Address; }

export function generateKeypair(): Keypair {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  return { privateKey: bytesToHex(priv), publicKey: bytesToHex(pub), address: addressFromPubKey(bytesToHex(pub)) };
}
export function keypairFromPrivate(privateKey: Hex): Keypair {
  const pub = ed25519.getPublicKey(hexToBytes(privateKey));
  return { privateKey, publicKey: bytesToHex(pub), address: addressFromPubKey(bytesToHex(pub)) };
}
export function addressFromPubKey(publicKey: PublicKey): Address {
  const full = sha3_256(hexToBytes(publicKey));
  const words = bech32m.toWords(full.slice(0, CRYPTO.ADDRESS_HASH_BYTES));
  return bech32m.encode(CRYPTO.ADDRESS_PREFIX, words);
}
export function isValidAddress(addr: string): boolean {
  try { return bech32m.decode(addr as `${string}1${string}`).prefix === CRYPTO.ADDRESS_PREFIX; }
  catch { return false; }
}
export function hashHex(input: string | Uint8Array): Hex {
  return bytesToHex(sha3_256(typeof input === "string" ? utf8ToBytes(input) : input));
}
export function sign(canonicalBody: string, privateKey: Hex): Signature {
  return bytesToHex(ed25519.sign(utf8ToBytes(canonicalBody), hexToBytes(privateKey)));
}
export function verify(canonicalBody: string, sig: Signature, publicKey: PublicKey): boolean {
  try { return ed25519.verify(hexToBytes(sig), utf8ToBytes(canonicalBody), hexToBytes(publicKey)); }
  catch { return false; }
}

/**
 * Sign a soft-state record with the Signed mixin. Sets `pubKey` from the private key and signs the
 * canonical encoding of the record with the `sig` field omitted. Returns a new, signed record.
 */
export function signRecord<T extends Record<string, unknown>>(record: T, privateKey: Hex): T & Signed {
  const publicKey = bytesToHex(ed25519.getPublicKey(hexToBytes(privateKey)));
  const body = { ...record, pubKey: publicKey, sig: undefined };
  const sig = sign(canonical(body), privateKey);
  return { ...record, pubKey: publicKey, sig };
}

/** Verify a signed record: the signature must cover canonical(record without sig) under pubKey. */
export function verifyRecord<T extends Signed>(record: T): boolean {
  if (!record || typeof record.pubKey !== "string" || typeof record.sig !== "string") return false;
  if (!record.pubKey || !record.sig) return false;
  const body = canonical({ ...record, sig: undefined });
  return verify(body, record.sig, record.pubKey);
}

/** True when the record's pubKey resolves to the given address (ownership check). */
export function recordOwnerMatches(record: Signed, address: Address): boolean {
  try { return addressFromPubKey(record.pubKey) === address; } catch { return false; }
}
