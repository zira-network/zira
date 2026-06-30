import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRpc } from "../src/rpc/server.js";
import { Store } from "../src/core/Store.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function req(port: number, path: string, init: RequestInit = {}) {
  for (let i = 0; i < 20; i++) {
    try { return await fetch(`http://127.0.0.1:${port}${path}`, init); }
    catch { await sleep(50); }
  }
  throw new Error("RPC server did not start");
}

// The "good" signature the mock node treats as a valid steward signature. The real verifyStewardSig does an
// ed25519 verify + founder/steward-address check; here we just assert the gate + handler thread the steward
// credentials through correctly on a public (non-loopback) gateway bind.
const GOOD_SIG = "good-steward-sig";

function mockNode() {
  const state = { enabled: false, evm: "", tron: "", wcProjectId: "" };
  const contributions: any[] = [];
  return {
    _state: state,
    _contributions: contributions,
    isFounder: () => false, // a public gateway never holds the founder key
    verifyStewardSig: (_pk: string, _ch: string, sig: string) => sig === GOOD_SIG,
    anchorEventStatus: () => ({ ...state }),
    setAnchorEvent: (patch: any) => {
      if (typeof patch.evm === "string") state.evm = patch.evm;
      if (typeof patch.tron === "string") state.tron = patch.tron;
      if (typeof patch.wcProjectId === "string") state.wcProjectId = patch.wcProjectId;
      if (typeof patch.enabled === "boolean") state.enabled = patch.enabled && !!(state.evm || state.tron);
      return { ...state };
    },
    recordAnchorContribution: (c: any) => { contributions.push(c); return { ok: true }; },
    anchorContributions: () => [...contributions].reverse(),
  };
}

test("gateway: anyone reads the anchor event; only a steward-signed request can toggle it", async () => {
  const node = mockNode();
  const port = 18671;
  const stop = startRpc(node as any, { host: "0.0.0.0", port, gateway: true });
  try {
    // public READ of the event status is open (so every user's app can gate the contribute section)
    const read0 = await req(port, "/rpc/anchors/event");
    assert.equal(read0.status, 200);
    assert.equal((await read0.json()).enabled, false);

    // toggle WITHOUT a steward signature: the gate lets the public POST through, the handler rejects it 403
    const denied = await req(port, "/rpc/anchors/event", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, evm: "0xabc" }),
    });
    assert.equal(denied.status, 403);
    assert.equal((await req(port, "/rpc/anchors/event").then((r) => r.json())).enabled, false);

    // toggle WITH a valid steward signature: accepted on the public bind, event goes live for everyone
    const ok = await req(port, "/rpc/anchors/event", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, evm: "0xReceiver", tron: "TReceiver", wcProjectId: "wc1", stewardPubKey: "pk", stewardChallenge: "zira-steward:1", stewardSig: GOOD_SIG }),
    });
    assert.equal(ok.status, 200);
    const live = await req(port, "/rpc/anchors/event").then((r) => r.json());
    assert.equal(live.enabled, true);
    assert.equal(live.evm, "0xReceiver");
    assert.equal(live.wcProjectId, "wc1");
  } finally { stop(); }
});

test("gateway: contributions are public to record, steward-signed to read", async () => {
  const node = mockNode();
  const port = 18672;
  const stop = startRpc(node as any, { host: "0.0.0.0", port, gateway: true });
  try {
    // a contributor records a USDT payment on the shared gateway (public, no token)
    const rec = await req(port, "/rpc/anchors/contribution", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ zirAddress: "zir1abc", network: "Ethereum", amountUsdt: 5000, txHash: "0xtx", classCode: "A", quantity: 1 }),
    });
    assert.equal(rec.status, 200);
    assert.equal((await rec.json()).ok, true);

    // reading the queue WITHOUT a steward signature is blocked on the public bind
    const denied = await req(port, "/rpc/anchors/contributions");
    assert.equal(denied.status, 403);

    // reading WITH a valid steward signature in the query returns the queue
    const qs = "stewardPubKey=pk&stewardChallenge=zira-steward:1&stewardSig=" + GOOD_SIG;
    const ok = await req(port, `/rpc/anchors/contributions?${qs}`);
    assert.equal(ok.status, 200);
    const rows = await ok.json();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].zirAddress, "zir1abc");
    assert.equal(rows[0].amountUsdt, 5000);
  } finally { stop(); }
});

test("anchor state persists across a restart (Store round-trip)", () => {
  const dir = mkdtempSync(join(tmpdir(), "zira-anchor-"));
  try {
    const s1 = new Store(dir);
    assert.equal(s1.loadAnchorState(), null); // nothing yet
    s1.saveAnchorState({
      event: { enabled: true, evm: "0xRecv", tron: "TRecv", wcProjectId: "wc9" },
      contributions: [{ zirAddress: "zir1x", network: "BSC", amountUsdt: 150, txHash: "0xh", classCode: "F", quantity: 1, status: "pending" }],
    });
    // a fresh Store over the same dir (a restart) reads it back
    const s2 = new Store(dir);
    const restored = s2.loadAnchorState();
    assert.ok(restored);
    assert.equal((restored!.event as any).enabled, true);
    assert.equal((restored!.event as any).evm, "0xRecv");
    assert.equal((restored!.contributions as any[]).length, 1);
    assert.equal((restored!.contributions as any[])[0].classCode, "F");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
