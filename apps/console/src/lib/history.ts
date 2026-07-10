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
  let txs = await client.getTxHistory(address, limit);
  if (txs.length === 0 || nodeBehind) {
    for (const gateway of PUBLIC_GATEWAYS) {
      try {
        const gw = await new NodeClient(gateway, false).getTxHistory(address, limit);
        // Prefer whichever view returns more rows so a good local answer is never replaced by a briefly
        // empty gateway one, and a lagging node's partial window is topped up by the fuller network view.
        if (gw.length > txs.length) { txs = gw; break; }
      } catch { /* gateway briefly unreachable: try the next */ }
    }
  }
  return txs;
}
