// node/src/models/ModelService.ts
// The peer to peer model field. Models are authorized by the founder: only a model the founder has
// signed enters the field. Any node that holds the file may serve it to others (so distribution is
// still peer to peer and scalable), but not just anyone can introduce a model. For miners, this
// loads a model into the inference engine to answer the field.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { freemem, totalmem } from "node:os";
import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { canonical, sign as edSign, verify as edVerify, addressFromPubKey, defaultDomainsForModelType, modelServesDomain, preferredModelTypeForDomain, type Domain, type ModelType, type Keypair, type Address } from "@zira/protocol";
import type { ZiraNetwork } from "../p2p/Network.js";
import { ModelStore } from "./ModelStore.js";
import { Inference } from "./Inference.js";
import { chat } from "../provider/inference.js";
import { MODEL_PROTOCOL, DEFAULT_MINING, STORAGE_DEFAULT_CAP_BYTES, type ModelMeta, type ModelAnnounce, type MiningConfig } from "./types.js";
import { log } from "../log.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

interface RegistryEntry {
  meta: ModelMeta;
  founderPubKey: string;
  manifestSig: string;
  peerIds: Set<string>;
  hosts: Set<string>;
  local: boolean;
}

// Target number of live (connected) replicas per authorized model across the field. Storage peers fetch
// under-replicated models first and stop adding copies once a model has this many connected holders, so a
// large catalog (the steward adds models over time) SPREADS across many peers — each holds a subset, ~this
// many copies each — instead of every peer trying to clone the whole catalog. A mining node still always
// keeps one servable model regardless. Tunable via ZIRA_MODEL_REPLICATION.
const MODEL_REPLICATION_TARGET = Math.max(1, Number(process.env.ZIRA_MODEL_REPLICATION || 3));

export class ModelService {
  private store: ModelStore;
  private inference = new Inference();
  private registry = new Map<string, RegistryEntry>();
  private storageFetches = new Set<string>();
  private mining: MiningConfig;
  private miningPath: string;
  private engineUnavailableLogged = false;

  constructor(
    private dataDir: string,
    private net: ZiraNetwork,
    private identity: Keypair,
    founderAddresses: Address | (() => Address[]),
    private announce: (a: ModelAnnounce) => void,
    private launchModels: ModelAnnounce[] = [],
  ) {
    this.founderAddresses = typeof founderAddresses === "function" ? founderAddresses : () => [founderAddresses];
    this.store = new ModelStore(dataDir);
    this.miningPath = join(dataDir, "mining.json");
    this.mining = this.loadMining();
  }
  private founderAddresses: () => Address[];

  /** Whether this node has active launch authority and may introduce a model. */
  isFounder(): boolean { return this.founderAddresses().includes(this.identity.address); }

  init(): void {
    this.net.handle(MODEL_PROTOCOL, (req) => this.serve(req));
    // re-load any model authorizations we saved, so we can re-announce models we already host
    for (const meta of this.store.list()) {
      const mani = this.loadManifest(meta.id);
      if (mani) this.trackLocal(meta, mani.founderPubKey, mani.manifestSig);
    }
    // Register the genesis-authorized launch models (founder-signed at genesis) — but only on a SERVING node
    // (mining enabled). onAnnounce verifies the signature against the launch-authority set; the node then
    // fetches the bytes (peer-first, else the source URL), loads, and serves them, so the field has a baseline
    // model without any live founder announce — this is what lets the VPS miner and any joining miner serve
    // and earn. We deliberately keep it OFF pure storage/consensus coordinators: fetching + hashing a multi-GB
    // model is CPU-heavy and would starve their checkpoint voting, so they stay free to finalize.
    if (this.mining.enabled || this.mining.storageEnabled) this.registerLaunchModels();
    // On restart, reconcile heavy storage against the persisted cap before doing anything else: evict
    // anything over the cap or held while disabled, so the persisted runtime state is authoritative.
    this.enforceStorageCap();
    this.announceLocal();
    if (this.mining.enabled) { if (this.mining.mode === "auto") void this.reconcileAuto(); else if (this.mining.modelId) void this.loadIfReady(); }
    else if (this.mining.ownTaskInference) void this.ensureOwnTaskModel();
  }

  /**
   * Register the genesis-authorized launch models into the registry (founder-signed, verified by onAnnounce).
   * This only adds metadata — fetching the bytes stays gated behind reconcileStorage/reconcileAuto — so it is
   * safe to call whenever mining or storage turns on. Crucially it must run when mining is enabled AT RUNTIME
   * (not only at startup), otherwise a node that starts with mining off and the user enables it later never
   * learns the launch model id, never serves or replicates it, and so never earns. Idempotent (onAnnounce
   * de-dupes by id), so calling it repeatedly is harmless.
   */
  private registerLaunchModels(): void {
    for (const a of this.launchModels) { try { this.onAnnounce(a); } catch { /* a malformed bake is non-fatal */ } }
  }

  // ---- announcements ----

  announceLocal(): void {
    for (const e of this.registry.values()) {
      if (e.local) this.announce(this.makeAnnounce(e));
    }
  }
  /**
   * Re-broadcast every authority-signed model this node knows, not just the ones whose bytes are
   * local. The launch authority authorizes a model link before any node holds the GGUF, so the model
   * is field-known but not yet `local` anywhere; with only `announceLocal` re-gossiping, a late-joining
   * node (e.g. the desktop app's own node bootstrapping off a co-located mesh) would render an empty
   * model field forever. Re-announcing carries the original founder signature, so receivers still
   * verify it via onAnnounce and reject anything unsigned; it is idempotent (de-duped by peerId).
   * Only the active launch authority re-broadcasts, keeping field gossip cheap and trust-anchored.
   */
  reannounceField(): void {
    if (!this.isFounder()) return;
    for (const e of this.registry.values()) {
      if (e.founderPubKey && e.manifestSig) this.announce(this.makeAnnounce(e));
    }
  }
  private makeAnnounce(e: RegistryEntry): ModelAnnounce {
    return { meta: e.meta, founderPubKey: e.founderPubKey, manifestSig: e.manifestSig, peerId: this.net.peerId(), host: this.identity.address, ts: Date.now() };
  }

  /** Accept an announcement only if active launch authority signed the model. Then record who serves it. */
  onAnnounce(a: ModelAnnounce): boolean {
    if (!this.founderAddresses().includes(addressFromPubKey(a.founderPubKey))) {
      log.debug("rejected model announce: not authorized by the launch authority set");
      return false;
    }
    if (!edVerify(canonical(a.meta as unknown as Record<string, unknown>), a.manifestSig, a.founderPubKey)) {
      log.debug("rejected model announce: bad launch-authority signature");
      return false;
    }
    let e = this.registry.get(a.meta.id);
    if (!e) {
      e = { meta: a.meta, founderPubKey: a.founderPubKey, manifestSig: a.manifestSig, peerIds: new Set(), hosts: new Set(), local: false };
      this.registry.set(a.meta.id, e);
    } else if ((a.meta.version ?? 0) > (e.meta.version ?? 0)) {
      // Adopt a newer authorized revision of the same model id (e.g. a steward deprecation or metadata
      // update). Signature already verified above, so this is an authenticated meta change.
      e.meta = a.meta; e.founderPubKey = a.founderPubKey; e.manifestSig = a.manifestSig;
    }
    const fresh = !e.peerIds.has(a.peerId);
    e.peerIds.add(a.peerId);
    e.hosts.add(a.host);
    if (a.peerId && a.peerId !== "genesis" && /^zir1[0-9a-z]{6,}$/.test(a.host)) this.serverAddr.set(a.peerId, a.host);
    else log.debug(`model announce kept peerId=${String(a.peerId).slice(0, 12)} host=${String(a.host).slice(0, 16)} (no serverAddr mapping)`);
    if (fresh && this.mining.storageEnabled) void this.reconcileStorage();
    return fresh;
  }

