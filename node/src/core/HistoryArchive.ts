// node/src/core/HistoryArchive.ts
// Opt-in, append-only local archive of finalized ledger history.
//
// FORK-SAFETY CONTRACT (ZIRA is a live, permanent mainnet):
//  - This subsystem is PURELY LOCAL disk persistence plus a local streaming read. It NEVER touches
//    computeStateRoot, emission, balances, votes, or any consensus path, and it introduces NO new
//    consensus state. Two nodes running with the flag on/off finalize byte-identical roots.
//  - It is OFF BY DEFAULT behind the env flag ZIRA_ARCHIVE=1 (mirrors ZIRA_SERVE_BASELINE). With the
//    flag off, enabled() is false, append() is a no-op, and the node's behavior is byte-identical to a
//    node without this file. This guarantees zero risk to the running network.
//  - append() is best-effort and fully try/caught. It MUST NEVER throw into the node's hot path or delay
//    finalization. A disk error is swallowed and logged; finality is unaffected.
//
// WHY it exists: state.recentHistory() is a bounded in-memory window (HISTORY_CAP / REWARD_HISTORY_CAP),
// so a long-running node loses deep history. An archive node (ZIRA_ARCHIVE=1) appends the recent window
// on every finalized checkpoint; because appends are deduplicated and monotonic, the on-disk archive
// grows into the FULL history over time even though each individual window is bounded.
//
// Increment 2 (peer replication + cross-node verification of the archive) is intentionally NOT built here.
import { appendFileSync, createReadStream, existsSync, mkdirSync, openSync, writeSync, fdatasyncSync, closeSync, renameSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { LedgerEntry } from "./State.js";
import { log } from "../log.js";

export interface ArchiveQuery {
  address?: string | null;
  fromTs?: number | null;
  toTs?: number | null;
  offset?: number;
  limit?: number;
}
export interface ArchivePage {
  rows: LedgerEntry[];
  total: number;
}

// Hard ceiling on a single read page, so a public archive read can never be asked to buffer an unbounded
// slice into memory. The RPC caps the requested limit to this too.
export const ARCHIVE_MAX_LIMIT = 500;

export class HistoryArchive {
  private readonly dir: string;
  private readonly filePath: string;
  private readonly markerPath: string;
  private readonly on: boolean;
  // Monotonic high-water mark of what has already been archived. A row is considered NEW iff its timestamp
  // is strictly greater than lastTs, or it equals lastTs and its id was not among the ids already archived at
  // that exact timestamp. This dedups repeated overlapping windows without holding every id in memory, and it
  // survives a restart because the marker is persisted to disk beside the archive.
  private lastTs = -1;
  private idsAtLastTs = new Set<string>();
  private loaded = false;

  constructor(dataDir: string) {
    this.dir = join(dataDir, "archive");
    this.filePath = join(this.dir, "history.jsonl");
    this.markerPath = join(this.dir, "history.marker.json");
    this.on = process.env.ZIRA_ARCHIVE === "1";
  }

  /** True only when the operator opted in with ZIRA_ARCHIVE=1. Off by default. */
  enabled(): boolean { return this.on; }

  // Recover the dedup marker (lastTs + the ids at that timestamp) from disk, so appends stay deduplicated
  // across restarts. Best-effort: a missing or malformed marker just starts from scratch (at worst a single
  // overlapping window is re-appended once, still bounded).
  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (existsSync(this.markerPath)) {
        const m = JSON.parse(readFileSync(this.markerPath, "utf8"));
        if (typeof m?.lastTs === "number") this.lastTs = m.lastTs;
        if (Array.isArray(m?.idsAtLastTs)) this.idsAtLastTs = new Set(m.idsAtLastTs.map(String));
      }
    } catch (e) {
      log.warn(`history archive: marker load failed (${(e as Error).message}); starting from empty marker`);
    }
  }

  private persistMarker(): void {
    try {
      const tmp = this.markerPath + ".tmp";
      const fd = openSync(tmp, "w");
      try {
        writeSync(fd, JSON.stringify({ lastTs: this.lastTs, idsAtLastTs: [...this.idsAtLastTs] }));
        fdatasyncSync(fd);
      } finally { closeSync(fd); }
      renameSync(tmp, this.markerPath);
    } catch { /* best-effort: a missed marker write only risks re-appending one overlapping window */ }
  }

  /**
   * Append the ledger rows that have not been archived yet, oldest-first so the file stays chronological.
   * Best-effort and fully guarded: any error is swallowed so finalization is never delayed or broken. A no-op
   * when the archive is disabled. Rows may arrive newest-first (as recentHistory returns them); we filter by
   * the monotonic marker and write in chronological order.
   */
  append(rows: readonly LedgerEntry[]): void {
    if (!this.on) return;
    try {
      if (!rows || rows.length === 0) return;
      this.ensureLoaded();
      // Select rows strictly newer than the marker (with same-timestamp id-dedup at the boundary).
      const fresh: LedgerEntry[] = [];
      for (const r of rows) {
        if (!r || typeof r.timestamp !== "number" || typeof r.id !== "string") continue;
        if (r.timestamp > this.lastTs) fresh.push(r);
        else if (r.timestamp === this.lastTs && !this.idsAtLastTs.has(r.id)) fresh.push(r);
      }
      if (fresh.length === 0) return;
      // Chronological on disk: recentHistory is newest-first, so append in reverse (oldest-first).
      fresh.sort((a, b) => a.timestamp - b.timestamp);
      mkdirSync(this.dir, { recursive: true });
      let buf = "";
      for (const r of fresh) buf += JSON.stringify(r) + "\n";
      appendFileSync(this.filePath, buf);
      // Advance the marker to the new high-water timestamp and record the ids sitting at exactly that ts.
      const newMax = fresh[fresh.length - 1]!.timestamp;
      if (newMax > this.lastTs) {
        this.lastTs = newMax;
        this.idsAtLastTs = new Set(fresh.filter((r) => r.timestamp === newMax).map((r) => r.id));
      } else {
        // newMax === lastTs (only boundary rows were added): extend the id set at that timestamp.
        for (const r of fresh) if (r.timestamp === this.lastTs) this.idsAtLastTs.add(r.id);
      }
      this.persistMarker();
    } catch (e) {
      // NEVER propagate: the archive is a convenience, finality is not.
      try { log.warn(`history archive: append failed (${(e as Error).message}); skipped`); } catch { /* */ }
    }
  }

  /**
   * Stream the archive file (it can grow large, so never load it whole) and return one filtered, paginated
   * page plus the total number of matching rows. Filters: address (matches from OR to), fromTs/toTs (inclusive
   * on the row timestamp). Order is file order (chronological, oldest-first). Best-effort: a missing file or a
   * malformed line yields an empty/partial result rather than throwing.
   */
  async read(query: ArchiveQuery = {}): Promise<ArchivePage> {
    const address = query.address ?? null;
    const fromTs = query.fromTs ?? null;
    const toTs = query.toTs ?? null;
    const offset = Math.max(0, Math.floor(query.offset ?? 0));
    const limit = Math.max(0, Math.min(ARCHIVE_MAX_LIMIT, Math.floor(query.limit ?? 100)));
    const rows: LedgerEntry[] = [];
    let total = 0;
    if (!existsSync(this.filePath)) return { rows, total };
    try {
      const stream = createReadStream(this.filePath, { encoding: "utf8" });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of rl) {
          if (!line) continue;
          let e: LedgerEntry;
          try { e = JSON.parse(line); } catch { continue; }  // skip a malformed/torn line
          if (!e || typeof e.timestamp !== "number") continue;
          if (address && e.from !== address && e.to !== address) continue;
          if (fromTs !== null && e.timestamp < fromTs) continue;
          if (toTs !== null && e.timestamp > toTs) continue;
          const idx = total;   // 0-based index among matches, in file order
          total += 1;
          if (idx >= offset && rows.length < limit) rows.push(e);
        }
      } finally {
        rl.close();
        stream.destroy();
      }
    } catch (e) {
      try { log.warn(`history archive: read failed (${(e as Error).message}); returning partial page`); } catch { /* */ }
    }
    return { rows, total };
  }
}
