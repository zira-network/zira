import test from "node:test";
import assert from "node:assert/strict";
import { startRpc } from "../src/rpc/server.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function req(port: number, path: string, init: RequestInit = {}) {
  for (let i = 0; i < 20; i++) {
    try {
      return await fetch(`http://127.0.0.1:${port}${path}`, init);
    } catch {
      await sleep(50);
    }
  }
  throw new Error("RPC server did not start");
}

async function post(port: number, headers: Record<string, string> = {}) {
  return req(port, "/rpc/admin/reset", { method: "POST", headers });
}

test("public RPC blocks sensitive routes without an admin token", async () => {
  let wiped = false;
  const node = { wipeAndExit: () => { wiped = true; } };
  const port = 18645;
  const stop = startRpc(node as any, { host: "0.0.0.0", port, adminToken: "secret" });
  try {
    const denied = await post(port);
    assert.equal(denied.status, 403);
    assert.equal(wiped, false);

    const allowed = await post(port, { "X-ZIRA-Admin": "secret" });
    assert.equal(allowed.status, 200);
    assert.equal(wiped, true);
  } finally {
    stop();
  }
});

test("gateway mode: public read + public query succeed, sensitive route blocked without token", async () => {
  let wiped = false;
  let publishedQuery: any = null;
  const node = {
    wipeAndExit: () => { wiped = true; },
    stats: () => ({ ok: true, peers: 0 }),
    publishQuery: (qq: any) => { publishedQuery = qq; },
    models: { miningEnabled: () => false },
  };
  const port = 18646;
  // gateway mode on, NO admin token: the safe public subset is open, everything else is blocked.
  const stop = startRpc(node as any, { host: "0.0.0.0", port, gateway: true });
  try {
    // public READ route succeeds
    const stats = await req(port, "/rpc/stats");
    assert.equal(stats.status, 200);
    assert.deepEqual(await stats.json(), { ok: true, peers: 0 });

    // public QUERY submit succeeds (F5 IP-rate-limited, no token needed in gateway mode)
    const query = await req(port, "/rpc/query", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: { id: "q1", domain: "general", question: "hi", history: [], asker: "a", postedAt: Date.now() } }),
    });
    assert.equal(query.status, 200);
    assert.equal((await query.json()).ok, true);
    assert.equal(publishedQuery?.id, "q1");

    // SENSITIVE route is blocked (403) without the admin token, even in gateway mode
    const denied = await post(port);
    assert.equal(denied.status, 403);
    assert.equal(wiped, false);

    // a sensitive POST that is NOT in the public submit allowlist is also blocked in gateway mode
    const deniedMining = await req(port, "/rpc/mining", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(deniedMining.status, 403);
  } finally {
    stop();
  }
});
