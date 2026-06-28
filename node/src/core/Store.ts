// node/src/core/Store.ts
// Persistence with no native dependency: an append only event log (events.jsonl) plus a periodic
// state snapshot (snapshot.json). On start the node loads the snapshot, then replays any events
// newer than it. This is durable and simple, which suits a node anyone can run.
import { appendFileSync, readFileSync, existsSync, mkdirSync, renameSync, openSync, writeSync, fdatasyncSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { Domain, ZtiSnapshot } from "@zira/protocol";
import type { Envelope } from "./types.js";
import { log } from "../log.js";

interface ZtiRow { address: string; domain: Domain; zti: number; epoch: number }

export class Store {
  private eventsPath: string;
  private snapshotPath: string;
  private ztiPath: string;
  // in-memory ring buffer per address, mirrored to disk for sparklines (keep last 1000 per address)
  private ztiByAddress = new Map<string, ZtiRow[]>();
  private ztiLoaded = false;

  constructor(private dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.eventsPath = join(dataDir, "events.jsonl");
    this.snapshotPath = join(dataDir, "snapshot.json");
    this.ztiPath = join(dataDir, "zti-history.jsonl");
  }

  /** Append accepted durable events for replay after restart. Presence/query/answer traffic stays live-only. */
  appendEvent(env: Envelope): void {
    if (!["tx", "observation", "checkpoint", "resonator", "task", "providerProfile", "recommendation", "model"].includes(env.t)) return;
    try {
      appendFileSync(this.eventsPath, JSON.stringify(env) + "\n");
    } catch (e) {
      log.warn("append failed", (e as Error).message);
    }
  }

  /** Read every persisted event, oldest first. */
  readEvents(): Envelope[] {
    if (!existsSync(this.eventsPath)) return [];
    const raw = readFileSync(this.eventsPath, "utf8");
    const out: Envelope[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* skip a torn line */ }
    }
    return out;
  }

  loadSnapshot(): any | null {
    if (!existsSync(this.snapshotPath)) return null;
    try { return JSON.parse(readFileSync(this.snapshotPath, "utf8")); } catch { return null; }
  }

  writeSnapshot(snap: object): void {
    // F11: write to a temp file, fdatasync it so its bytes are on disk, THEN atomically rename. Without
    // the fsync a crash can leave a zero-length or partial snapshot that survives the rename and forces
    // a full genesis replay on next start. The event log stays on the fast append path (a lost tail
    // event is recovered via re-gossip), so this targets the high-cost failure without per-event fsync.
    const tmp = this.snapshotPath + ".tmp";
    const fd = openSync(tmp, "w");
    try {
      writeSync(fd, JSON.stringify(snap));
      fdatasyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.snapshotPath);
  }

  // ---- ZTI history (rolling, for the Console dashboard sparklines) ----

  private loadZti(): void {
    if (this.ztiLoaded) return;
    this.ztiLoaded = true;
    if (!existsSync(this.ztiPath)) return;
    try {
      for (const line of readFileSync(this.ztiPath, "utf8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const row = JSON.parse(t) as ZtiRow;
          const arr = this.ztiByAddress.get(row.address) ?? [];
          arr.push(row);
          if (arr.length > 1000) arr.shift();
          this.ztiByAddress.set(row.address, arr);
        } catch { /* skip torn line */ }
      }
    } catch { /* best effort */ }
  }

  appendZtiSnapshot(address: string, domain: Domain, zti: number, epoch: number): void {
    this.loadZti();
    const arr = this.ztiByAddress.get(address) ?? [];
    const last = arr[arr.length - 1];
    if (last && last.domain === domain && last.epoch === epoch) return; // one point per (domain, epoch)
    const row: ZtiRow = { address, domain, zti: Number(zti.toFixed(4)), epoch };
    arr.push(row);
    if (arr.length > 1000) arr.shift();
    this.ztiByAddress.set(address, arr);
    try { appendFileSync(this.ztiPath, JSON.stringify(row) + "\n"); } catch { /* best effort */ }
  }

  getZtiHistory(address: string, domain?: Domain, limit = 100): ZtiSnapshot[] {
    this.loadZti();
    let rows = this.ztiByAddress.get(address) ?? [];
    if (domain) rows = rows.filter((r) => r.domain === domain);
    return rows.slice(-limit).map((r) => ({ epoch: r.epoch, zti: r.zti, domain: r.domain }));
  }
}