  // libp2p peer -> the ZIR address that announced it serves a model, so a storage probe can attribute a
  // verified result to a ledger account. Populated from signed model announces.
  private serverAddr = new Map<string, string>();

  /** The id of an authorized model this node holds locally and can verify probes against, or null. */
  localHeldModelId(): string | null {
    for (const e of this.registry.values()) if (this.store.hasValidGguf(e.meta.id)) return e.meta.id;
    return null;
  }

  /** (peerId, ZIR address) of OTHER nodes that announced they serve the given model. Excludes self. */
  peersServing(modelId: string): { peerId: string; address: string }[] {
    const e = this.registry.get(modelId);
    if (!e) return [];
    const mine = this.net.peerId();
    const out: { peerId: string; address: string }[] = [];
    for (const peerId of e.peerIds) {
      if (peerId === mine || peerId === "genesis") continue;
      const address = this.serverAddr.get(peerId);
      if (address && address !== this.identity.address) out.push({ peerId, address });
    }
    return out;
  }

  /**
   * Storage probe: request a random chunk of a model this node ALSO holds from `peerId`, and verify the
   * returned bytes byte-for-byte against the local copy. Only a node that genuinely stores the chunk can
   * return it, so this proves the peer holds the model (a real ~hundreds-of-MB cost), which is what makes
   * the work credit it earns sybil-resistant. Best-effort: any error or mismatch is a clean false.
   */
  async verifyPeerStorage(peerId: string, modelId: string): Promise<boolean> {
    if (!this.store.hasValidGguf(modelId)) return false;     // must hold it myself to verify
    const meta = this.store.meta(modelId);
    if (!meta || meta.chunkCount <= 0) return false;
    const index = Math.floor(Math.random() * meta.chunkCount);
    try {
      const frames = await this.net.request(peerId, MODEL_PROTOCOL, enc.encode(JSON.stringify({ id: modelId, index })), 8_000);
      const got = frames[0];
      const mine = new Uint8Array(this.store.readChunk(modelId, index));
      if (!got || got.length !== mine.length || mine.length === 0) return false;
      for (let i = 0; i < mine.length; i++) if (got[i] !== mine[i]) return false;
      return true;
    } catch { return false; }
  }

  private trackLocal(meta: ModelMeta, founderPubKey: string, manifestSig: string): RegistryEntry {
    let e = this.registry.get(meta.id);
    if (!e) { e = { meta, founderPubKey, manifestSig, peerIds: new Set(), hosts: new Set(), local: false }; this.registry.set(meta.id, e); }
    e.local = true;
    e.founderPubKey = founderPubKey;
    e.manifestSig = manifestSig;
    e.peerIds.add(this.net.peerId());
    e.hosts.add(this.identity.address);
    return e;
  }

  // ---- serving chunks ----

  private async *serve(req: Uint8Array): AsyncIterable<Uint8Array> {
    let r: { id: string; index?: number };
    try { r = JSON.parse(dec.decode(req)); } catch { return; }
    if (!this.isFounder() && !this.mining.storageEnabled) return;
    if (!this.store.hasValidGguf(r.id)) return;
    if (r.index === undefined) { const meta = this.store.meta(r.id); if (meta) yield enc.encode(JSON.stringify(meta)); return; }
    yield new Uint8Array(this.store.readChunk(r.id, r.index));
  }

  // ---- providing a model (founder only) ----

  /** Launch authority signs a model meta, records it, and announces it to the field. */
  private authorizeAndAnnounce(meta: ModelMeta): ModelMeta {
    const manifestSig = edSign(canonical(meta as unknown as Record<string, unknown>), this.identity.privateKey);
    this.saveManifest(meta.id, { founderPubKey: this.identity.publicKey, manifestSig });
    const e = this.trackLocal(meta, this.identity.publicKey, manifestSig);
    this.announce(this.makeAnnounce(e));
    return meta;
  }

  private isAuthorizedFounderPubKey(pubKey: string): boolean {
    try { return this.founderAddresses().includes(addressFromPubKey(pubKey)); }
    catch { return false; }
  }

  private verifyFounderSigned(value: unknown, sig: string, pubKey: string): void {
    if (!this.isAuthorizedFounderPubKey(pubKey)) throw new Error("only active launch authority can add a model to the field");
    if (!edVerify(canonical(value as Record<string, unknown>), sig, pubKey)) throw new Error("launch-authority signature did not verify");
  }

  /** Wallet-authorized path: prove the request before the node downloads and hashes the model. */
  async prepareByUrl(input: { url: string; name: string; arch?: string; quant?: string; type?: ModelType; domains?: ModelMeta["domains"]; tags?: string[]; version?: number; ts: number }, founderPubKey: string, requestSig: string): Promise<ModelMeta> {
    this.verifyFounderSigned(input, requestSig, founderPubKey);
    log.info(`launch-authority wallet authorized model preparation ${input.name}, downloading to hash...`);
    return this.store.importUrl(input.url, input.name, { arch: input.arch, quant: input.quant, type: input.type, domains: input.domains, tags: input.tags, version: input.version });
  }

  /** Wallet-authorized path: authorize the exact content-addressed model meta after hashing. */
  authorizePrepared(meta: ModelMeta, founderPubKey: string, manifestSig: string): ModelMeta {
    if (!this.store.hasValidGguf(meta.id)) throw new Error("prepared model bytes are not a valid GGUF on this node");
    this.verifyFounderSigned(meta, manifestSig, founderPubKey);
    this.saveManifest(meta.id, { founderPubKey, manifestSig });
    const e = this.trackLocal(meta, founderPubKey, manifestSig);
    this.announce(this.makeAnnounce(e));
    log.info(`launch-authority wallet authorized model ${meta.name} (${meta.id.slice(0, 12)}, ${(meta.sizeBytes / 1e6).toFixed(1)} MB)`);
    return meta;
  }

  /** Launch-authority only: add a model from a local GGUF file. */
  async provide(localPath: string, name: string, opts: { arch?: string; quant?: string; url?: string; type?: ModelType; domains?: ModelMeta["domains"]; tags?: string[]; version?: number; assigned?: boolean } = {}): Promise<ModelMeta> {
    if (!this.isFounder()) throw new Error("only active launch authority can add a model to the field");
    const meta = await this.store.importFile(localPath, name, opts);
    this.authorizeAndAnnounce(meta);
    log.info(`launch authority added model ${name} from a file (${meta.id.slice(0, 12)}, ${(meta.sizeBytes / 1e6).toFixed(1)} MB)`);
    return meta;
  }

