// node/test/serve-restart.test.ts
// A miner must resume serving with its OWN hardware after a restart. The inference subprocess endpoint
// (127.0.0.1:<rpcPort+31>) is ephemeral; older builds persisted it to mining.json, so on restart reconcileAuto
// mistook it for an external endpoint and never respawned the subprocess -> the node held a model but never
// answered. loadMining now drops a stale subprocess endpoint (external endpoints are preserved).
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { generateKeypair, keypairFromPrivate } from "@zira/protocol";
import { ModelService } from "../src/models/ModelService.js";

const founder = keypairFromPrivate("01".repeat(32));
function netStub() {
  return { peerId: () => "p", peers: () => [], handle() {}, request: async () => [], publish: async () => {},
    onMessage() {}, setSyncProvider() {}, onSyncFrame() {}, onPeerConnect() {}, dial: async () => {},
    start: async () => {}, stop: async () => {}, multiaddrs: () => [], peerCount: () => 0 } as any;
}
function dirWithMining(mining: Record<string, unknown>): string {
  const dir = join(tmpdir(), `zira-sr-${process.pid}-${Math.round(performance.now())}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "mining.json"), JSON.stringify(mining));
  return dir;
}

test("a persisted inference-subprocess endpoint is dropped on load, so the miner respawns and serves", () => {
  const prev = process.env.ZIRA_RPC_PORT; const prevInf = process.env.ZIRA_INFERENCE_PORT;
  process.env.ZIRA_RPC_PORT = "8645"; delete process.env.ZIRA_INFERENCE_PORT;   // subprocess port = 8645 + 31 = 8676
  try {
    const dir = dirWithMining({ enabled: true, mode: "auto", endpoint: "http://127.0.0.1:8676/v1", endpointModel: "qwen2.5-1.5b" });
    const s = new ModelService(dir, netStub(), generateKeypair(), founder.address, () => {});
    assert.equal(s.currentMining().endpoint, undefined, "stale subprocess endpoint must be cleared so serving resumes");
    assert.equal(s.currentMining().enabled, true);
  } finally {
    if (prev === undefined) delete process.env.ZIRA_RPC_PORT; else process.env.ZIRA_RPC_PORT = prev;
    if (prevInf !== undefined) process.env.ZIRA_INFERENCE_PORT = prevInf;
  }
});

test("an external endpoint (e.g. Ollama) is preserved on load", () => {
  const dir = dirWithMining({ enabled: true, mode: "auto", endpoint: "http://127.0.0.1:11434/v1", endpointModel: "llama3" });
  const s = new ModelService(dir, netStub(), generateKeypair(), founder.address, () => {});
  assert.equal(s.currentMining().endpoint, "http://127.0.0.1:11434/v1", "a real external endpoint must be kept");
});
