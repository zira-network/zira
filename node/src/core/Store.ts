// node/src/core/Store.ts
// Persistence with no native dependency: an append only event log (events.jsonl) plus a periodic
// state snapshot (snapshot.json). On start the node loads the snapshot, then replays any events
// newer than it. This is durable and simple, which suits a node anyone can run.
import { appendFileSync, readFileSync, existsSync, mkdirSync, renameSync, openSync, writeSync, fdatasyncSync, closeSync, statSync } from "node:fs";
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

  private anchorStatePath: string;
  private settlerProgressPath: string;

  constructor(private dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.eventsPath = join(dataDir, "events.jsonl");
    this.snapshotPath = join(dataDir, "snapshot.json");
    this.ztiPath = join(dataDir, "zti-history.jsonl");
    this.anchorStatePath = join(dataDir, "anchor-state.json");
    this.settlerProgressPath = join(dataDir, "settler-progress.json");
  }

  // ---- Settler payout progress (which buckets/queries/resonators this node has ALREADY paid). Persisted so a
  // settler RESTART does not re-issue a payout for a bucket it already settled. Re-issuing was a real finality
  // freeze: the fixed pool is split among the settler's LIVE vouched-miner set, which differs after a restart
  // (fewer peers reconnected), so a restarted settler paid the same bucket a second time with a DIFFERENT payee
  // set/amount — conflicting txs that diverged the masters and stalled quorum. These guards are in-memory
  // watermarks; persisting them makes restart idempotent. Consensus-neutral: only the SETTLER reads/writes this,
  // and it only ever REMOVES duplicate txs it would otherwise issue. ----
  loadSettlerProgress(): { lastParticipationBucket?: number; lastAutonomousResonanceBucket?: number; paidResonatorRewards?: string[]; settledCoordinationQueries?: string[]; minerAnswerCredits?: Record<string, number> } | null {
    if (!existsSync(this.settlerProgressPath)) return null;
    try { return JSON.parse(readFileSync(this.settlerProgressPath, "utf8")); } catch { return null; }
  }

  saveSettlerProgress(state: { lastParticipationBucket: number; lastAutonomousResonanceBucket: number; paidResonatorRewards: string[]; settledCoordinationQueries: string[]; minerAnswerCredits?: Record<string, number> }): void {
    const tmp = this.settlerProgressPath + ".tmp";
    const fd = openSync(tmp, "w");
    try { writeSync(fd, JSON.stringify(state)); fdatasyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.settlerProgressPath);
  }

  // ---- Anchor event + contribution queue (non-consensus, steward-run). Persisted so a node/gateway
  // restart does not silently switch the event off or drop the steward's contribution queue. ----
  loadAnchorState(): { event?: object; contributions?: unknown[] } | null {
    if (!existsSync(this.anchorStatePath)) return null;
    try { return JSON.parse(readFileSync(this.anchorStatePath, "utf8")); } catch { return null; }
  }

  saveAnchorState(state: { event: object; contributions: unknown[] }): void {
    const tmp = this.anchorStatePath + ".tmp";
    const fd = openSync(tmp, "w");
    try { writeSync(fd, JSON.stringify(state)); fdatasyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.anchorStatePath);
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

  /** Read every persisted event, oldest first. Decodes line-by-line from a Buffer (NOT one giant utf8
   *  string): the event log can grow past Node's ~512MB max STRING length, at which point readFileSync(path,
   *  "utf8") throws ERR_STRING_TOO_LONG and the node can never boot. A Buffer's limit is ~2GB and each line
   *  is tiny, so decoding per line is always safe. (Log compaction below keeps the file far smaller anyway.) */
  readEvents(): Envelope[] {
    if (!existsSync(this.eventsPath)) return [];
    const out: Envelope[] = [];
    const buf = readFileSync(this.eventsPath); // Buffer, no encoding -> no single-string-length cap
    let start = 0;
    for (let i = 0; i <= buf.length; i++) {
      if (i === buf.length || buf[i] === 0x0a /* \n */) {
        if (i > start) {
          const line = buf.toString("utf8", start, i).trim();
          if (line) { try { out.push(JSON.parse(line) as Envelope); } catch { /* skip a torn line */ } }
        }
        start = i + 1;
      }
    }
    return out;
  }

  /** Current size of the event log in bytes (0 if absent). Used to decide when to compact. */
  eventsSizeBytes(): number {
    try { return statSync(this.eventsPath).size; } catch { return 0; }
  }

  /** Rewrite the event log keeping only the envelopes `keep` returns true for, atomically. The snapshot
   *  holds all APPLIED state, so only the recent unsettled replay window needs to persist. Without this the
   *  log grows without bound — a churn of re-gossiped duplicate txs (their ids keep cycling out of the
   *  bounded dedup cache and get re-appended) pushed a live settler's log past 512MB and made it un-bootable.
   *  Returns how many were kept/dropped; a no-op (nothing dropped) leaves the file untouched. */
  compactEvents(keep: (env: Envelope) => boolean): { kept: number; dropped: number } {
    if (!existsSync(this.eventsPath)) return { kept: 0, dropped: 0 };
    const all = this.readEvents();
    const kept = all.filter(keep);
    if (kept.length === all.length) return { kept: kept.length, dropped: 0 };
    const tmp = this.eventsPath + ".compact.tmp";
    const fd = openSync(tmp, "w");
    try {
      let chunk = "";
      for (const e of kept) {
        chunk += JSON.stringify(e) + "\n";
        if (chunk.length > 1_000_000) { writeSync(fd, chunk); chunk = ""; } // flush in ~1MB chunks; never build one giant string
      }
      if (chunk) writeSync(fd, chunk);
      fdatasyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(tmp, this.eventsPath);
    return { kept: kept.length, dropped: all.length - kept.length };
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
      // Decode line-by-line from a Buffer (NOT one giant utf8 string): zti-history.jsonl is append-only and
      // can grow past Node's ~512MB max STRING length, at which point readFileSync(path,"utf8") throws
      // ERR_STRING_TOO_LONG. Same pattern as readEvents; here the throw was swallowed but silently lost ALL
      // sparkline history once the file got large.
      const buf = readFileSync(this.ztiPath); // Buffer, no encoding -> ~2GB limit, no single-string cap
      let start = 0;
      for (let i = 0; i <= buf.length; i++) {
        if (i === buf.length || buf[i] === 0x0a /* \n */) {
          if (i > start) {
            const t = buf.toString("utf8", start, i).trim();
            if (t) try {
              const row = JSON.parse(t) as ZtiRow;
              const arr = this.ztiByAddress.get(row.address) ?? [];
              arr.push(row);
              if (arr.length > 1000) arr.shift();
              this.ztiByAddress.set(row.address, arr);
            } catch { /* skip torn line */ }
          }
          start = i + 1;
        }
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