  /** Launch-authority only: add a model by link. The node downloads it once, hashes it, signs it, and the
   * field then distributes it peer to peer with the link as a fallback source. */
  async provideByUrl(url: string, name: string, opts: { arch?: string; quant?: string; type?: ModelType; domains?: ModelMeta["domains"]; tags?: string[]; version?: number; assigned?: boolean } = {}): Promise<ModelMeta> {
    if (!this.isFounder()) throw new Error("only active launch authority can add a model to the field");
    log.info(`launch authority adding model ${name} by link, downloading to hash and sign...`);
    const meta = await this.store.importUrl(url, name, opts);
    this.authorizeAndAnnounce(meta);
    log.info(`launch authority added model ${name} by link (${meta.id.slice(0, 12)}, ${(meta.sizeBytes / 1e6).toFixed(1)} MB)`);
    return meta;
  }

  // ---- fetching a model: a peer first (swarm), then the authorized source link as fallback ----

  async fetch(id: string): Promise<boolean> {
    if (this.store.hasValidGguf(id)) return true;
    const entry = this.registry.get(id);
    if (!entry) throw new Error("unknown model");

    // 0) Reliable bootstrap: if the model has an authorized source link, fetch from it FIRST. P2P chunk
    //    transfer from NAT'd home machines to the coordinators is unreliable at launch — a peer accepts the
    //    stream then never sends bytes, so the download would stall at 0 B for minutes. The link is the
    //    authoritative, hash-verified source (importUrl rejects a mismatched file), so this makes "enable
    //    Mine -> hold the model" actually work for every new user. Peers still serve each other afterward for
    //    redundancy and the storage bonus; models WITHOUT a link fall straight to the P2P path below.
    if (entry.meta.url) {
      try {
        const meta = await this.store.importUrl(entry.meta.url, entry.meta.name, { arch: entry.meta.arch, quant: entry.meta.quant, type: entry.meta.type, domains: entry.meta.domains, tags: entry.meta.tags, version: entry.meta.version });
        if (meta.id === id) return this.adopt(id, entry, "the link");
        log.warn(`model link content did not match the authorized hash; trying peers instead`);
      } catch (e) { log.debug("link fetch failed, trying peers", (e as Error).message); }
    }

    // 1) try connected peers that have it — in turn, with per-chunk retry. Progress is saved on disk
    //    (receivedChunks), so if one peer stalls we resume from the next peer instead of abandoning a
    //    multi-GB transfer back to a full re-download. This is what makes big-model P2P distribution
    //    reliable across flaky links and churning peers.
    const connected = new Set(this.net.peers());
    const peers = [...entry.peerIds].filter((p) => connected.has(p));
    for (const peer of peers) {
      try {
        const manFrames = await this.net.request(peer, MODEL_PROTOCOL, enc.encode(JSON.stringify({ id })), 12_000);
        const meta: ModelMeta = JSON.parse(dec.decode(manFrames[0]!));
        if (meta.id !== id) continue;
        this.store.beginDownload(meta);
        const have = this.store.receivedChunks(id);
        let complete = true;
        for (let i = 0; i < meta.chunkCount; i++) {
          if (have.has(i)) continue;
          let chunk: Uint8Array | undefined;
          for (let attempt = 0; attempt < 3 && !chunk; attempt++) {
            try { const frames = await this.net.request(peer, MODEL_PROTOCOL, enc.encode(JSON.stringify({ id, index: i })), 20_000); chunk = frames[0]; }
            catch { /* transient; retry, then fall through to the next peer */ }
          }
          if (!chunk) { complete = false; break; } // this peer stalled on a chunk; resume from another peer
          this.store.writeChunk(id, i, chunk);
        }
        if (complete && await this.store.finalize(id)) return this.adopt(id, entry, "a peer");
      } catch (e) { log.debug(`peer fetch from ${peer.slice(0, 8)} failed, trying the next source`, (e as Error).message); }
    }

    // 2) fall back to the authorized source link
    if (entry.meta.url) {
      const meta = await this.store.importUrl(entry.meta.url, entry.meta.name, { arch: entry.meta.arch, quant: entry.meta.quant, type: entry.meta.type, domains: entry.meta.domains, tags: entry.meta.tags, version: entry.meta.version });
      if (meta.id !== id) throw new Error("the link's content does not match the authorized model hash");
      return this.adopt(id, entry, "the link");
    }
    throw new Error("no peer is serving this model and it has no link");
  }

  private adopt(id: string, entry: RegistryEntry, source: string): boolean {
    this.saveManifest(id, { founderPubKey: entry.founderPubKey, manifestSig: entry.manifestSig });
    const e = this.trackLocal(entry.meta, entry.founderPubKey, entry.manifestSig);
    this.announce(this.makeAnnounce(e));
    log.info(`fetched model ${entry.meta.name} from ${source}`);
    return true;
  }

  // ---- auto, model agnostic mining: the node runs the authorized field model for the miner ----

  /** The modality of a stored model, defaulting legacy metas (no type) to text. */
  private modelType(meta: ModelMeta): ModelType { return meta.type ?? "text"; }
  /** The routing domains of a stored model: its declared domains, or its type's defaults. */
  private modelDomains(meta: ModelMeta): Domain[] {
    return meta.domains && meta.domains.length ? meta.domains : defaultDomainsForModelType(this.modelType(meta));
  }

  /** The model an auto miner should run: the most recent authorized model matching its served domains. */
  recommendedModelId(domains: string[] = []): string | null {
    const models = [...this.registry.values()].map((e) => e.meta).sort((a, b) => (b.version ?? 0) - (a.version ?? 0) || b.ts - a.ts);
    if (models.length === 0) return null;
    const match = domains.length === 0 ? models[0] : (models.find((m) => this.modelDomains(m).some((d) => domains.includes(d))) ?? models[0]);
    return match?.id ?? null;
  }

  /** All authorized models, newest first. */
  private modelsByRecency(): ModelMeta[] {
    return [...this.registry.values()].map((e) => e.meta).sort((a, b) => (b.version ?? 0) - (a.version ?? 0) || b.ts - a.ts);
  }

  /** Models that can serve a query in `domain`, ranked so the domain's preferred TYPE comes first (a
   * code query routes to code models, vision to image, etc.), then other matching-domain models, then
   * text/other generalists. Used to route a field query/task to the right kind of model. */
  modelsForDomain(domain: Domain): ModelMeta[] {
    const preferred = preferredModelTypeForDomain(domain);
    const matches = this.modelsByRecency().filter((m) => modelServesDomain(this.modelType(m), m.domains, domain));
    return matches.sort((a, b) => {
      const at = this.modelType(a) === preferred ? 0 : 1;
      const bt = this.modelType(b) === preferred ? 0 : 1;
      if (at !== bt) return at - bt;
      return (b.version ?? 0) - (a.version ?? 0) || b.ts - a.ts;
    });
  }

  /** The best model id to answer a query in `domain` (preferred type + domain match), or the most
   * recent model as a last resort so the field still answers when nothing matches exactly. */
  modelForDomain(domain: Domain): string | null {
    const ranked = this.modelsForDomain(domain);
    if (ranked[0]) return ranked[0].id;
    return this.modelsByRecency()[0]?.id ?? null;
  }

