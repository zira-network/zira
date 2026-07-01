// node/src/p2p/topics.ts
// Topics are namespaced by the genesis id, so nodes on different networks never cross talk.
export function topics(genesisId: string) {
  const p = `zira/${genesisId.slice(0, 16)}`;
  return {
    events: `${p}/events`,        // transactions and observations (feed the ledger)
    consensus: `${p}/consensus`,  // checkpoint votes (Proof of Resonance finality)
    app: `${p}/app`,              // resonators, tasks, providers, queries, answers
    all(): string[] { return [this.events, this.consensus, this.app]; },
  };
}
export const SYNC_PROTOCOL = "/zira/sync/1.0.0";
// Fast sync: a joining node adopts a finalized state snapshot from a peer instead of replaying the
// whole history. This is what lets the network scale to a long history and many participants.
export const SNAPSHOT_PROTOCOL = "/zira/snapshot/1.0.0";
// Liveness/coordination proof: a master sends a fresh nonce, the peer returns its ZIR address and a
// signature over the nonce. Answering proves the peer is a real, directly-reachable, participating node,
// which is the baseline "coordination" work — no model download required. Storage serving earns on top.
export const LIVENESS_PROTOCOL = "/zira/live/1.0.0";
