// packages/protocol/test/validator-registry.test.ts
// Decentralization cutover, Phase 0+1 fork-safety proof. The validator registry ships INERT: while the
// registry is empty (dormant, DECENTRALIZATION_ACTIVATION_EPOCH = 0) the state root must be BYTE-IDENTICAL
// to the pre-registry root, so a mixed old/new network never forks. When non-empty (post-activation) the
// registry leaf must be deterministic (dedup + sort) so every node with the same membership computes the
// same root. These are the guarantees that let the feature deploy to a live, permanent chain.
import { describe, it, expect } from "vitest";
import { computeStateRoot, decentralizationActive, type AccountLeaf, type SupplyState } from "../src/index";
import { PROTOCOL } from "../src/constants";
import type { Address, Anchor } from "../src/types";

const accounts: AccountLeaf[] = [
  { address: "zir1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", balance: 1000, nonce: 2 },
  { address: "zir1bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", balance: 5, nonce: 0 },
];
const supply: SupplyState = { emitted: 12345, burned: 67, reserve: 999 };
const founders: Address[] = ["zir1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"];
const anchors: Anchor[] = [];

describe("validator registry root-neutrality (dormant)", () => {
  it("empty registry hashes byte-identically to the legacy 4-arg root", () => {
    const legacy = computeStateRoot(accounts, supply, founders, anchors);          // pre-registry call shape
    const withEmpty = computeStateRoot(accounts, supply, founders, anchors, []);    // new 5-arg, empty registry
    expect(withEmpty).toBe(legacy);
  });

  it("the default (no validators arg) also matches the legacy root", () => {
    expect(computeStateRoot(accounts, supply)).toBe(computeStateRoot(accounts, supply, [], [], []));
  });
});

describe("validator registry determinism (active)", () => {
  const A = "zir1validator0000000000000000000000000000a";
  const B = "zir1validator0000000000000000000000000000b";
  const C = "zir1validator0000000000000000000000000000c";

  it("a non-empty registry changes the root (so it is actually committed)", () => {
    const base = computeStateRoot(accounts, supply, founders, anchors, []);
    const withVals = computeStateRoot(accounts, supply, founders, anchors, [A, B]);
    expect(withVals).not.toBe(base);
  });

  it("registry order and duplicates do not affect the root (dedup + sort)", () => {
    const r1 = computeStateRoot(accounts, supply, founders, anchors, [A, B, C]);
    const r2 = computeStateRoot(accounts, supply, founders, anchors, [C, A, B, A]);   // shuffled + dup
    expect(r2).toBe(r1);
  });

  it("two nodes with the same membership compute the same root", () => {
    const node1 = computeStateRoot([...accounts], { ...supply }, [...founders], [], [B, A]);
    const node2 = computeStateRoot([...accounts], { ...supply }, [...founders], [], [A, B]);
    expect(node2).toBe(node1);
  });
});

describe("decentralizationActive gate", () => {
  it("is disabled for all epochs when the activation epoch is 0", () => {
    expect(decentralizationActive(0, 0)).toBe(false);
    expect(decentralizationActive(1_000_000_000, 0)).toBe(false);
  });

  it("activates exactly at/after the activation epoch", () => {
    expect(decentralizationActive(99, 100)).toBe(false);
    expect(decentralizationActive(100, 100)).toBe(true);
    expect(decentralizationActive(101, 100)).toBe(true);
  });

  it("ships dormant: the compiled default activation epoch is 0 (disabled)", () => {
    expect(PROTOCOL.DECENTRALIZATION_ACTIVATION_EPOCH).toBe(0);
    expect(decentralizationActive(2_000_000_000)).toBe(false);   // uses the compiled default
  });
});