  /** A registry view grouped by modality, for the Console model picker and routing diagnostics. */
  modelsByType(): Record<ModelType, { id: string; name: string; domains: Domain[]; tags: string[] }[]> {
    const out = {} as Record<ModelType, { id: string; name: string; domains: Domain[]; tags: string[] }[]>;
    for (const meta of this.modelsByRecency()) {
      const t = this.modelType(meta);
      (out[t] ??= []).push({ id: meta.id, name: meta.name, domains: this.modelDomains(meta), tags: meta.tags ?? [] });
    }
    return out;
  }

  /** Make sure the auto miner runs the recommended model when it already has it. Safe to call repeatedly.
   * Mining never downloads model bytes: distribution is the storage role's job (reconcileStorage, which
   * respects the storage cap). A miner only loads a model that storage has already replicated locally;
   * otherwise it coordinates/answers via its endpoint or in field-coordinator mode. This keeps mining,
   * storage, and model serving independent: a miner does not need storage or model bytes to mine. */
  async reconcileAuto(): Promise<void> {
    if (!this.mining.enabled || this.mining.mode !== "auto") return;
    // An EXTERNAL endpoint (user-configured, e.g. Ollama) makes this miner model-agnostic; our own
    // inference subprocess also sets mining.endpoint, so only bail for a non-subprocess endpoint.
    if (this.mining.endpoint && !this.endpointIsSubprocess) return;
    // Serve the best model whose bytes this node ACTUALLY holds — not the global newest. Storage only
    // replicates models that fit the cap, so a small-cap CPU node holds (and serves) the small baseline
    // while a large-cap GPU miner holds (and serves) the big model; the field coordinates across both.
    // Picking the global newest would point mining.modelId at a too-large model storage never fetched,
    // leaving a perfectly servable local model unserved (the "holds a model but never answers" bug).
    const target = this.bestLocalModelId();
    if (!target) return;
    // Mark the model we actually hold+serve as LOCAL and broadcast a real announce (peerId + our ZIR
    // address). Without this, a baked launch model stays local=false, announceLocal never advertises it,
    // and other masters can't discover us to run the storage-proof — so a genuine serving miner never gets
    // the work credit. Do it once per (re)load; announceLocal re-gossips it periodically thereafter.
    const held = this.registry.get(target);
    if (held && !held.local) {
      held.local = true;
      held.peerIds.add(this.net.peerId());
      held.hosts.add(this.identity.address);
      this.announce(this.makeAnnounce(held));
    }
    // Atomic swap: when a newer/better model has arrived locally, retire the current subprocess and let
    // the next reconcile tick respawn onto the new model (gives the inference port time to free). The old
    // served model stops being essential only after we've switched, so the cap can reclaim it cleanly.
    if (this.endpointIsSubprocess && this.servingId && this.servingId !== target) {
      log.info(`switching served model ${this.servingId.slice(0, 12)} -> ${target.slice(0, 12)}`);
      this.stopSubprocessInference();
      return;
    }
    if (this.mining.modelId !== target) { this.mining.modelId = target; this.saveMining(); }
    // Serve the GGUF from an ISOLATED subprocess and point our endpoint at it. Never native-load in this
    // process: node-llama-cpp loading/generating inside the node starves its RPC + consensus event loop.
    await this.ensureSubprocessInference(target);
  }

  /** The best model this node can SERVE right now: the newest authorized model whose GGUF bytes are held
   * locally. Storage replicates only models that fit the cap, so this is inherently resource-aware — the
   * node serves the largest/best model it could actually fit, and nothing it can't. */
  private bestLocalModelId(): string | null {
    for (const m of this.modelsByRecency()) if (!m.deprecated && this.store.hasValidGguf(m.id)) return m.id;
    return null;
  }

  /** Launch authority: retire (or reinstate) a model network-wide. Re-announces the SAME model id with a
   * higher catalog version and deprecated=true, so every node's onAnnounce adopts the change and stops
   * selecting it to serve. Fixes an incompatible model (e.g. gemma-4-e4b) crash-looping the engine without
   * any app update: existing nodes already run this selection + adoption path. Signed by the launch key. */
  async deprecateModel(id: string, deprecated = true): Promise<ModelMeta> {
    if (!this.isFounder()) throw new Error("only active launch authority can deprecate a model");
    const e = this.registry.get(id);
    if (!e) throw new Error("unknown model");
    const meta: ModelMeta = { ...e.meta, deprecated, assigned: deprecated ? false : e.meta.assigned, version: (e.meta.version ?? 1) + 1, ts: Date.now() };
    e.meta = meta;
    this.authorizeAndAnnounce(meta);
    log.info(`launch authority ${deprecated ? "deprecated" : "reinstated"} model ${meta.name} (${id.slice(0, 12)})`);
    return meta;
  }

  /** The routing domains of the model this node is currently serving — advertised to the field so queries
   * are coordinated to the right kind of model. Empty when nothing is served yet (the miner then behaves
   * as an unfiltered generalist). A model tagged "general" is treated as a generalist that still attempts
   * any query; a specialist (no "general") only answers its declared domains. */
  servingDomains(): Domain[] {
    const id = this.servingId ?? (this.mining.enabled ? this.mining.modelId : null);
    const meta = id ? this.registry.get(id)?.meta : undefined;
    return meta ? this.modelDomains(meta) : [];
  }

  // ---- isolated inference subprocess: runs node-llama-cpp in its own process (ZIRA_INFERENCE_SERVER) and
  // serves an OpenAI-compatible endpoint we point mining.endpoint at, so model load + generation never
  // touch this node's RPC/consensus loop. This is how a desktop miner serves the distributed GGUF. ----
  private inferenceProc: ChildProcess | null = null;
  private endpointIsSubprocess = false;
  private servingId: string | null = null; // model id the inference subprocess is actively serving (eviction-protected)

