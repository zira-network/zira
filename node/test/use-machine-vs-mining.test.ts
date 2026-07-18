// node/test/use-machine-vs-mining.test.ts
// Task 2: "use my machine" (own-task local inference) and field mining/serving are SEPARATE, fully
// independent switches. Enabling one must never enable the other.
//   - mining.enabled       => serve the field + earn (canServe() can be true)
//   - mining.ownTaskInference => local inference for the USER'S OWN tasks only (never serves/earns)
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keypairFromPrivate } from "@zira/protocol";
import { ModelService } from "../src/models/ModelService.js";

function makeService(): ModelService {
  const dir = mkdtempSync(join(tmpdir(), "zira-switch-"));
  const identity = keypairFromPrivate("1a".repeat(32));
  // Minimal net stub: setMining/announceLocal only call net.handle (in init, which we never call) and
  // the announce callback. peers()/peerCount() are here so the replication loop enabling mining kicks off
  // sees no peers and stays a no-op (otherwise it throws "net.peers is not a function" during teardown).
  const net = { handle: () => {}, peers: () => [], peerCount: () => 0 } as any;
  return new ModelService(dir, net, identity, identity.address, () => {});
}

test("enabling own-task inference does NOT enable field mining/serving", async () => {
  const svc = makeService();
  await svc.setMining({ ownTaskInference: true });
  assert.equal(svc.ownTaskEnabled(), true, "own-task should be on");
  assert.equal(svc.miningEnabled(), false, "mining must stay off");
  assert.equal(svc.canServe(), false, "own-task-only must never serve the field");
});

test("enabling mining does NOT enable own-task local inference", async () => {
  const svc = makeService();
  await svc.setMining({ enabled: true });
  assert.equal(svc.miningEnabled(), true, "mining should be on");
  assert.equal(svc.ownTaskEnabled(), false, "own-task must stay off when only mining is enabled");
});

test("the two switches can be toggled independently without affecting each other", async () => {
  const svc = makeService();
  await svc.setMining({ ownTaskInference: true });
  await svc.setMining({ enabled: true });
  assert.equal(svc.miningEnabled(), true);
  assert.equal(svc.ownTaskEnabled(), true);
  // turning mining off leaves own-task on
  await svc.setMining({ enabled: false });
  assert.equal(svc.miningEnabled(), false);
  assert.equal(svc.ownTaskEnabled(), true);
  // turning own-task off leaves mining off (already off) and never re-enables mining
  await svc.setMining({ ownTaskInference: false });
  assert.equal(svc.ownTaskEnabled(), false);
  assert.equal(svc.miningEnabled(), false);
});
