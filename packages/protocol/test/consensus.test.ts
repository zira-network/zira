import { describe, it, expect } from "vitest";
import { keypairFromPrivate, sign } from "../src/crypto";
import { canonical } from "../src/serialize";
import { standardGenesis, genesisId, applyGenesis } from "../src/genesis";
import {
  computeStateRoot, checkpointId, verifyCheckpointVote, tryFinalize,
  type CheckpointBody, type SignedCheckpointVote,
} from "../src/consensus";
import { PROTOCOL } from "../src/constants";
import { ANCHOR_CLASSES, TOTAL_ANCHOR_SEATS } from "../src/constants";

const founder = keypairFromPrivate("0a".repeat(32));

describe("genesis", () => {
  it("genesisId is deterministic and applyGenesis seeds the reserve", () => {
    const doc = standardGenesis("mainnet", founder.address, 1_700_000_000_000);
    expect(genesisId(doc)).toBe(genesisId(standardGenesis("mainnet", founder.address, 1_700_000_000_000)));
    const state = applyGenesis(doc);
    expect(state.balances[founder.address]).toBe(PROTOCOL.RESERVE_UZIR);
    expect(state.supply.reserve).toBe(PROTOCOL.RESERVE_UZIR);
    expect(state.supply.emitted).toBe(0);
  });
  it("a different founder yields a different network id", () => {
    const a = genesisId(standardGenesis("mainnet", founder.address, 1));
    const b = genesisId(standardGenesis("mainnet", "zir1other", 1));
    expect(a).not.toBe(b);
  });
  it("publishes 512 anchor code hashes and seeds all 512 positions to the steward at genesis", () => {
    const doc = standardGenesis("mainnet", founder.address, 1_700_000_000_000);
    expect(Object.values(ANCHOR_CLASSES).reduce((sum, c) => sum + c.seats, 0)).toBe(TOTAL_ANCHOR_SEATS);
    expect(doc.anchors).toHaveLength(512);
    // Refined model: the steward anchor-reserve wallet owns ALL 512 positions at genesis.
    expect(doc.anchorOwnership).toHaveLength(512);
    expect(doc.anchorOwnership!.filter((o) => o.seatId.startsWith("A-"))).toHaveLength(16);
    expect(doc.anchorOwnership!.filter((o) => o.seatId.startsWith("F-"))).toHaveLength(144);
    expect(new Set(doc.anchorOwnership!.map((o) => o.owner)).size).toBe(1);
    expect(doc.anchors!.every((a) => /^[0-9a-f]{64}$/i.test(a.codeHash))).toBe(true);
  });
});

describe("state root", () => {
  it("is order independent and ignores empty accounts", () => {
    const r1 = computeStateRoot([
      { address: "zir1a", balance: 10, nonce: 1 },
      { address: "zir1b", balance: 20, nonce: 2 },
      { address: "zir1c", balance: 0, nonce: 0 },
    ], { emitted: 5, burned: 1, reserve: 100 });
    const r2 = computeStateRoot([
      { address: "zir1b", balance: 20, nonce: 2 },
      { address: "zir1a", balance: 10, nonce: 1 },
    ], { emitted: 5, burned: 1, reserve: 100 });
    expect(r1).toBe(r2);
  });
  it("changes when a balance changes", () => {
    const base = computeStateRoot([{ address: "zir1a", balance: 10, nonce: 1 }], { emitted: 0, burned: 0, reserve: 0 });
    const moved = computeStateRoot([{ address: "zir1a", balance: 11, nonce: 1 }], { emitted: 0, burned: 0, reserve: 0 });
    expect(base).not.toBe(moved);
  });
  it("changes when anchor ownership changes", () => {
    const anchor = {
      id: "A-001", ring: "inner" as const, classCode: "A" as const, className: "Genesis", seatIndex: 1,
      codeHash: "00".repeat(32), zirReserveUZIR: 0, vestedUZIR: 0, zti: 0, routingWeight: 2, status: "unclaimed" as const,
    };
    const base = computeStateRoot([], { emitted: 0, burned: 0, reserve: 0 }, [], [anchor]);
    const owned = computeStateRoot([], { emitted: 0, burned: 0, reserve: 0 }, [], [{ ...anchor, owner: founder.address, status: "owned" as const }]);
    expect(base).not.toBe(owned);
  });
});

function makeVote(kp: ReturnType<typeof keypairFromPrivate>, zti: number, root: string, epoch = 1): SignedCheckpointVote {
  const body: CheckpointBody = {
    network: "mainnet", epoch, stateRoot: root, prevRoot: "00",
    emitted: 0, burned: 0, reserve: PROTOCOL.RESERVE_UZIR, timestamp: 1,
  };
  const c = canonical(body as unknown as Record<string, unknown>);
  const id = checkpointId(body);
  return { ...body, id, voter: kp.publicKey, voterZti: zti, sig: sign(c, kp.privateKey) };
}

describe("checkpoint finality", () => {
  const m1 = keypairFromPrivate("0b".repeat(32));
  const m2 = keypairFromPrivate("0c".repeat(32));
  const m3 = keypairFromPrivate("0d".repeat(32));

  it("verifies a well formed vote and rejects a tampered one", () => {
    const v = makeVote(m1, 0.9, "rootA");
    expect(verifyCheckpointVote(v)).toBe(true);
    expect(verifyCheckpointVote({ ...v, stateRoot: "rootB" })).toBe(false);
  });

  it("finalizes when supporting master trust reaches 0.67", () => {
    const votes = [makeVote(m1, 0.8, "rootA"), makeVote(m2, 0.8, "rootA")];
    const totalTrust = 0.8 + 0.8 + 0.7; // a third master (0.7) is silent: 1.6/2.3 = 0.70
    const fin = tryFinalize(votes, totalTrust);
    expect(fin).not.toBeNull();
    expect(fin!.stateRoot).toBe("rootA");
    expect(fin!.supportingTrust).toBeGreaterThanOrEqual(PROTOCOL.FINALITY_THRESHOLD);
  });

  it("does not finalize below the threshold", () => {
    const votes = [makeVote(m1, 0.8, "rootA")];
    const totalTrust = 0.8 + 0.8 + 0.7; // 0.8/2.3 = 0.35, far below 0.67
    expect(tryFinalize(votes, totalTrust)).toBeNull();
  });

  it("non master votes do not count", () => {
    const votes = [makeVote(m1, 0.5, "rootA"), makeVote(m2, 0.5, "rootA")]; // below master threshold
    expect(tryFinalize(votes, 1.0)).toBeNull();
    void m3;
  });
});
