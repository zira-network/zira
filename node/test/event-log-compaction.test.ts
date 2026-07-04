// node/test/event-log-compaction.test.ts
// The event log (events.jsonl) must stay bootable and bounded. A live settler's log grew past Node's ~512MB
// max STRING length (re-gossiped duplicate txs re-append forever as ids cycle out of the bounded dedup cache),
// so readFileSync(path,"utf8") threw ERR_STRING_TOO_LONG and the node could never boot. These tests prove
// (a) readEvents decodes line-by-line from a Buffer and tolerates a torn final line, and (b) compactEvents
// atomically drops the envelopes a predicate rejects while keeping the rest, oldest-first order preserved.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/core/Store.js";
import type { Envelope } from "../src/core/types.js";

function freshStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "zira-store-"));
  return { store: new Store(dir), dir };
}

test("readEvents decodes each line from a Buffer and skips a torn final line", () => {
  const { store, dir } = freshStore();
  const path = join(dir, "events.jsonl");
  const good = [
    { t: "tx", data: { timestamp: 1000, nonce: 0 } },
    { t: "observation", data: { timestamp: 2000 } },
    { t: "checkpoint", data: { epoch: 5 } },
  ];
  // last line is deliberately torn (no closing brace / newline) — must be skipped, not throw
  writeFileSync(path, good.map((e) => JSON.stringify(e)).join("\n") + '\n{"t":"tx","data":{"timesta');
  const got = store.readEvents();
  assert.equal(got.length, 3, "3 whole lines parsed, torn tail skipped");
  assert.equal((got[0] as Envelope).t, "tx");
  assert.equal((got[2] as { data: { epoch: number } }).data.epoch, 5, "order preserved oldest-first");
});

test("compactEvents drops rejected envelopes atomically and keeps the rest in order", () => {
  const { store, dir } = freshStore();
  const path = join(dir, "events.jsonl");
  const envs: Envelope[] = [];
  for (let i = 0; i < 100; i++) envs.push({ t: "tx", data: { timestamp: i * 1000 } } as unknown as Envelope);
  envs.push({ t: "checkpoint", data: { epoch: 3 } } as unknown as Envelope);
  envs.push({ t: "model", data: { id: "x" } } as unknown as Envelope); // structural, always kept
  writeFileSync(path, envs.map((e) => JSON.stringify(e)).join("\n") + "\n");

  // keep only tx events with timestamp >= 50_000, plus all non-tx/observation structural events
  const res = store.compactEvents((env) => {
    if (env.t === "tx" || env.t === "observation") {
      const ts = (env.data as { timestamp?: number }).timestamp;
      return typeof ts !== "number" || ts >= 50_000;
    }
    if (env.t === "checkpoint") return (env.data as { epoch?: number }).epoch! >= 100; // drop the old checkpoint
    return true;
  });
  assert.equal(res.dropped, 50 + 1, "50 old txs + 1 old checkpoint dropped");
  assert.equal(res.kept, 50 + 1, "50 recent txs + the model event kept");

  const after = store.readEvents();
  assert.equal(after.length, 51);
  assert.ok(after.every((e) => e.t !== "tx" || (e.data as { timestamp: number }).timestamp >= 50_000), "no stale tx remains");
  assert.ok(after.some((e) => e.t === "model"), "structural event survived");
  assert.ok(!existsSync(path + ".compact.tmp"), "temp file cleaned up after atomic rename");
});

test("compactEvents is a no-op (leaves file untouched) when nothing is dropped", () => {
  const { store, dir } = freshStore();
  const path = join(dir, "events.jsonl");
  writeFileSync(path, JSON.stringify({ t: "tx", data: { timestamp: 1 } }) + "\n");
  const before = readFileSync(path, "utf8");
  const res = store.compactEvents(() => true);
  assert.equal(res.dropped, 0);
  assert.equal(readFileSync(path, "utf8"), before, "file byte-identical when nothing dropped");
});