  private async ensureSubprocessInference(id: string): Promise<void> {
    if (this.inferenceProc || this.endpointIsSubprocess) return;       // already serving
    if (process.env.ZIRA_INFERENCE_SERVER === "1") return;             // never recurse inside the server itself
    const gguf = this.store.pathOf(id);
    if (!gguf || !this.store.hasValidGguf(id)) return;
    const entry = process.argv[1];
    if (!entry) return;
    // Derive the subprocess port from this node's RPC port so co-located nodes (e.g. the desktop app on
    // 8655 and a launch mesh on 8645) never collide on the inference port. Explicit override wins.
    const port = Number(process.env.ZIRA_INFERENCE_PORT) || (Number(process.env.ZIRA_RPC_PORT || 8645) + 31);
    log.info(`starting isolated inference subprocess for model ${id.slice(0, 12)} on 127.0.0.1:${port}`);
    // stdio "ignore": the child must not share the node's stdio handles (on Windows, inheriting them into
    // a process doing heavy native/GPU init can take the parent down). detached so the GPU work is fully
    // its own. We never block on the load: the enable-mining RPC returns immediately and the endpoint is
    // wired up in the background once the server is ready.
    const proc = spawn(process.execPath, [entry], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ZIRA_INFERENCE_SERVER: "1", ZIRA_INFERENCE_MODEL: gguf, ZIRA_INFERENCE_PORT: String(port), ZIRA_RESET: "0", ZIRA_BOOTSTRAP: "" },
      stdio: "ignore",
      windowsHide: true,
    });
    this.inferenceProc = proc;
    const killChild = () => { try { proc.kill(); } catch { /* */ } };
    process.once("exit", killChild);
    proc.on("error", (e) => { log.warn(`inference subprocess spawn error: ${(e as Error).message}`); if (this.inferenceProc === proc) this.inferenceProc = null; });
    proc.on("exit", (code) => {
      log.warn(`inference subprocess exited (code ${code})`);
      process.removeListener("exit", killChild);
      if (this.inferenceProc === proc) {
        this.inferenceProc = null;
        this.servingId = null;
        if (this.endpointIsSubprocess) { this.mining.endpoint = undefined; this.mining.endpointModel = undefined; this.endpointIsSubprocess = false; }
      }
    });
    void this.waitForPort(port, 120000).then((ok) => {
      if (ok && this.inferenceProc === proc) {
        this.mining.endpoint = `http://127.0.0.1:${port}/v1`;
        this.mining.endpointModel = this.registry.get(id)?.meta.name || id;
        this.endpointIsSubprocess = true;
        this.servingId = id;
        log.info(`inference subprocess ready; serving via ${this.mining.endpoint}`);
      } else if (!ok) {
        log.warn("inference subprocess did not become ready; staying in field-coordinator mode");
        killChild();
        if (this.inferenceProc === proc) this.inferenceProc = null;
      }
    });
  }

  private stopSubprocessInference(): void {
    if (this.inferenceProc) { try { this.inferenceProc.kill(); } catch { /* */ } this.inferenceProc = null; }
    this.servingId = null;
    if (this.endpointIsSubprocess) { this.mining.endpoint = undefined; this.mining.endpointModel = undefined; this.endpointIsSubprocess = false; }
  }

  private waitForPort(port: number, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        const req = http.get({ host: "127.0.0.1", port, path: "/", timeout: 1500 }, (res) => { res.resume(); resolve(true); });
        req.on("error", () => { if (Date.now() - start > timeoutMs) resolve(false); else setTimeout(tick, 1500); });
        req.on("timeout", () => { req.destroy(); if (Date.now() - start > timeoutMs) resolve(false); else setTimeout(tick, 1500); });
      };
      tick();
    });
  }

  /** A model id whose bytes must NOT be evicted: it is loaded for inference now, or is the mining/own-task
   * target this node serves with. Evicting it would break a live engine, so the cap spares it. */
  private isEssentialModel(id: string): boolean {
    if (this.inference.loadedModel() === id) return true;
    if (this.servingId === id) return true; // the isolated inference subprocess is actively serving this model
    if (this.mining.modelId === id && (this.mining.enabled || this.mining.ownTaskInference)) return true;
    return false;
  }

  /**
   * Enforce the heavy-storage cap. When storage is disabled, evict ALL non-essential cached bytes so a
   * disabled node holds nothing it would advertise. When enabled, evict least-recently-needed (oldest,
   * most widely-replicated, non-essential) cached models until usage is at or under the byte cap. The
   * essential model (a loaded/serving GGUF) is always kept so the engine never loses its weights. This is
   * idempotent and safe to call repeatedly; it only touches local cache bytes, never ledger state.
   */
  private enforceStorageCap(): void {
    const cap = this.storageCapBytes();
    // Cached models we actually hold bytes for, with their meta, newest first by recency for keeping.
    const cached = [...this.registry.values()]
      .filter((e) => this.store.hasValidGguf(e.meta.id))
      .map((e) => ({ id: e.meta.id, size: e.meta.sizeBytes ?? 0, providers: e.peerIds.size, ts: e.meta.ts }));
    // Eviction order: non-essential first; among those, most-replicated (safest to drop), then oldest.
    const evictable = cached
      .filter((c) => !this.isEssentialModel(c.id))
      .sort((a, b) => (b.providers - a.providers) || (a.ts - b.ts));
    let used = this.store.totalBytes();
    const overCap = () => used > cap;
    for (const c of evictable) {
      if (!this.mining.storageEnabled) {
        if (this.store.remove(c.id)) { used -= c.size; this.registry.get(c.id)!.local = false; log.info(`storage disabled: evicted cached model ${c.id.slice(0, 12)} (${(c.size / 1e9).toFixed(2)} GB)`); }
        continue;
      }
      if (!overCap()) break;
      if (this.store.remove(c.id)) { used -= c.size; this.registry.get(c.id)!.local = false; log.info(`storage cap reached (${(cap / 1e9).toFixed(2)} GB): evicted cached model ${c.id.slice(0, 12)} (${(c.size / 1e9).toFixed(2)} GB)`); }
    }
    if (this.mining.storageEnabled && overCap()) {
      log.warn(`storage usage ${(used / 1e9).toFixed(2)} GB still over the ${(cap / 1e9).toFixed(2)} GB cap; remaining cached models are in use and were kept. Raise the cap to store more.`);
    }
  }

  /** Empty the storage cache on demand: delete every cached model file the node is not actively serving
   *  (the essential loaded/serving GGUF is kept so the engine never loses its weights). Frees disk without
   *  turning storage off, so the node re-fills from the field per its cap. Returns how many models it freed. */
  clearStoredModels(): { cleared: number; freedBytes: number } {
    let cleared = 0, freedBytes = 0;
    for (const e of [...this.registry.values()]) {
      if (!this.store.hasValidGguf(e.meta.id) || this.isEssentialModel(e.meta.id)) continue;
      const size = e.meta.sizeBytes ?? 0;
      if (this.store.remove(e.meta.id)) { e.local = false; cleared++; freedBytes += size; }
    }
    if (cleared) log.info(`storage cleared on request: freed ${cleared} model(s), ${(freedBytes / 1e9).toFixed(2)} GB`);
    return { cleared, freedBytes };
  }

  /** Storage peers actively replicate authorized models so distribution is not passive, and they do it at
   * SCALE: with a large catalog, every peer holding every model neither fits nor is necessary. Each peer
   * fills UNDER-replicated models first and stops adding copies once a model already has
   * MODEL_REPLICATION_TARGET live (connected) holders, so the catalog spreads across many peers (each
   * holds a subset). A mining node always keeps at least one servable model so it can still answer.
   * Respects the byte cap (including in-flight fetches); enforces the cap first so over-cap/disabled state
   * is authoritative. Counting only CONNECTED holders makes this self-healing: as holders drop offline,
   * their models look under-replicated again and surviving peers re-fetch them. */
  async reconcileStorage(): Promise<void> {
    this.enforceStorageCap();
    // A MINING node must hold at least one servable model so it actually ANSWERS (not just coordinates) and puts
    // the hardware to work. This is ensured on "Mine on" EVEN WHEN the full storage role is off — otherwise a
    // miner heartbeats and coordinates but never serves an answer. With storage off it fetches ONLY that one
    // serving model (it is not a general replicator); with storage on it also fills replication gaps.
    const storageOn = this.mining.storageEnabled;
    let needServing = this.mining.enabled && !this.bestLocalModelId();
    if (!storageOn && !needServing) return; // storage off and either not mining or already have a servable model
    const cap = this.storageCapBytes();
    const connected = new Set(this.net.peers());
    const liveReplicas = (e: RegistryEntry): number => [...e.peerIds].filter((p) => connected.has(p)).length;
    // Serving pick is HARDWARE-AWARE: prefer the LARGEST model this machine can actually run (bigger model =
    // stronger answers = more coordination pay), capped by what fits in memory, so strong hardware serves a big
    // model and a small machine serves a small one. Steward-ASSIGNED first, then under-replicated, then, when
    // just securing a serving model, largest-that-fits first; otherwise newest first.
    const fitsHardware = (e: RegistryEntry): boolean => (e.meta.sizeBytes ?? 0) * 1.3 <= totalmem();
    const entries = [...this.registry.values()].sort((a, b) =>
      (Number(!!b.meta.assigned) - Number(!!a.meta.assigned))
      || (liveReplicas(a) - liveReplicas(b))
      || (!storageOn ? ((b.meta.sizeBytes ?? 0) - (a.meta.sizeBytes ?? 0)) : (b.meta.ts - a.meta.ts)));
    for (const entry of entries) {
      if (this.store.hasValidGguf(entry.meta.id)) continue;
      if (this.storageFetches.has(entry.meta.id)) continue;
      if (!storageOn) {
        // Just securing the ONE serving model: skip anything too big to run here, and stop once we have it.
        if (!needServing) break;
        if (!fitsHardware(entry)) continue;
      } else {
        const wellReplicated = liveReplicas(entry) >= MODEL_REPLICATION_TARGET;
        // An assigned model is fetched even when well replicated: the steward wants it on the whole network.
        if (wellReplicated && !needServing && !entry.meta.assigned) continue; // else spread, don't clone covered
      }
      if (this.projectedStorageBytes() + (entry.meta.sizeBytes ?? 0) > cap) {
        log.debug(`storage peer skipped ${entry.meta.name}: would exceed the storage cap`);
        continue;
      }
      this.storageFetches.add(entry.meta.id);
      try { if (await this.fetch(entry.meta.id)) needServing = false; }
      catch (e) { log.debug("storage replication pending", (e as Error).message); }
      finally { this.storageFetches.delete(entry.meta.id); }
      if (!storageOn && !needServing) break; // secured a servable model; a non-storage miner stops there
    }
  }

  /** Bytes currently held plus the projected size of in-flight fetches, so two concurrent reconciles (or a
   * fetch already running) cannot blow past the cap before they finalize. */
  private projectedStorageBytes(): number {
    let n = this.store.totalBytes();
    for (const id of this.storageFetches) n += this.registry.get(id)?.meta.sizeBytes ?? 0;
    return n;
  }

  // ---- mining ----

  currentMining(): MiningConfig {
    return { ...this.mining };
  }

  async setMining(patch: Partial<MiningConfig>): Promise<MiningConfig> {
    const prevEnabled = Boolean(this.mining.enabled);
    const prevStorage = Boolean(this.mining.storageEnabled);
    const next = { ...patch };
    if (next.gpuLayers !== undefined) next.gpuLayers = Math.max(0, Math.min(100, Math.floor(Number(next.gpuLayers) || 0)));
    if (next.threads !== undefined) next.threads = Math.max(1, Math.min(256, Math.floor(Number(next.threads) || 1)));
    if ((patch.gpuLayers !== undefined || patch.threads !== undefined) && patch.useRecommendedHardware === undefined) next.useRecommendedHardware = false;
    this.mining = { ...this.mining, ...next };
    // Storage is OPTIONAL but ON BY DEFAULT. Mining earns coordination-first: a node earns for live
    // coordination even without serving model storage; serving storage earns MORE. So when a user first
    // turns Mine on we default storage on (one switch is all a normal user needs), but they can turn
    // storage off and keep mining, still earning via coordination. An explicit storageEnabled in the patch
    // always wins, so the toggle is real.
    const miningJustEnabled = patch.enabled === true && !prevEnabled;
    if (miningJustEnabled && patch.storageEnabled === undefined) this.mining.storageEnabled = true;
    const storageJustForcedOn = this.mining.storageEnabled && !prevStorage;
    // A GB-only patch (older Console) updates the byte cap too, so the authoritative value tracks it.
    if (patch.storageLimitGb !== undefined && patch.storageCapBytes === undefined) {
      this.mining.storageCapBytes = Math.max(1, Math.min(4096, Number(patch.storageLimitGb) || 1)) * 1024 ** 3;
    }
    ModelService.normalizeStorage(this.mining);
    this.saveMining();
    // Storage-affecting changes: re-enforce the cap (evict over-cap non-essential bytes), and when on,
    // re-advertise and replicate up to the cap; when off, stop advertising/replicating heavy bytes.
    if (patch.storageEnabled !== undefined || patch.storageCapBytes !== undefined || patch.storageLimitGb !== undefined || storageJustForcedOn) {
      this.enforceStorageCap();
      if (this.mining.storageEnabled) { this.registerLaunchModels(); this.announceLocal(); void this.reconcileStorage(); }
    }
    if (!this.mining.enabled) {
      // Mining is off. Stop the isolated inference subprocess and free the engine. Keep (or load) a native
      // model only if the user wants local inference for their own tasks. Own-tasks is independent here.
      this.stopSubprocessInference();
      if (this.mining.ownTaskInference) await this.ensureOwnTaskModel();
      else await this.inference.unload();
      return this.mining;
    }
    // Mining is on. Make sure the genesis launch models are registered NOW (the user may have enabled mining
    // after startup, when init() skipped the bake) so reconcile has a model to hold, serve, and earn from.
    this.registerLaunchModels();
    if (this.mining.mode === "auto") await this.reconcileAuto();
    else if (this.mining.modelId) await this.loadIfReady();
    return this.mining;
  }
  private async loadIfReady(): Promise<void> {
    const id = this.mining.modelId;
    if (!id || !this.store.hasValidGguf(id)) return;
    // Only native-load a model that fits this machine. A CPU load needs roughly the model size in free
    // RAM; if it does not fit, skip the native engine and keep serving via endpoint/coordination. The
    // field still distributes the model to storage peers; only capable nodes run it. This keeps big
    // models on the field without OOM-crashing small nodes.
    const meta = this.store.meta(id);
    // A CPU load needs the weights plus context and OS headroom (~1.7x the file). Only native-load when
    // that comfortably fits free RAM; otherwise keep distributing the model and serve via endpoint or
    // coordination. This stops a big model from OOM-crashing a node that is sharing the machine.
    if (meta && this.mining.gpuLayers <= 0 && meta.sizeBytes * 1.7 > freemem()) {
      if (!this.engineUnavailableLogged) {
        log.info(`model ${id.slice(0, 12)} is ${(meta.sizeBytes / 1e9).toFixed(1)}GB and does not fit free memory with headroom; serving via endpoint/coordination instead of a native load`);
        this.engineUnavailableLogged = true;
      }
      return;
    }
    if (!(await this.inference.isAvailable())) {
      if (!this.engineUnavailableLogged) {
        log.info("native inference engine not installed; mining continues in field-coordinator mode. Install node-llama-cpp or configure an endpoint for full generative answers.");
        this.engineUnavailableLogged = true;
      }
      return;
    }
    try { await this.inference.load(id, this.store.pathOf(id), { gpuLayers: this.mining.gpuLayers, threads: this.mining.threads }); }
    catch (e) { log.warn("could not load model for mining", (e as Error).message); }
  }

  /** Whether this node lends its hardware to the field (mining/coordination is on). A node that
   * contributes hardware is exempt from the newcomer free-query rate limit: its own field questions
   * are free because it is already paying with coordination work, and it needs no model or storage. */
  miningEnabled(): boolean { return this.mining.enabled; }
  /** Whether this miner can produce a REAL answer for the field right now: a native model is loaded or an
   * inference endpoint (our isolated subprocess, or a configured one) is serving. Coordination-only nodes
   * (mining on but no model/endpoint) do NOT "serve": they relay, weight and validate, but never publish a
   * placeholder answer that would compete with real ones in fusion. */
  canServe(): boolean {
    if (!this.mining.enabled) return false;
    return this.inference.loadedModel() !== null || !!this.mining.endpoint;
  }
  /** A short label for what is answering, for the provider announcement. */
  answerLabel(): string {
    if (this.inference.loadedModel()) return "zira-engine";
    if (this.mining.endpoint) return this.mining.endpointModel || "endpoint";
    return "";
  }
  /** Answer with the built in engine or an inference endpoint. There is no canned fallback: a node that
   * cannot really generate stays silent so the field only ever carries real, model-backed answers. */
  async generate(messages: { role: "user" | "assistant"; content: string }[], system: string, domain?: Domain): Promise<string> {
    const loaded = this.inference.loadedModel();
    if (loaded) {
      // Domain routing happens primarily ACROSS nodes: a miner picks up only queries in its served domains
      // (provider/loop pickupDomains), so as the catalog grows, a code query reaches a code-serving node and
      // a vision query an image-serving node. Within a node we serve the already-loaded model rather than
      // swapping per query — a CPU host reloading multi-GB weights mid-stream would thrash and miss the TTL —
      // and the reconcile already loaded the best local model for this node's domains. When the node holds the
      // domain-preferred model AND it is the loaded one, that is exactly what serves; otherwise the loaded
      // model answers. `domain` is honored here for that check and reserved for multi-model/endpoint serving.
      if (domain) { const want = this.modelForDomain(domain); void want; }
      return this.inference.generate(system, messages);
    }
    if (this.mining.endpoint) {
      return chat({ endpoint: this.mining.endpoint, model: this.mining.endpointModel || "qwen2.5-coder:14b", messages: [{ role: "system", content: system }, ...messages] });
    }
    throw new Error("no model available to answer");
  }

  // ---- own-task inference: the user's own hardware for the user's own work, decoupled from mining ----
  // This path never serves the field, never answers others, and never earns. It can run even when
  // mining is off. It reuses the same native engine and endpoint as mining, but its model loading is
  // driven by the ownTaskInference flag instead of mining.enabled, so a user can use their GPU/CPU for
  // Local-mode Console and Resonator tasks without serving the field.

  /** True when own-task local inference is turned on by the user (or ZIRA_LOCAL_INFERENCE). */
  ownTaskEnabled(): boolean { return Boolean(this.mining.ownTaskInference); }

  /** Make sure a locally available authorized model is loaded for own-task inference, when it fits.
   * Mirrors loadIfReady's safety (RAM headroom, engine availability) but is gated on ownTaskInference,
   * not mining. It never downloads bytes: it only loads a model storage already replicated locally. */
  private async ensureOwnTaskModel(): Promise<void> {
    if (!this.mining.ownTaskInference) return;
    if (this.mining.endpoint) return; // an endpoint needs no native load
    const id = this.mining.modelId ?? this.recommendedModelId();
    if (!id || !this.store.hasValidGguf(id)) return;
    if (this.inference.loadedModel() === id) return;
    const meta = this.store.meta(id);
    if (meta && this.mining.gpuLayers <= 0 && meta.sizeBytes * 1.7 > freemem()) return; // would not fit; use endpoint/none
    if (!(await this.inference.isAvailable())) return; // native engine not installed; endpoint only
    try { await this.inference.load(id, this.store.pathOf(id), { gpuLayers: this.mining.gpuLayers, threads: this.mining.threads }); }
    catch (e) { log.warn("could not load model for own-task inference", (e as Error).message); }
  }

  /** Whether own-task inference can actually produce a local answer right now (engine loaded or endpoint set). */
  async ownTaskReady(): Promise<boolean> {
    if (!this.mining.ownTaskInference) return false;
    if (this.mining.endpoint) return true;
    await this.ensureOwnTaskModel();
    return this.inference.loadedModel() !== null;
  }

  /** A short label for what answers the user's own tasks: native engine, endpoint, or none. */
  ownTaskLabel(): string {
    if (!this.mining.ownTaskInference) return "off";
    if (this.inference.loadedModel()) return "zira-engine";
    if (this.mining.endpoint) return this.mining.endpointModel || "endpoint";
    return "no local model";
  }

  /** Generate an answer for the USER'S OWN task using local inference only. Throws if local inference is
   * off or no local model/endpoint is available. Never touches the field, never publishes, never earns. */
  async generateOwnTask(messages: { role: "user" | "assistant"; content: string }[], system: string): Promise<string> {
    if (!this.mining.ownTaskInference) throw new Error("local inference for your own tasks is off. Turn on \"My tasks only\" on the Mine page.");
    await this.ensureOwnTaskModel();
    if (this.inference.loadedModel()) return this.inference.generate(system, messages);
    if (this.mining.endpoint) {
      return chat({ endpoint: this.mining.endpoint, model: this.mining.endpointModel || "qwen2.5-coder:14b", messages: [{ role: "system", content: system }, ...messages] });
    }
    throw new Error("no local model is available yet. Load an authorized model on this node (storage peer) or set a local endpoint like Ollama.");
  }

  async status(): Promise<{ mining: MiningConfig; engineAvailable: boolean; loadedModel: string | null; serving: boolean; ownTaskReady: boolean; ownTaskLabel: string; isFounder: boolean; local: ModelMeta[]; storageBytes: number; storageDownloadingBytes: number; known: { meta: ModelMeta; providers: number; targetHosts: number; distributionProgress: number; ready: boolean; local: boolean }[] }> {
    return {
      mining: this.mining,
      engineAvailable: await this.inference.isAvailable(),
      loadedModel: this.inference.loadedModel(),
      serving: this.canServe(),
      ownTaskReady: await this.ownTaskReady(),
      ownTaskLabel: this.ownTaskLabel(),
      isFounder: this.isFounder(),
      local: this.store.list(),
      storageBytes: this.store.totalBytes(),
      storageDownloadingBytes: this.store.downloadingBytes(),
      known: this.knownModels(),
    };
  }
  knownModels(): { meta: ModelMeta; providers: number; targetHosts: number; distributionProgress: number; ready: boolean; local: boolean }[] {
    // Field-ready means the model is no longer single-host: the authority node plus at least one
    // storage-enabled peer can serve the bytes. Light peers sync metadata but should not force the
    // heavy-byte readiness target upward.
    const targetHosts = 2;
    return [...this.registry.values()].map((e) => {
      const providers = e.peerIds.size;
      const distributionProgress = Math.max(0, Math.min(1, providers / targetHosts));
      // Surface the modality + routing domains on every model (defaulting legacy metas) so the picker
      // and routing always have a type+domain even for models signed before the type field existed.
      const meta = { ...e.meta, type: this.modelType(e.meta), domains: this.modelDomains(e.meta) };
      return { meta, providers, targetHosts, distributionProgress, ready: providers >= targetHosts, local: e.local };
    });
  }

  private manifestPath(id: string): string { return join(this.dataDir, "models", id, "manifest.json"); }
  private saveManifest(id: string, m: { founderPubKey: string; manifestSig: string }): void {
    try { writeFileSync(this.manifestPath(id), JSON.stringify(m)); } catch { /* */ }
  }
  private loadManifest(id: string): { founderPubKey: string; manifestSig: string } | null {
    try { if (existsSync(this.manifestPath(id))) return JSON.parse(readFileSync(this.manifestPath(id), "utf8")); } catch { /* */ }
    return null;
  }

  private loadMining(): MiningConfig {
    let loaded: MiningConfig = { ...DEFAULT_MINING };
    try { if (existsSync(this.miningPath)) loaded = { ...loaded, ...JSON.parse(readFileSync(this.miningPath, "utf8")) }; } catch { /* */ }
    const bool = (name: string): boolean | undefined => {
      const v = process.env[name];
      if (v === undefined || v === "") return undefined;
      return v === "1" || v.toLowerCase() === "true";
    };
    const mine = bool("ZIRA_MINE");
    const storage = bool("ZIRA_STORAGE");
    const localTasks = bool("ZIRA_LOCAL_TASKS");
    const ownTasks = bool("ZIRA_LOCAL_INFERENCE");
    const recommendedHardware = bool("ZIRA_USE_RECOMMENDED_HARDWARE");
    if (mine !== undefined) loaded.enabled = mine;
    if (storage !== undefined) loaded.storageEnabled = storage;
    if (localTasks !== undefined) loaded.localTaskPermission = localTasks;
    if (ownTasks !== undefined) loaded.ownTaskInference = ownTasks;
    if (recommendedHardware !== undefined) loaded.useRecommendedHardware = recommendedHardware;
    // If this node is configured with an inference endpoint, the miner serves through it and is model
    // agnostic: it never native-loads GGUF weights (which would be redundant with the endpoint and can
    // crash a shared machine). Native loading stays the path only for nodes with no endpoint. This
    // honors the architecture where mining is hardware-for-coordination and serving is a separate role.
    const mineEndpoint = process.env.ZIRA_MINE_ENDPOINT || process.env.ZIRA_PROVIDE_ENDPOINT || process.env.ZIRA_PROVIDER_ENDPOINT;
    if (mineEndpoint) {
      loaded.endpoint = mineEndpoint;
      loaded.endpointModel = process.env.ZIRA_MINE_MODEL || process.env.ZIRA_PROVIDE_MODEL || process.env.ZIRA_PROVIDER_MODEL || loaded.endpointModel;
    }
    if (process.env.ZIRA_GPU_LAYERS) loaded.gpuLayers = Math.max(0, Math.min(100, Math.floor(Number(process.env.ZIRA_GPU_LAYERS) || 0)));
    if (process.env.ZIRA_THREADS) loaded.threads = Math.max(1, Math.min(256, Math.floor(Number(process.env.ZIRA_THREADS) || loaded.threads || 1)));
    // Storage cap. The runtime state (persisted in mining.json) is authoritative; env vars only SEED the
    // initial value when no persisted cap exists. ZIRA_STORAGE_BYTES wins (byte-exact, matches the new
    // /storage RPC); ZIRA_STORAGE_GB stays as a coarse alias. A persisted storageLimitGb (older state)
    // upgrades into storageCapBytes so the byte cap is always present and authoritative.
    if (process.env.ZIRA_STORAGE_BYTES) loaded.storageCapBytes = Number(process.env.ZIRA_STORAGE_BYTES) || loaded.storageCapBytes;
    else if (process.env.ZIRA_STORAGE_GB) loaded.storageCapBytes = (Number(process.env.ZIRA_STORAGE_GB) || 1) * 1024 ** 3;
    else if (loaded.storageCapBytes === undefined && loaded.storageLimitGb !== undefined) loaded.storageCapBytes = loaded.storageLimitGb * 1024 ** 3;
    return ModelService.normalizeStorage(loaded);
  }

  /** Keep storageCapBytes (authoritative) and storageLimitGb (display) consistent and within bounds.
   * Cap floor is 1 byte; the GB mirror is at least 1 GB so the older UI never shows 0. */
  private static normalizeStorage(m: MiningConfig): MiningConfig {
    const MAX_CAP_BYTES = 4096 * 1024 ** 3; // 4 TiB ceiling, matches the prior 4096 GB bound
    let cap = Number(m.storageCapBytes);
    if (!Number.isFinite(cap) || cap <= 0) cap = STORAGE_DEFAULT_CAP_BYTES;
    cap = Math.max(1, Math.min(MAX_CAP_BYTES, Math.floor(cap)));
    m.storageCapBytes = cap;
    m.storageLimitGb = Math.max(1, Math.round(cap / 1024 ** 3));
    return m;
  }

  /** The authoritative heavy-storage cap in bytes (defaults to 1 GiB). */
  storageCapBytes(): number {
    const cap = Number(this.mining.storageCapBytes);
    return Number.isFinite(cap) && cap > 0 ? cap : STORAGE_DEFAULT_CAP_BYTES;
  }

  /** Bytes currently held in the local heavy-storage cache (cached model GGUFs). */
  storageUsedBytes(): number { return this.store.totalBytes(); }

  /** GET /storage view: the soft-infra storage state. Consensus-neutral; not ledger state. */
  storageState(): { enabled: boolean; capBytes: number; usedBytes: number } {
    return { enabled: Boolean(this.mining.storageEnabled), capBytes: this.storageCapBytes(), usedBytes: this.storageUsedBytes() };
  }

  /** POST /storage: set the storage toggle and/or byte cap. Persists across restarts and re-enforces
   * the cap immediately (evict over-cap non-essential bytes, re-announce, re-reconcile). */
  async setStorage(patch: { enabled?: boolean; capBytes?: number }): Promise<{ enabled: boolean; capBytes: number; usedBytes: number }> {
    const next: Partial<MiningConfig> = {};
    if (typeof patch.enabled === "boolean") next.storageEnabled = patch.enabled;
    if (patch.capBytes !== undefined) next.storageCapBytes = Number(patch.capBytes);
    await this.setMining(next);
    return this.storageState();
  }
  private saveMining(): void { try { writeFileSync(this.miningPath, JSON.stringify(this.mining, null, 2)); } catch { /* */ } }
}
