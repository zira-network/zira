// node/src/models/ModelStore.ts
// Content addressed storage for model files. A model is identified by the sha256 of its bytes, so
// any peer can verify a model it received is exactly the one announced. Files are read and written
// in chunks so large models stream between peers and downloads can resume.
import { createHash } from "node:crypto";
import {
  mkdirSync, existsSync, statSync, readFileSync, writeFileSync, openSync, readSync, closeSync,
  createReadStream, createWriteStream, renameSync, readdirSync, writeSync, rmSync,
} from "node:fs";
import { join } from "node:path";
import type { ModelMeta } from "./types.js";
import { MODEL_CHUNK_BYTES } from "./types.js";
import { defaultDomainsForModelType, type ModelType } from "@zira/protocol";

type ImportOpts = {
  arch?: string; quant?: string; url?: string;
  type?: ModelType; domains?: ModelMeta["domains"]; tags?: string[]; version?: number; assigned?: boolean;
  /** Hard cap headroom for a URL import: refuse/abort if the download would exceed this many bytes.
   * <=0 or unset means the caller enforces the cap and this download is unbounded here. */
  maxBytes?: number;
};
/** Fill in a model's modality + routing domains so every stored model is type+domain addressable.
 * Models registered without a type default to "text"; without domains, to the type's default domains. */
function normalizeModelType(opts: { type?: ModelType; domains?: ModelMeta["domains"] }): { type: ModelType; domains: ModelMeta["domains"] } {
  const type: ModelType = opts.type ?? "text";
  const domains = opts.domains && opts.domains.length ? opts.domains : defaultDomainsForModelType(type);
  return { type, domains };
}

const DOWNLOAD_RANGE_BYTES = 64 * 1024 * 1024;

