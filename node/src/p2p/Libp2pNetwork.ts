// node/src/p2p/Libp2pNetwork.ts
// Real peer to peer networking with libp2p: gossipsub for event propagation, bootstrap for peer
// discovery, noise encryption, yamux multiplexing, TCP and WebSocket transports, and a length
// prefixed stream protocol for initial state sync when a node joins or reconnects.
import { createLibp2p, type Libp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { identify } from "@libp2p/identify";
import { ping } from "@libp2p/ping";
import { bootstrap } from "@libp2p/bootstrap";
// Global reachability: discover peers via a DHT, detect our own NAT status, hole-punch relayed
// connections into direct ones, and (on public nodes) relay for peers stuck behind NAT/CGNAT.
import { circuitRelayServer, circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { kadDHT } from "@libp2p/kad-dht";
import { autoNAT } from "@libp2p/autonat";
import { dcutr } from "@libp2p/dcutr";
import { pipe } from "it-pipe";
import * as lp from "it-length-prefixed";
import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from "@libp2p/crypto/keys";
import { multiaddr } from "@multiformats/multiaddr";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ZiraNetwork } from "./Network.js";
import { SYNC_PROTOCOL } from "./topics.js";
import { log } from "../log.js";

export interface Libp2pOptions {
  p2pPort: number;
  wsPort: number;
  bootstrap: string[];
  announce: string[];
  topics: string[];
  dataDir?: string;   // persist a stable peer identity here, so a bootstrap node keeps its id
  relayServer?: boolean;  // run a circuit-relay v2 server (public nodes only) so NAT'd peers are reachable
}

// The slice of the gossipsub instance API we use, to avoid wrestling libp2p's generic service types.
interface PubSubLike {
  addEventListener(type: "message", cb: (evt: { detail: { topic: string; data: Uint8Array; from?: { toString(): string } } }) => void): void;
  subscribe(topic: string): void;
  publish(topic: string, data: Uint8Array): Promise<unknown>;
}

// Peer-discovery targets. We actively work to keep at least TARGET_PEERS connections (dialing all known
// seeds + DHT-discovered peers), but never push past the F7 maxConnections cap. Default target is well
// below the cap so a healthy local mesh forms quickly without ever crowding out inbound peers.
const TARGET_PEERS = Number(process.env.ZIRA_TARGET_PEERS ?? 8);
const DISCOVERY_INTERVAL_MS = 20_000;
// Keepalive: a home node behind NAT dials OUT to the masters, and the masters reuse that same connection to
// send it a liveness probe (which is how a miner gets vouched and paid). If the connection sits idle, the
// router's NAT mapping expires; libp2p still lists the connection but the master's probe stream hangs and the
// miner silently stops being vouched — it stops earning without any error. Pinging each live connection well
// inside the typical NAT idle window keeps the mapping fresh AND surfaces a dead connection fast so the
// discovery sweep can redial it. Networking only; no consensus effect.
const KEEPALIVE_INTERVAL_MS = Number(process.env.ZIRA_KEEPALIVE_INTERVAL_MS ?? 20_000);

export class Libp2pNetwork implements ZiraNetwork {
  private node: Libp2p | null = null;
  private msgCb: (topic: string, data: Uint8Array, from: string) => void = () => {};
  private syncFrameCb: (data: Uint8Array) => void = () => {};
  private syncProvider: () => AsyncIterable<Uint8Array> | Iterable<Uint8Array> = function* () {};
  private syncedPeers = new Set<string>();
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private maxConnections = Number(process.env.ZIRA_MAX_CONNECTIONS ?? 128);
  // Backoff bookkeeping so we don't hammer a peer that keeps refusing: peerId/addr -> next-eligible time.
  private dialBackoff = new Map<string, number>();

  constructor(private opts: Libp2pOptions) {}

  /** Add a bootstrap peer before start(). Useful for tests and dynamic peering. */
  addBootstrap(multiaddr: string): void { this.opts.bootstrap = [...this.opts.bootstrap, multiaddr]; }

  async start(): Promise<void> {
    const listen = [
      `/ip4/0.0.0.0/tcp/${this.opts.p2pPort}`,
      `/ip4/0.0.0.0/tcp/${this.opts.wsPort}/ws`,
      "/p2p-circuit",   // accept relayed inbound, so peers behind NAT/CGNAT are reachable via a relay
    ];
    const pubsub = gossipsub({ allowPublishToZeroTopicPeers: true, emitSelf: false, fallbackToFloodsub: true });
    const privateKey = await this.loadOrCreatePeerKey();

    this.node = await createLibp2p({
      privateKey,
      addresses: { listen, announce: this.opts.announce.length ? this.opts.announce : undefined },
      // F7: bound inbound connection pressure so a public node cannot be exhausted by a flood of
      // dials. maxConnections is generous for a healthy mesh; excess connections are pruned by libp2p.
      connectionManager: {
        maxConnections: this.maxConnections,
        maxIncomingPendingConnections: 32,
      },
      transports: [tcp(), webSockets(), circuitRelayTransport()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      peerDiscovery: this.opts.bootstrap.length ? [bootstrap({ list: this.opts.bootstrap })] : [],
      services: {
        identify: identify(),
        ping: ping(),
        pubsub,
        // Kademlia DHT on a ZIRA-private protocol: scalable peer discovery beyond the seed list.
        // Public nodes serve the DHT; NAT'd nodes run as clients (they cannot be dialed directly).
        dht: kadDHT({ clientMode: !this.opts.relayServer, protocol: "/zira/kad/1.0.0" }),
        autonat: autoNAT(),   // learn whether we are publicly dialable
        dcutr: dcutr(),       // upgrade a relayed connection to a direct one (hole punching)
        // Public nodes (the VPS, bootstrap) relay for peers stuck behind NAT.
        ...(this.opts.relayServer ? { relay: circuitRelayServer() } : {}),
      },
    });

    // route pubsub messages to the node logic
    const ps = this.node.services.pubsub as unknown as PubSubLike;
    ps.addEventListener("message", (evt) => {
      try { this.msgCb(evt.detail.topic, evt.detail.data, evt.detail.from?.toString?.() ?? "?"); }
      catch (e) { log.warn("message handler error", (e as Error).message); }
    });
    for (const t of this.opts.topics) ps.subscribe(t);

    // respond to sync requests with our full durable event log, length prefixed
    await this.node.handle(SYNC_PROTOCOL, ({ stream }) => {
      const provider = this.syncProvider;
      void pipe(
        (async function* () { for await (const frame of provider()) yield frame; })(),
        (s) => lp.encode(s),
        stream,
      ).catch((e) => log.debug("sync respond error", (e as Error).message));
    });

    // register any protocol handlers requested before start (model transfer, etc.)
    for (const [proto, h] of this.pendingHandlers) await this.registerHandler(proto, h);
    this.pendingHandlers = [];

    // When a peer connects, fast-sync FIRST (adopt snapshot + arm the convergence floor), THEN pull
    // recent events. F2: these must be sequenced, not concurrent — if syncFromPeer streams the event
    // tail while fast-sync is still negotiating, finalized coordination events land on pre-snapshot
    // state and the joiner's state root diverges from the mesh by a fixed offset.
    this.node.addEventListener("peer:connect", (evt: any) => {
      const peer = evt.detail?.toString?.();
      if (!peer) return;
      void (async () => {
        try { await this.peerConnectCb(peer); } catch { /* fast-sync best effort */ }
        try { await this.syncFromPeer(peer); } catch { /* tail pull best effort */ }
      })();
    });

    // Active discovery: bootstrap AND the DHT emit "peer:discovery" as they learn of peers. Dial each
    // discovered peer while we are below the target (and the F7 cap), so we converge to MULTIPLE peers
    // instead of stopping at the first connection. libp2p dedupes dials to peers we are already connected
    // to, and the connection manager prunes anything past maxConnections, so this never breaks the cap.
    this.node.addEventListener("peer:discovery", (evt: any) => {
      const id = evt.detail?.id?.toString?.();
      const addrs: string[] = (evt.detail?.multiaddrs ?? []).map((m: any) => m.toString());
      if (!id) return;
      void this.maybeDialDiscovered(id, addrs);
    });

    await this.node.start();
    log.info("libp2p peer id", this.node.peerId.toString());
    for (const a of this.multiaddrs()) log.info("listening", a);

    // Dial every known bootstrap/announce seed immediately and in PARALLEL (don't wait for the bootstrap
    // plugin's slow sequential schedule). Then run a periodic discovery sweep: re-dial seeds we lost and
    // query the DHT for more peers whenever we are under the target. Retries with backoff.
    void this.dialAllSeeds();
    this.discoveryTimer = setInterval(() => { void this.discoverySweep(); }, DISCOVERY_INTERVAL_MS);
    if (typeof (this.discoveryTimer as any).unref === "function") (this.discoveryTimer as any).unref();
    this.keepAliveTimer = setInterval(() => { void this.keepAliveSweep(); }, KEEPALIVE_INTERVAL_MS);
    if (typeof (this.keepAliveTimer as any).unref === "function") (this.keepAliveTimer as any).unref();
  }

  /**
   * Ping every live connection to keep its NAT mapping fresh (see KEEPALIVE_INTERVAL_MS). Each ping opens a
   * stream over the EXISTING connection, so it both refreshes the router's UDP/TCP mapping and lets libp2p
   * detect a dead connection quickly (the connection is closed on failure, and discoverySweep redials). This
   * is what keeps a home miner reachable for the masters' liveness probe, so it stays vouched and keeps
   * earning. Bounded and best-effort: a slow/dead peer never blocks the others.
   */
  private async keepAliveSweep(): Promise<void> {
    if (!this.node) return;
    const pinger: any = this.node.services?.ping;
    if (!pinger || typeof pinger.ping !== "function") return;
    const conns = this.node.getConnections();
    await Promise.allSettled(conns.map(async (c) => {
      try { await pinger.ping(c.remotePeer, { signal: AbortSignal.timeout(8_000) }); }
      catch { try { await c.close(); } catch { /* pruned; discoverySweep will redial */ } }
    }));
  }

  /** Dial all configured bootstrap + announce seeds in parallel (best effort). */
  private async dialAllSeeds(): Promise<void> {
    const seeds = [...new Set([...this.opts.bootstrap, ...this.opts.announce])]
      .filter((a) => a.startsWith("/") && a.includes("/p2p/"));
    await Promise.allSettled(seeds.map((addr) => this.dialQuiet(addr)));
  }

  /** Periodic sweep: while under the target, re-dial seeds and ask the DHT to find more peers. */
  private async discoverySweep(): Promise<void> {
    if (!this.node) return;
    if (this.peerCount() >= TARGET_PEERS) return;       // healthy mesh; nothing to do
    if (this.peerCount() >= this.maxConnections) return; // respect the F7 cap
    await this.dialAllSeeds();
    await this.discoverViaDHT();
  }

  /** Use the Kademlia DHT to find peers close to our own id and dial them (up to the target/cap). */
  private async discoverViaDHT(): Promise<void> {
    const dht: any = this.node?.services?.dht;
    if (!dht || typeof dht.getClosestPeers !== "function") return;
    try {
      let found = 0;
      for await (const event of dht.getClosestPeers(this.node!.peerId.toMultihash().bytes)) {
        if (this.peerCount() >= TARGET_PEERS || this.peerCount() >= this.maxConnections) break;
        // FINAL_PEER / PEER_RESPONSE events carry peer infos we can dial.
        const peers = event?.peer ? [event.peer] : (event?.closer ?? event?.peers ?? []);
        for (const p of peers) {
          const id = p?.id?.toString?.() ?? p?.toString?.();
          const addrs: string[] = (p?.multiaddrs ?? []).map((m: any) => m.toString());
          if (id) { await this.maybeDialDiscovered(id, addrs); found++; }
          if (found >= 16) break;
        }
        if (found >= 16) break;
      }
    } catch (e) { log.debug("DHT peer discovery failed", (e as Error).message); }
  }

  /** Dial a discovered peer if we still want more connections, are not already connected, and backoff allows. */
  private async maybeDialDiscovered(peerId: string, addrs: string[]): Promise<void> {
    if (!this.node) return;
    if (this.peerCount() >= TARGET_PEERS || this.peerCount() >= this.maxConnections) return;
    if (peerId === this.node.peerId.toString()) return;                 // never dial ourselves
    if (this.node.getConnections().some((c) => c.remotePeer.toString() === peerId)) return; // already connected
    // Build a dialable multiaddr (with the /p2p/<id> suffix). Discovery events without any address can't
    // be dialed directly here; libp2p's own bootstrap/DHT dialing handles those once addresses are known.
    const target = this.dialableAddr(peerId, addrs);
    if (!target) return;
    const now = Date.now();
    const next = this.dialBackoff.get(peerId) ?? 0;
    if (now < next) return;
    try {
      await this.dial(target);
      this.dialBackoff.delete(peerId);
    } catch (e) {
      // Exponential-ish backoff capped at ~5 min so a flaky peer is retried but not hammered.
      const prevGap = next > now ? next - now : DISCOVERY_INTERVAL_MS;
      this.dialBackoff.set(peerId, now + Math.min(prevGap * 2, 300_000));
      log.debug("discovered peer dial failed", peerId.slice(-8), (e as Error).message);
    }
  }

  /** Dial without throwing (used for parallel seed dialing). */
  private async dialQuiet(addr: string): Promise<void> {
    try { await this.dial(addr); } catch (e) { log.debug("seed dial failed", addr.slice(-16), (e as Error).message); }
  }

  /** Produce a dialable multiaddr (carrying /p2p/<id>) for a discovered peer, or null if none is known. */
  private dialableAddr(peerId: string, addrs: string[]): string | null {
    const withP2p = addrs.find((a) => a.includes("/p2p/"));
    if (withP2p) return withP2p;
    const transport = addrs.find((a) => a.startsWith("/") && !a.includes("/p2p/"));
    if (transport) return `${transport}/p2p/${peerId}`;
    return null;
  }

  // A stable libp2p identity so a bootstrap node keeps the same peer id across restarts.
  private async loadOrCreatePeerKey() {
    const dir = this.opts.dataDir;
    if (!dir) return generateKeyPair("Ed25519");
    const path = join(dir, "peer-key.bin");
    try {
      if (existsSync(path)) return privateKeyFromProtobuf(readFileSync(path));
      const key = await generateKeyPair("Ed25519");
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, privateKeyToProtobuf(key));
      return key;
    } catch (e) {
      log.warn("peer key persistence failed, using ephemeral identity", (e as Error).message);
      return generateKeyPair("Ed25519");
    }
  }

  private async syncFromPeer(peerIdStr: string): Promise<void> {
    if (!this.node) return;
    if (this.syncedPeers.has(peerIdStr)) return;
    this.syncedPeers.add(peerIdStr);
    try {
      const conns = this.node.getConnections();
      const conn = conns.find((c) => c.remotePeer.toString() === peerIdStr);
      if (!conn) return;
      const stream = await conn.newStream(SYNC_PROTOCOL);
      await pipe(stream, (s) => lp.decode(s), async (source) => {
        for await (const frame of source) this.syncFrameCb(frame.subarray());
      });
      log.info("synced from peer", peerIdStr.slice(-8));
    } catch (e) {
      this.syncedPeers.delete(peerIdStr);
      log.debug("sync from peer failed", (e as Error).message);
    }
  }

  async stop(): Promise<void> {
    if (this.discoveryTimer) { clearInterval(this.discoveryTimer); this.discoveryTimer = null; }
    if (this.keepAliveTimer) { clearInterval(this.keepAliveTimer); this.keepAliveTimer = null; }
    await this.node?.stop();
  }

  async publish(topic: string, data: Uint8Array): Promise<void> {
    const ps = this.node?.services.pubsub as unknown as PubSubLike | undefined;
    if (!ps) return;
    try { await ps.publish(topic, data); } catch { /* no peers yet, fine */ }
  }

  onMessage(cb: (topic: string, data: Uint8Array, from: string) => void): void { this.msgCb = cb; }
  setSyncProvider(fn: () => AsyncIterable<Uint8Array> | Iterable<Uint8Array>): void { this.syncProvider = fn; }
  onSyncFrame(cb: (data: Uint8Array) => void): void { this.syncFrameCb = cb; }
  onPeerConnect(cb: (peerId: string) => void | Promise<void>): void { this.peerConnectCb = cb; }
  private peerConnectCb: (peerId: string) => void | Promise<void> = () => {};

  handle(protocol: string, handler: (req: Uint8Array) => AsyncIterable<Uint8Array>): void {
    if (!this.node) { this.pendingHandlers.push([protocol, handler]); return; }
    void this.registerHandler(protocol, handler);
  }
  private pendingHandlers: Array<[string, (req: Uint8Array) => AsyncIterable<Uint8Array>]> = [];
  private async registerHandler(protocol: string, handler: (req: Uint8Array) => AsyncIterable<Uint8Array>): Promise<void> {
    await this.node!.handle(protocol, ({ stream }) => {
      void pipe(
        stream,
        (s) => lp.decode(s),
        async function* (source) {
          let req: Uint8Array | undefined;
          for await (const f of source) { req = f.subarray(); break; }
          if (!req) return;
          yield* handler(req);
        },
        (s) => lp.encode(s),
        stream,
      ).catch((e) => log.debug("protocol handler error", (e as Error).message));
    });
  }

  async request(peerIdStr: string, protocol: string, req: Uint8Array, timeoutMs = 25_000): Promise<Uint8Array[]> {
    if (!this.node) return [];
    const conn = this.node.getConnections().find((c) => c.remotePeer.toString() === peerIdStr);
    if (!conn) throw new Error("not connected to peer " + peerIdStr);
    const stream = await conn.newStream(protocol);
    const frames: Uint8Array[] = [];
    // A peer can open the stream and then stall forever (accepts the request, never responds). Without a
    // timeout the caller hangs indefinitely. This is exactly what froze the P2P model download at 0 B and
    // never let it fall through to the URL fallback. Bound every request: on timeout, abort the stream and
    // throw so the caller moves to the next peer / source.
    const run = pipe(
      [req],
      (s) => lp.encode(s),
      stream,
      (s) => lp.decode(s),
      async (source) => { for await (const f of source) frames.push(f.subarray()); },
    );
    run.catch(() => {});   // a late error after a timeout-abort must not surface as an unhandled rejection
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`request to ${peerIdStr.slice(0, 8)} timed out after ${timeoutMs}ms`)), timeoutMs); });
    try {
      await Promise.race([run, timeout]);
      return frames;
    } catch (e) {
      try { stream.abort(e as Error); } catch { /* best effort */ }
      throw e;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async dial(addr: string): Promise<void> {
    if (!this.node) throw new Error("node not started");
    await this.node.dial(multiaddr(addr));
  }

  multiaddrs(): string[] { return this.node ? this.node.getMultiaddrs().map((m) => m.toString()) : []; }
  peerId(): string { return this.node ? this.node.peerId.toString() : ""; }
  peerCount(): number { return this.node ? this.node.getConnections().length : 0; }
  peers(): string[] { return this.node ? this.node.getConnections().map((c) => c.remotePeer.toString()) : []; }
  peerMultiaddrs(): string[] {
    const addrs = this.node ? this.node.getConnections().map((c) => c.remoteAddr?.toString()).filter(Boolean) : [];
    return [...new Set(addrs)];
  }
  connections(): { peerId: string; addr: string; direction: string }[] {
    if (!this.node) return [];
    // De-duplicate by remote peer (a peer can hold several connections); keep the first seen.
    const seen = new Set<string>();
    const out: { peerId: string; addr: string; direction: string }[] = [];
    for (const c of this.node.getConnections()) {
      const peerId = c.remotePeer.toString();
      if (seen.has(peerId)) continue;
      seen.add(peerId);
      out.push({ peerId, addr: c.remoteAddr?.toString() ?? "", direction: c.direction ?? "unknown" });
    }
    return out;
  }
}
