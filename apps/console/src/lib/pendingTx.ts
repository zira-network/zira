// Optimistic pending transactions. A transfer the node has ACCEPTED does not become visible in the wallet
// history until it clears the deterministic settle window (SETTLE_ROUNDS + grace, ~45-90s) and its epoch
// finalizes. Without a local marker that gap reads as "nothing happened / it is stuck". We keep the accepted
// tx here and render it as a "confirming" row until the fetched history contains its id, so the wait is
// communicated honestly instead of looking lost. Nothing here touches consensus: it is a purely local,
// display-only echo of a tx the node already accepted, and it self-clears the moment the ledger shows it.
import { useSyncExternalStore } from "react";
import type { SignedTx } from "@zira/protocol";

export type PendingTx = SignedTx & { submittedAt: number };

const KEY = "zira.pendingTx";
// Safety net: drop a pending echo after this long even if history never shows it (e.g. it was dropped for a
// nonce gap, or the user switched wallets). The settle+finality path is well under this on a healthy network.
const MAX_AGE_MS = 5 * 60_000;
const MAX_KEEP = 20;

const subs = new Set<() => void>();
let pend: PendingTx[] = load();

function load(): PendingTx[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]") as PendingTx[];
    return Array.isArray(raw) ? raw.filter((p) => p && typeof p.submittedAt === "number" && Date.now() - p.submittedAt < MAX_AGE_MS) : [];
  } catch { return []; }
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(pend)); } catch { /* storage full/blocked; in-memory still works */ } }
function emit() { for (const s of subs) s(); }

/** Record an accepted transfer so it shows as "confirming" until the ledger reflects it. */
export function addPending(tx: SignedTx) {
  pend = [{ ...tx, submittedAt: Date.now() }, ...pend.filter((p) => p.id !== tx.id)].slice(0, MAX_KEEP);
  save(); emit();
}

/** Remove echoes now present in the fetched history (by id) or older than the safety-net age. Idempotent. */
export function reconcilePending(confirmedIds: Set<string>) {
  const now = Date.now();
  const next = pend.filter((p) => !confirmedIds.has(p.id) && now - p.submittedAt < MAX_AGE_MS);
  if (next.length !== pend.length) { pend = next; save(); emit(); }
}

function subscribe(cb: () => void) { subs.add(cb); return () => { subs.delete(cb); }; }
function snapshot() { return pend; }

/** Live list of still-pending echoes. Stable reference between changes, so it is safe for render. */
export function usePendingTx(): PendingTx[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