export class ModelStore {
  private dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, "models");
    mkdirSync(this.dir, { recursive: true });
  }

  private modelDir(id: string): string { return join(this.dir, id); }
  private dataPath(id: string): string { return join(this.modelDir(id), "data.gguf"); }
  private metaPath(id: string): string { return join(this.modelDir(id), "meta.json"); }
  private partPath(id: string): string { return join(this.modelDir(id), "data.part"); }
  private progressPath(id: string): string { return join(this.modelDir(id), "progress.json"); }

  has(id: string): boolean { return existsSync(this.dataPath(id)); }
  hasValidGguf(id: string): boolean { return this.has(id) && ModelStore.isGgufFile(this.dataPath(id)); }
  meta(id: string): ModelMeta | null {
    try { return JSON.parse(readFileSync(this.metaPath(id), "utf8")); } catch { return null; }
  }
  pathOf(id: string): string { return this.dataPath(id); }
  list(): ModelMeta[] {
    const out: ModelMeta[] = [];
    try {
      for (const entry of readdirSync(this.dir)) {
        const m = this.meta(entry);
        if (m && this.hasValidGguf(entry)) out.push(m);
      }
    } catch { /* none */ }
    return out;
  }
  totalBytes(): number {
    return this.list().reduce((sum, m) => sum + (m.sizeBytes ?? 0), 0);
  }

  /** Bytes of models currently DOWNLOADING (partial .part files not yet finalized). totalBytes() counts
   * only finished models, so during a multi-minute fetch the cap looks frozen at 0; this exposes real
   * progress so the UI shows the download moving instead of "0 B". Covers both the per-model P2P partial
   * (models/<id>/data.part) and the URL-import partial (models/dl-*.part). */
  downloadingBytes(): number {
    let n = 0;
    try {
      for (const entry of readdirSync(this.dir)) {
        try {
          if (entry.startsWith("dl-") && entry.endsWith(".part")) { n += statSync(join(this.dir, entry)).size; continue; }
          const p = this.partPath(entry);
          if (existsSync(p)) n += statSync(p).size;
        } catch { /* skip an entry that vanished mid-scan */ }
      }
    } catch { /* models dir not readable yet */ }
    return n;
  }

  /** ACTUAL bytes on disk under the models dir: finalized models + in-flight .part + dl-*.part +
   * any orphaned/stray files. This is what the storage cap MUST be enforced against. totalBytes()
   * counts only finalized models, so real disk can overshoot the cap by the in-flight/orphan amount. */
  diskBytes(): number { return ModelStore.dirSize(this.dir); }
  private static dirSize(dir: string): number {
    let n = 0;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return 0; }
    for (const e of entries) {
      const p = join(dir, e);
      try {
        const st = statSync(p);
        if (st.isDirectory()) n += ModelStore.dirSize(p);
        else n += st.size;
      } catch { /* vanished mid-scan */ }
    }
    return n;
  }

  /** Reclaim disk that no model owns: abandoned URL-import temps (dl-*.part older than the grace
   * window), stray non-model files at the models root, and whole model dirs whose id is neither a
   * known model (keepIds) nor an active download (activeIds). Never touches a kept or downloading
   * model. Returns bytes reclaimed. This is what keeps a failed/partial download from leaking disk
   * forever (importUrl/finalize can die mid-flight and totalBytes never sees those bytes). */
  sweepOrphans(keepIds: Set<string>, activeIds: Set<string>, tmpGraceMs = 60 * 60 * 1000): number {
    let freed = 0;
    let entries: string[] = [];
    try { entries = readdirSync(this.dir); } catch { return 0; }
    const now = Date.now();
    for (const entry of entries) {
      const p = join(this.dir, entry);
      try {
        const st = statSync(p);
        if (!st.isDirectory()) {
          // stray file at the models root. URL-import temps (dl-*.part) get a grace window in case a
          // download is in progress; anything else at the root is junk and reclaimed immediately.
          const isTmp = entry.startsWith("dl-") && entry.endsWith(".part");
          if (isTmp && (now - st.mtimeMs) < tmpGraceMs) continue;
          freed += st.size; rmSync(p, { force: true });
          continue;
        }
        // model dir keyed by content id === entry name.
        if (keepIds.has(entry) || activeIds.has(entry)) continue;
        // NEVER sweep a dir that holds a real finalized model, even if the caller did not list it in keepIds
        // (a node can hold a valid model that is not in the registry map, e.g. a freshly-imported fixture or
        // a model held before its announce is processed). Cap eviction (enforceStorageCap) is what removes
        // real over-cap models; the sweep only reclaims genuine junk (partials/temps/unknown dirs).
        if (this.hasValidGguf(entry)) continue;
        freed += ModelStore.dirSize(p);
        rmSync(p, { recursive: true, force: true });
      } catch { /* skip an entry that vanished mid-scan */ }
    }
    return freed;
  }

  /** Evict a cached model's heavy bytes (and any partial download) to free storage. Keeps the tiny
   * manifest sibling untouched: the model stays field-known and re-fetchable, only its bytes are dropped.
   * Returns true if bytes were present and removed. Best-effort and safe to call when nothing is cached. */
  remove(id: string): boolean {
    const had = this.has(id) || existsSync(this.partPath(id));
    try { rmSync(this.dataPath(id), { force: true }); } catch { /* */ }
    try { rmSync(this.partPath(id), { force: true }); } catch { /* */ }
    try { rmSync(this.progressPath(id), { force: true }); } catch { /* */ }
    return had;
  }

  /** Hash a file's bytes (sha256 hex), streaming so large files do not blow memory. */
  static async hashFile(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const h = createHash("sha256");
      const s = createReadStream(path);
      s.on("data", (d) => h.update(d));
      s.on("end", () => resolve(h.digest("hex")));
      s.on("error", reject);
    });
  }
  static isGgufFile(path: string): boolean {
    try {
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(4);
        return readSync(fd, buf, 0, 4, 0) === 4 && buf.toString("utf8") === "GGUF";
      } finally { closeSync(fd); }
    } catch { return false; }
  }
  private static explainInvalidGguf(preview: Buffer, source: string): string {
    const text = preview.toString("utf8").trimStart().slice(0, 240).toLowerCase();
    if (text.startsWith("version https://git-lfs.github.com/spec/v1")) {
      return "The URL returned a Git LFS pointer, not the model bytes. Use the direct Hugging Face resolve/download URL for the .gguf file.";
    }
    if (text.startsWith("<!doctype") || text.startsWith("<html") || text.includes("<html")) {
      return "The URL returned an HTML page, not a GGUF file. Use a direct raw .gguf download link.";
    }
    if (source && !source.toLowerCase().includes(".gguf")) {
      return "The downloaded file is not a GGUF model. Use a direct URL ending in .gguf or a provider URL that returns GGUF bytes.";
    }
    return "The downloaded file is not a valid GGUF model. The first bytes must be GGUF.";
  }
  private static assertGgufPreview(preview: Buffer, source: string): void {
    if (preview.length < 4 || preview.subarray(0, 4).toString("utf8") !== "GGUF") {
      throw new Error(ModelStore.explainInvalidGguf(preview, source));
    }
  }

  /** Import a local GGUF file into the store, returning its content addressed meta. */
  async importFile(localPath: string, name: string, opts: ImportOpts = {}): Promise<ModelMeta> {
    if (!existsSync(localPath)) throw new Error("file not found: " + localPath);
    if (!ModelStore.isGgufFile(localPath)) throw new Error("file is not a valid GGUF model. The first bytes must be GGUF.");
    const size = statSync(localPath).size;
    const id = await ModelStore.hashFile(localPath);
    const { type, domains } = normalizeModelType(opts);
    const meta: ModelMeta = {
      id, name, arch: opts.arch, quant: opts.quant, url: opts.url, type, domains, tags: opts.tags, version: opts.version, assigned: opts.assigned, sizeBytes: size,
      chunkSize: MODEL_CHUNK_BYTES, chunkCount: Math.ceil(size / MODEL_CHUNK_BYTES), ts: Date.now(),
    };
    mkdirSync(this.modelDir(id), { recursive: true });
    if (!this.has(id)) {
      // copy by streaming
      await new Promise<void>((resolve, reject) => {
        const rs = createReadStream(localPath);
        const ws = createWriteStream(this.dataPath(id));
        rs.on("error", reject); ws.on("error", reject); ws.on("finish", () => resolve());
        rs.pipe(ws);
      });
    }
    writeFileSync(this.metaPath(id), JSON.stringify(meta, null, 2));
    return meta;
  }

  /**
   * Download a GGUF from a URL into the store, content addressing it by the sha256 of the bytes.
   * Streams to disk and hashes as it goes, so very large models do not blow memory.
   */
  async importUrl(url: string, name: string, opts: ImportOpts = {}): Promise<ModelMeta> {
    const tmp = join(this.dir, `dl-${Date.now()}.part`);
    let promoted = false;
    try {
      const h = createHash("sha256");
      let size = 0;
      let preview = Buffer.alloc(0);
      // Optional cap headroom guard: if the announced size already exceeds what the caller says is
      // free under the cap, refuse before downloading a single byte (defends the hard cap against a
      // download that would overshoot it). maxBytes<=0 means "no limit here" (caller enforces).
      const head = await fetch(url, { method: "HEAD" });
      const expectedSize = Number(head.headers.get("content-length") ?? 0);
      const acceptsRanges = (head.headers.get("accept-ranges") ?? "").toLowerCase().includes("bytes");
      if (opts.maxBytes && opts.maxBytes > 0 && expectedSize > 0 && expectedSize > opts.maxBytes) {
        throw new Error(`model is ${expectedSize} bytes but only ${opts.maxBytes} bytes fit under the storage cap`);
      }

      if (head.ok && expectedSize > 0 && acceptsRanges) {
        const fd = openSync(tmp, "w");
        try {
          for (let start = 0; start < expectedSize; start += DOWNLOAD_RANGE_BYTES) {
            const end = Math.min(start + DOWNLOAD_RANGE_BYTES - 1, expectedSize - 1);
            const res = await fetch(url, { headers: { range: `bytes=${start}-${end}` } });
            if (res.status !== 206) throw new Error(`could not download model range ${start}-${end} (status ${res.status})`);
            const buf = Buffer.from(await res.arrayBuffer());
            if (preview.length < 4096) preview = Buffer.concat([preview, buf]).subarray(0, 4096);
            h.update(buf);
            writeSync(fd, buf, 0, buf.length, start);
            size += buf.length;
            // mid-download hard-cap abort (covers a wrong/absent content-length that under-projected).
            if (opts.maxBytes && opts.maxBytes > 0 && size > opts.maxBytes) {
              throw new Error(`download exceeded the storage cap headroom (${opts.maxBytes} bytes)`);
            }
          }
        } finally {
          closeSync(fd);
        }
      } else {
        const res = await fetch(url);
        if (!res.ok || !res.body) throw new Error(`could not download model (status ${res.status})`);
        const ws = createWriteStream(tmp);
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (preview.length < 4096) preview = Buffer.concat([preview, Buffer.from(value)]).subarray(0, 4096);
            h.update(value);
            size += value.length;
            if (opts.maxBytes && opts.maxBytes > 0 && size > opts.maxBytes) {
              throw new Error(`download exceeded the storage cap headroom (${opts.maxBytes} bytes)`);
            }
            if (!ws.write(Buffer.from(value))) await new Promise<void>((r) => ws.once("drain", () => r()));
          }
        } finally {
          await new Promise<void>((r) => ws.end(() => r()));
        }
      }
      ModelStore.assertGgufPreview(preview, url);
      const id = h.digest("hex");
      const { type, domains } = normalizeModelType(opts);
      const meta: ModelMeta = {
        id, name, arch: opts.arch, quant: opts.quant, url, type, domains, tags: opts.tags, version: opts.version, assigned: opts.assigned,
        sizeBytes: size, chunkSize: MODEL_CHUNK_BYTES, chunkCount: Math.ceil(size / MODEL_CHUNK_BYTES), ts: Date.now(),
      };
      mkdirSync(this.modelDir(id), { recursive: true });
      if (!this.has(id)) { renameSync(tmp, this.dataPath(id)); promoted = true; }
      writeFileSync(this.metaPath(id), JSON.stringify(meta, null, 2));
      return meta;
    } finally {
      // Guarantee the temp never leaks: on any throw, or when the id was already cached (dedup), the
      // tmp was never promoted, so reclaim it here. A successful rename leaves nothing to remove.
      if (!promoted) { try { rmSync(tmp, { force: true }); } catch { /* */ } }
    }
  }

  readChunk(id: string, index: number): Buffer {
    const meta = this.meta(id);
    if (!meta) throw new Error("unknown model " + id);
    const fd = openSync(this.dataPath(id), "r");
    try {
      const start = index * meta.chunkSize;
      const len = Math.min(meta.chunkSize, meta.sizeBytes - start);
      const buf = Buffer.alloc(Math.max(0, len));
      if (len > 0) readSync(fd, buf, 0, len, start);
      return buf;
    } finally { closeSync(fd); }
  }

  // ---- receiving a model from peers ----

  beginDownload(meta: ModelMeta): void {
    mkdirSync(this.modelDir(meta.id), { recursive: true });
    writeFileSync(this.metaPath(meta.id), JSON.stringify(meta, null, 2));
    if (!existsSync(this.partPath(meta.id))) writeFileSync(this.partPath(meta.id), Buffer.alloc(0));
    if (!existsSync(this.progressPath(meta.id))) writeFileSync(this.progressPath(meta.id), JSON.stringify([]));
  }

  receivedChunks(id: string): Set<number> {
    try { return new Set(JSON.parse(readFileSync(this.progressPath(id), "utf8"))); } catch { return new Set(); }
  }

  writeChunk(id: string, index: number, data: Uint8Array): void {
    const meta = this.meta(id);
    if (!meta) throw new Error("no meta for " + id);
    const fd = openSync(this.partPath(id), "r+");
    try {
      writeSync(fd, Buffer.from(data), 0, data.length, index * meta.chunkSize);
    } finally { closeSync(fd); }
    const got = this.receivedChunks(id);
    got.add(index);
    writeFileSync(this.progressPath(id), JSON.stringify([...got]));
  }

  isComplete(id: string): boolean {
    const meta = this.meta(id);
    if (!meta) return false;
    return this.receivedChunks(id).size >= meta.chunkCount;
  }

  /** Verify the downloaded part matches the content address, then promote it to the live file. */
  async finalize(id: string): Promise<boolean> {
    if (!this.isComplete(id)) return false;
    const hash = await ModelStore.hashFile(this.partPath(id));
    if (hash !== id) return false;
    if (!ModelStore.isGgufFile(this.partPath(id))) return false;
    renameSync(this.partPath(id), this.dataPath(id));
    return true;
  }
}
