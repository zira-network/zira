// node/test/history-archive.test.ts
// The opt-in history archive (ZIRA_ARCHIVE=1) must be fork-safe and robust: a no-op when disabled, a
// deduplicated append-only store when enabled, correctly paginated, and never throwing on a missing or
// malformed file. It touches ONLY local disk, so nothing here can affect consensus.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HistoryArchive } from "../src/core/HistoryArchive.js";
import type { LedgerEntry } from "../src/core/State.js";

function freshDir(): string { return mkdtempSync(join(tmpdir(), "zira-archive-")); }

// A minimal ledger row (only the fields the archive reads/filters on matter here).
function row(id: string, timestamp: number, from = "alice", to = "bob"): LedgerEntry {
  return { id, timestamp, from, to, amountUZIR: 1, feeUZIR: 0, nonce: 0, kind: "transfer", parents: [], network: "test", fromPubKey: "", sig: "" } as unknown as LedgerEntry;
}

// Run a body with ZIRA_ARCHIVE forced to a value, restoring the prior env afterward (construction reads it).
// Awaits the body so the flag stays set for the whole async test (a new HistoryArchive reads the flag at
// construction, and some tests construct one mid-body after an await).
async function withFlag<T>(value: string | undefined, body: () => Promise<T>): Promise<T> {
  const prev = process.env.ZIRA_ARCHIVE;
  if (value === undefined) delete process.env.ZIRA_ARCHIVE; else process.env.ZIRA_ARCHIVE = value;
  try { return await body(); } finally {
    if (prev === undefined) delete process.env.ZIRA_ARCHIVE; else process.env.ZIRA_ARCHIVE = prev;
  }
}

test("disabled by default: append is a no-op and read reports disabled shape", async () => {
  await withFlag(undefined, async () => {
    const a = new HistoryArchive(freshDir());
    assert.equal(a.enabled(), false, "off unless ZIRA_ARCHIVE=1");
    a.append([row("t1", 1000), row("t2", 2000)]);   // must not write anything
    const page = await a.read({});
    assert.equal(page.total, 0);
    assert.deepEqual(page.rows, []);
  });
});

test("enabled: append then read returns the rows (chronological)", async () => {
  await withFlag("1", async () => {
    const a = new HistoryArchive(freshDir());
    assert.equal(a.enabled(), true);
    // recentHistory returns newest-first; the archive must store chronologically regardless.
    a.append([row("t3", 3000), row("t2", 2000), row("t1", 1000)]);
    const page = await a.read({});
    assert.equal(page.total, 3);
    assert.deepEqual(page.rows.map((r) => r.id), ["t1", "t2", "t3"], "stored oldest-first");
  });
});

test("dedup: overlapping windows do not duplicate rows, even across a restart", async () => {
  await withFlag("1", async () => {
    const dir = freshDir();
    const a = new HistoryArchive(dir);
    a.append([row("t2", 2000), row("t1", 1000)]);
    // Overlapping window that re-includes t1/t2 and adds t3/t4. Only the new ones must be appended.
    a.append([row("t4", 4000), row("t3", 3000), row("t2", 2000), row("t1", 1000)]);
    let page = await a.read({});
    assert.equal(page.total, 4, "no duplicates from an overlapping window");
    assert.deepEqual(page.rows.map((r) => r.id), ["t1", "t2", "t3", "t4"]);

    // A fresh instance on the SAME dir must recover the marker and still dedup (no restart re-append).
    const b = new HistoryArchive(dir);
    b.append([row("t4", 4000), row("t3", 3000)]);   // all already archived
    b.append([row("t5", 5000)]);                    // genuinely new
    page = await b.read({});
    assert.equal(page.total, 5, "restart-recovered marker prevents re-appending the overlap");
    assert.deepEqual(page.rows.map((r) => r.id), ["t1", "t2", "t3", "t4", "t5"]);
  });
});

test("same-timestamp boundary rows are deduped by id, not by timestamp alone", async () => {
  await withFlag("1", async () => {
    const a = new HistoryArchive(freshDir());
    a.append([row("a", 1000), row("b", 1000)]);      // two rows share the high-water ts
    a.append([row("b", 1000), row("c", 1000)]);      // b is a dup at the same ts; c is new at the same ts
    const page = await a.read({});
    assert.equal(page.total, 3);
    assert.deepEqual(new Set(page.rows.map((r) => r.id)), new Set(["a", "b", "c"]));
  });
});

test("pagination: offset/limit page through matches with a stable total", async () => {
  await withFlag("1", async () => {
    const a = new HistoryArchive(freshDir());
    const rows: LedgerEntry[] = [];
    for (let i = 0; i < 25; i++) rows.push(row(`r${i}`, 1000 + i));
    a.append(rows);
    const p1 = await a.read({ offset: 0, limit: 10 });
    assert.equal(p1.total, 25);
    assert.equal(p1.rows.length, 10);
    assert.deepEqual(p1.rows.map((r) => r.id), Array.from({ length: 10 }, (_, i) => `r${i}`));
    const p2 = await a.read({ offset: 20, limit: 10 });
    assert.equal(p2.total, 25, "total is over all matches, not the page");
    assert.equal(p2.rows.length, 5, "last partial page");
    assert.deepEqual(p2.rows.map((r) => r.id), ["r20", "r21", "r22", "r23", "r24"]);
  });
});

test("filters: address (from or to) and time range narrow the result", async () => {
  await withFlag("1", async () => {
    const a = new HistoryArchive(freshDir());
    a.append([
      row("x1", 1000, "alice", "bob"),
      row("x2", 2000, "carol", "alice"),
      row("x3", 3000, "carol", "dave"),
    ]);
    const byAlice = await a.read({ address: "alice" });
    assert.equal(byAlice.total, 2, "matches from OR to");
    assert.deepEqual(byAlice.rows.map((r) => r.id), ["x1", "x2"]);
    const ranged = await a.read({ fromTs: 2000, toTs: 3000 });
    assert.deepEqual(ranged.rows.map((r) => r.id), ["x2", "x3"]);
  });
});

test("never throws on a missing file", async () => {
  await withFlag("1", async () => {
    const a = new HistoryArchive(freshDir());   // nothing appended yet -> file does not exist
    const page = await a.read({ address: "nobody" });
    assert.equal(page.total, 0);
    assert.deepEqual(page.rows, []);
  });
});

test("never throws on a malformed file (torn/garbage lines are skipped)", async () => {
  await withFlag("1", async () => {
    const dir = freshDir();
    mkdirSync(join(dir, "archive"), { recursive: true });
    // Two good rows around a garbage line and a torn tail; the read must recover the whole ones.
    const good1 = JSON.stringify(row("g1", 1000));
    const good2 = JSON.stringify(row("g2", 2000));
    writeFileSync(join(dir, "archive", "history.jsonl"), `${good1}\nnot json at all\n${good2}\n{"id":"torn",`);
    const a = new HistoryArchive(dir);
    const page = await a.read({});
    assert.equal(page.total, 2, "garbage and torn lines skipped, good rows kept");
    assert.deepEqual(page.rows.map((r) => r.id), ["g1", "g2"]);
  });
});
