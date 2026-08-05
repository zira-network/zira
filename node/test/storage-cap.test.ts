// node/test/storage-cap.test.ts
// Prove the v3.3 storage-truth guarantees at the ModelStore layer: on-disk accounting counts partials and
// orphans (not just finalized models), and the orphan sweep reclaims abandoned temps / stray files / dirs
// for unknown ids while never touching a kept or actively-downloading model. This is what makes "on disk
// never exceeds the cap" and "auto-remove anything outside the cap" true even when a download dies mid-flight.
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, statSync, utimesSync } from "node:fs";
import { ModelStore } from "../src/models/ModelStore.js";

function ggufBytes(sizeBytes: number): Buffer {
  const b = Buffer.alloc(Math.max(4, sizeBytes));
  b.write("GGUF", 0, "utf8");
  return b;
}
// Write a finalized, valid model dir (data.gguf with the GGUF magic + a meta.json) as ModelStore expects.
function writeFinalized(modelsDir: string, id: string, sizeBytes: number): void {
  const dir = join(modelsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "data.gguf"), ggufBytes(sizeBytes));
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ id, name: id, type: "text", domains: ["general"], sizeBytes, chunkSize: 1, chunkCount: 1, ts: 1 }));
}

test("diskBytes counts finalized + partials + orphans; sweepOrphans reclaims junk but keeps known/active", () => {
  const dataDir = join(tmpdir(), `zira-scap-${process.pid}-${Date.now()}`);
  const modelsDir = join(dataDir, "models");
  mkdirSync(modelsDir, { recursive: true });
  const store = new ModelStore(dataDir);

  const KNOWN = "a".repeat(64);
  writeFinalized(modelsDir, KNOWN, 1000);            // a real, registry-known model
  // orphans / junk that no model owns:
  writeFileSync(join(modelsDir, "dl-1.part"), Buffer.alloc(500));   // abandoned URL-import temp
  writeFileSync(join(modelsDir, "stray.bin"), Buffer.alloc(300));   // stray file at the models root
  const ORPHDIR = "b".repeat(64);
  mkdirSync(join(modelsDir, ORPHDIR), { recursive: true });
  writeFileSync(join(modelsDir, ORPHDIR, "data.part"), Buffer.alloc(700)); // partial for an unknown id

  // Back-date the temp so it is past the sweep grace window (the sweep spares fresh temps = active downloads).
  const old = Date.now() / 1000 - 7200;
  utimesSync(join(modelsDir, "dl-1.part"), old, old);

  // (1) accounting sees EVERYTHING on disk (junk = 500 temp + 300 stray + 700 orphan dir), not just the
  // finalized model. diskBytes also counts the tiny meta.json, so assert relationships, not a hardcoded total.
  const JUNK = 500 + 300 + 700;
  const before = store.diskBytes();
  assert.ok(before > store.totalBytes(), "diskBytes must exceed finalized-only bytes (it counts partials/orphans)");
  assert.equal(store.totalBytes(), 1000, "totalBytes counts only the finalized model");

  // (2) sweep with the known model kept and nothing active: junk goes, the known model stays.
  const freed = store.sweepOrphans(new Set([KNOWN]), new Set());
  assert.equal(freed, JUNK, "sweep reclaims exactly the temp + stray + orphan-dir bytes");
  assert.equal(before - store.diskBytes(), JUNK, "on-disk drops by exactly the junk that was reclaimed");
  assert.ok(existsSync(join(modelsDir, KNOWN, "data.gguf")), "known model is preserved");
  assert.ok(!existsSync(join(modelsDir, "dl-1.part")), "abandoned temp removed");
  assert.ok(!existsSync(join(modelsDir, "stray.bin")), "stray file removed");
  assert.ok(!existsSync(join(modelsDir, ORPHDIR)), "unknown-id dir removed");
  assert.equal(store.totalBytes(), 1000, "the kept model is intact after the sweep");
});

test("sweepOrphans spares a fresh temp (an in-progress download) and an active id", () => {
  const dataDir = join(tmpdir(), `zira-scap2-${process.pid}-${Date.now()}`);
  const modelsDir = join(dataDir, "models");
  mkdirSync(modelsDir, { recursive: true });
  const store = new ModelStore(dataDir);

  writeFileSync(join(modelsDir, "dl-fresh.part"), Buffer.alloc(400)); // just written = active download
  const ACTIVE = "c".repeat(64);
  mkdirSync(join(modelsDir, ACTIVE), { recursive: true });
  writeFileSync(join(modelsDir, ACTIVE, "data.part"), Buffer.alloc(600)); // model currently downloading

  const freed = store.sweepOrphans(new Set(), new Set([ACTIVE]));
  assert.equal(freed, 0, "nothing reclaimed: fresh temp is within grace, active id is protected");
  assert.ok(existsSync(join(modelsDir, "dl-fresh.part")), "fresh temp kept");
  assert.ok(existsSync(join(modelsDir, ACTIVE, "data.part")), "active download kept");
  assert.ok(statSync(join(modelsDir, ACTIVE, "data.part")).size === 600);
});
