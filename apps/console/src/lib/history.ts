// apps/console/src/lib/history.ts
// Shared wallet/earnings history loader with network reconciliation.
//
// A freshly-synced local node only holds the recent tx window, and a churny home miner can miss a gossiped
// payout, so reading history straight from the local node can look empty or stale even when the address
// earned for weeks on the network. loadReconciledHistory reads the local node first and, when its answer is
// empty OR the store has detected the node is BEHIND the mesh, also reads the public gateways (the shared,
// authoritative network view) and keeps whichever source returns more rows. Read-only: it never signs or
// spends, it only decides what to display.
import type { SignedTx, ZiraClient } from "@zira/protocol";
import { NodeClient, PUBLIC_GATEWAYS } from "../client/NodeClient";

export async function loadReconciledHistory(client: ZiraClient, address: string, limit: number, nodeBehind: boolean): Promise<SignedTx[]> {
  void nodeBehind; // kept for call-site compatibility; we now always consult the network view below
  let txs = await client.getTxHistory(address, limit).catch(() => [] as SignedTx[]);
  // ALWAYS also consult the public gateways, not only when the local answer is empty or the node is flagged
  // behind. Mining income arrives as pooled batch payouts, and a home node's small in-memory window can miss
  // them even when it is otherwise in sync, so a synced-looking node could still show a short or empty
  // earnings list. Prefer whichever source returns more rows so a good local answer is never replaced by a
  // briefly empty gateway one. Read-only: it never signs or spends, it only decides what to display.
  for (const gateway of PUBLIC_GATEWAYS) {
    try {
      const gw = await new NodeClient(gateway, false).getTxHistory(address, limit);
      if (gw.length > txs.length) { txs = gw; break; }
    } catch { /* gateway briefly unreachable: try the next */ }
  }
  return txs;
}
