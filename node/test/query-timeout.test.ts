// node/test/query-timeout.test.ts
// Task 3: a field query must NEVER hang forever. GET /rpc/query/result waits a bounded time for an
// answer, then returns either the fused answer or a clear timed-out result the Console can read.
import test from "node:test";
import assert from "node:assert/strict";
import { startRpc } from "../src/rpc/server.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(port: number, path: string) {
  for (let i = 0; i < 20; i++) {
    try { return await fetch(`http://127.0.0.1:${port}${path}`); }
    catch { await sleep(50); }
  }
  throw new Error("RPC server did not start");
}

// A stub node that exposes the awaitQueryAnswer contract the route depends on. answersFor controls
// whether a query has a collected answer yet.
function makeNode(answersFor: Map<string, any[]>) {
  return {
    awaitQueryAnswer: async (queryId: string, timeoutMs = 30_000) => {
      const start = Date.now();
      const deadline = start + Math.min(timeoutMs, 120_000);
      for (;;) {
        const answers = answersFor.get(queryId) ?? [];
        if (answers.length > 0) return { ok: true, queryId, answers: answers.length, timedOut: false, waitedMs: Date.now() - start };
        if (Date.now() >= deadline) return { ok: false, queryId, answers: 0, timedOut: true, waitedMs: Date.now() - start, reason: "no answer yet" };
        await sleep(20);
      }
    },
    soft: {
      queries: new Map([["q-answered", { id: "q-answered", domain: "general" }]]),
      answers: answersFor,
    },
    state: { accounts: new Map() },
  };
}

test("query/result times out with a clear result instead of hanging forever", async () => {
  const node = makeNode(new Map()); // no answers ever
  const port = 18647;
  const stop = startRpc(node as any, { host: "127.0.0.1", port });
  try {
    const res = await get(port, "/rpc/query/result?id=q-none&timeoutMs=200");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.timedOut, true);
    assert.equal(body.fusion, null);
    assert.ok(typeof body.reason === "string" && body.reason.length > 0);
  } finally {
    stop();
  }
});

test("query/result returns the fused answer as soon as one arrives", async () => {
  const answers = new Map<string, any[]>();
  const node = makeNode(answers);
  const port = 18648;
  const stop = startRpc(node as any, { host: "127.0.0.1", port });
  try {
    // answer arrives shortly after the request starts waiting
    setTimeout(() => {
      answers.set("q-answered", [{ id: "a1", queryId: "q-answered", provider: "ab".repeat(32), answer: "the answer is 42 and more detail here", confidence: 0.8, sig: "", ts: Date.now() }]);
    }, 60);
    const res = await get(port, "/rpc/query/result?id=q-answered&timeoutMs=5000");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.timedOut, false);
    assert.ok(body.fusion && typeof body.fusion.fusedAnswer === "string");
  } finally {
    stop();
  }
});
