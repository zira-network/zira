// node/test/mainnet-genesis-stable.test.ts
// PERMANENT-MAINNET GUARD. The mainnet genesis id is the network's identity: a node only joins (and
// continues the existing ZIR history of) the live chain if it computes THIS exact id. Any change to the
// genesis doc — masters, founders, reserve, allocations, anchors, timestamp, message — changes this hash
// and would fork a NEW network (a re-genesis), stranding every existing balance. The live mainnet runs
// genesis d28a99e809b2… (confirmed in the box1 masters' boot logs). This test pins it so no future edit
// can silently re-genesis the chain: if it fails, STOP — a genesis change is a fresh network, not an upgrade.
import test from "node:test";
import assert from "node:assert/strict";
import { genesisId, applyGenesis } from "@zira/protocol";
import { genesisFor } from "../src/genesis-docs.js";

const LIVE_MAINNET_GENESIS_ID = "d28a99e809b2a1584824dab419b618d291526b03d7809c749f709f30c0d8af62";

test("the mainnet genesis id is UNCHANGED — this build continues the live chain, never re-genesis", () => {
  const g = genesisFor("mainnet");
  assert.equal(genesisId(g), LIVE_MAINNET_GENESIS_ID,
    "mainnet genesis id changed => this build would fork a NEW network and strand all existing ZIR. Do NOT ship.");
});

test("the decentralization cutover added NO genesis-doc fields (its constants live off the genesis)", () => {
  const g = genesisFor("mainnet") as Record<string, unknown>;
  // The genesis doc carries only these keys; the cutover's activation epoch / validator constants are in
  // PROTOCOL (compile-time), never in the genesis, so the genesis hash is untouched.
  const keys = Object.keys(g).sort();
  assert.deepEqual(keys, ["allocations", "anchorOwnership", "anchors", "founder", "founders", "masters", "message", "network", "reserveUZIR", "timestamp"]);
  // Seeded supply is deterministic from the (unchanged) reserve; emission starts at 0, exactly as the live chain did.
  const seeded = applyGenesis(g as never);
  assert.equal(seeded.supply.emitted, 0);
  assert.equal(seeded.supply.reserve, (g as { reserveUZIR: number }).reserveUZIR);
});
