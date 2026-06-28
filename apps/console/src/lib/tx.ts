// apps/web/src/lib/tx.ts
// Build and sign transactions locally with the unlocked wallet. The coordinator only ever
// receives signed objects. Keys never leave the browser.
import {
  buildTxBody, canonical, hashHex, PROTOCOL,
  signRecord, verifyRecord,
  type SignedTx, type TxKind, type NetworkId, type Address, type Signed,
} from "@zira/protocol";
import { Wallet } from "./keys";

export interface MakeTxInput {
  network: NetworkId;
  to: Address;
  amountUZIR: number;
  nonce: number;
  kind?: TxKind;
  feeUZIR?: number;
  memo?: string;
  parents?: string[];
}

/** Build a SignedTx from the currently unlocked wallet. Throws if the wallet is locked. */
export function makeSignedTx(input: MakeTxInput): SignedTx {
  const from = Wallet.unlockedAddress();
  const fromPubKey = Wallet.publicKey();
  if (!from || !fromPubKey) throw new Error("wallet is locked");

  const body = buildTxBody({
    network: input.network,
    from,
    fromPubKey,
    to: input.to,
    amountUZIR: Math.round(input.amountUZIR),
    feeUZIR: input.feeUZIR ?? PROTOCOL.BASE_FEE_UZIR,
    nonce: input.nonce,
    kind: input.kind ?? "transfer",
    parents: input.parents ?? [],
    timestamp: Date.now(),
    ...(input.memo ? { memo: input.memo } : {}),
  });
  const c = canonical(body);
  const id = hashHex(c);
  const sig = Wallet.sign(c);
  return { ...body, id, sig };
}

/**
 * Sign a soft-state record (Resonator, Listing, ProviderProfile, ModelRecommendation, ...) with the
 * unlocked wallet. Sets `pubKey` + `sig` so peers can verify authorship. Throws if the wallet is
 * locked. Keys never leave the browser.
 */
export function makeSignedRecord<T extends Record<string, unknown>>(record: T): T & Signed {
  const priv = Wallet.exportPrivateKey(); // throws "unlock the wallet first" if locked
  return signRecord(record, priv);
}

/** Verify a signed soft-state record came from the holder of its pubKey and was not tampered with. */
export { verifyRecord };

/** ZIR to uZIR integer. */
export function zirToUzir(zir: number): number {
  return Math.round(zir * PROTOCOL.UZIR_PER_ZIR);
}
