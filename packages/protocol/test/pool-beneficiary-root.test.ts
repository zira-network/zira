// packages/protocol/test/pool-beneficiary-root.test.ts
// Fork-safety proof for pooled payouts (set_beneficiary). The beneficiary map is folded into the state root,
// so it MUST be byte-identical to the pre-feature root while empty (dormant), and deterministic (sorted,
// order-independent) when populated. This is what lets the feature ship dormant on every node and activate
// only at a shared epoch without forking.
import { describe, it, expect } from "vitest";
import { computeStateRoot, type AccountLeaf, type SupplyState } from "../src/index";

const accounts: AccountLeaf[] = [
  { address: "zir1miner1", balance: 100, nonce: 3 },
  { address: "zir1miner2", balance: 250, nonce: 7 },
  { address: "zir1pool", balance: 0, nonce: 0 },
];
const supply: SupplyState = { emitted: 1000, burned: 5, reserve: 42 };

describe("pooled-payout beneficiary root (fork safety)", () => {
  it("is byte-identical to the pre-feature root while the map is empty (dormant)", () => {
    // The 6-arg call is exactly what a pre-beneficiary node computes. Adding an empty beneficiary map must
    // not change the hash, so a dormant 3.1.1 node and a 3.1.0 node agree on every root.
    const preFeature = computeStateRoot(accounts, supply, [], [], [], 0);
    const emptyMap = computeStateRoot(accounts, supply, [], [], [], 0, []);
    expect(emptyMap).toBe(preFeature);
  });

  it("changes the root once a beneficiary is set, and is stable + order-independent", () => {
    const base = computeStateRoot(accounts, supply, [], [], [], 0, []);
    const withOne = computeStateRoot(accounts, supply, [], [], [], 0, [["zir1miner1", "zir1pool"]]);
    expect(withOne).not.toBe(base);

    // Two nodes that recorded the same map in different insertion orders must compute the SAME root
    // (computeStateRoot sorts internally), or finality would fork on map ordering.
    const a = computeStateRoot(accounts, supply, [], [], [], 0, [["zir1miner1", "zir1pool"], ["zir1miner2", "zir1pool"]]);
    const b = computeStateRoot(accounts, supply, [], [], [], 0, [["zir1miner2", "zir1pool"], ["zir1miner1", "zir1pool"]]);
    expect(a).toBe(b);
  });

  it("distinguishes different beneficiary targets (the routing is committed, not cosmetic)", () => {
    const toPoolA = computeStateRoot(accounts, supply, [], [], [], 0, [["zir1miner1", "zir1poolA"]]);
    const toPoolB = computeStateRoot(accounts, supply, [], [], [], 0, [["zir1miner1", "zir1poolB"]]);
    expect(toPoolA).not.toBe(toPoolB);
  });
});
