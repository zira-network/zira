// node/test/serve-health.test.ts
// R1: a provider must PROVE it can generate before advertising. ModelService.probeServable runs one real
// bounded generation and caches the result; the miner loop gates its provider announce on servableHealthy,
// so a node with a loaded model/endpoint that cannot actually generate never becomes a phantom provider.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeypair, keypairFromPrivate } from "@zira/protocol";
import { ModelService } from "../src/models/ModelService.js";

const founder = keypairFromPrivate("01".repeat(32));
function netStub() {
  return { peerId: () => "p", peers: () => [], handle() {}, request: async () => [], publish: async () => {},
    onMessage() {}, setSyncProvider() {}, onSyncFrame() {}, onPeerConnect() {}, dial: async () => {},
    start: async () => {}, stop: async () => {}, multiaddrs: () => [], peerCount: () => 0 } as any;
}
function svcWithEndpoint(): ModelService {
  const s = new ModelService(join(tmpdir(), `zira-sh-${process.pid}-${Math.round(performance.now())}-${Math.random()}`), netStub(), generateKeypair(), founder.address, () => {});
  // Make canServe() true without a native engine: pretend an endpoint is configured and mining is on.
  (s as any).mining.enabled = true;
  (s as any).mining.endpoint = "http://127.0.0.1:1/v1";
  return s;
}

test("a node that can generate becomes servable-healthy and advertises", async () => {
  const s = svcWithEndpoint();
  let calls = 0;
  (s as any).generate = async () => { calls++; return "ok"; };
  assert.equal(s.servableHealthy(), false, "unhealthy until proven");
  const ok = await s.probeServable(1000);
  assert.equal(ok, true);
  assert.equal(s.servableHealthy(), true);
  assert.equal(calls, 1);
  assert.equal(s.serveHealthInfo().lastError, null);
});

test("a node whose generation FAILS is never healthy (no phantom provider)", async () => {
  const s = svcWithEndpoint();
  (s as any).generate = async () => { throw new Error("model arch unsupported"); };
  const ok = await s.probeServable(1000);
  assert.equal(ok, false);
  assert.equal(s.servableHealthy(), false);
  assert.match(s.serveHealthInfo().lastError ?? "", /arch unsupported/);
});

test("an empty generation counts as unhealthy", async () => {
  const s = svcWithEndpoint();
  (s as any).generate = async () => "   ";
  assert.equal(await s.probeServable(1000), false);
  assert.equal(s.servableHealthy(), false);
});

test("a node that cannot serve at all is unhealthy without generating", async () => {
  const s = svcWithEndpoint();
  (s as any).mining.enabled = false;   // canServe() false
  let calls = 0;
  (s as any).generate = async () => { calls++; return "ok"; };
  assert.equal(await s.probeServable(1000), false);
  assert.equal(calls, 0, "never runs a generation when it cannot serve");
});

test("the probe is throttled to its TTL (no generation storm)", async () => {
  const s = svcWithEndpoint();
  let calls = 0;
  (s as any).generate = async () => { calls++; return "ok"; };
  await s.probeServable(1000);            // probes
  await s.probeServable(1000 + 60_000);   // within 5 min TTL -> cached, no new probe
  assert.equal(calls, 1);
  await s.probeServable(1000 + 400_000);  // past TTL -> probes again
  assert.equal(calls, 2);
});
