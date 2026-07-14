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
import { peerIdFromString, peerIdFromPrivateKey } from "@libp2p/peer-id";
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
    const privateKey = await this.loadOrCreatePeerKey();
    // Pin the round-critical seed/master peers into the gossip mesh as DIRECT PEERS: gossipsub keeps a
    // maintained connection to them AND always keeps them in the topic mesh, never pruning them in favor of
    // the many external peers. The 2026-07-10 finality freeze was exactly this failure mode — the box1
    // masters stayed "connected" yet gossipsub pruned them out of each other's mesh under peer crowding, so
    // votes/heartbeats stopped propagating between masters and quorum finality froze at a fixed epoch. Direct
    // peers are derived from the configured seed/announce multiaddrs (the dialable masters), excluding self.
    let selfId: string | undefined;
    try { selfId = peerIdFromPrivateKey(privateKey).toString(); } catch { /* best effort; self-filter below just no-ops */ }
    const directPeers = [...new Set([...this.opts.bootstrap, ...this.opts.announce])]
      .map((a) => { try { return multiaddr(a); } catch { return null; } })
      .filter((ma): ma is ReturnType<typeof multiaddr> => !!ma && !!ma.getPeerId() && ma.getPeerId() !== selfId)
      .map((ma) => ({ id: peerIdFromString(ma.getPeerId()!), addrs: [ma] }));
    if (directPeers.length) log.info(`gossipsub: pinning ${directPeers.length} direct peer(s) (round-critical seeds/masters, never pruned)`);
    const pubsub = gossipsub({ allowPublishToZeroTopicPeers: true, emitSelf: false, fallbackToFloodsub: true, ...(directPeers.length ? { directPeers } : {}) });

    // SEEDS-ONLY recovery isolation. When ZIRA_SEEDS_ONLY=1 the node connects ONLY to its configured
    // seed/master peers and refuses every other dial or inbound connection. This is the operational cure for
    // a network-wide finality stall: a large stuck mesh (100+ nodes) relays a self-sustaining gossip storm —
    // re-gossiped votes/observations/txs across the whole unfinalized window — through even a few connections,
    // and the constant signature-verify + apply churn keeps the co-located masters pegged and re-injects
    // community state, so the masters can never agree on a forward root long enough to finalize past the frozen
    // epoch. Cutting the masters down to just each other lets them converge in isolation and push finality
    // forward; once they lead, the flag is cleared and the community re-syncs to the new finalized epoch.
    const seedsOnly = process.env.ZIRA_SEEDS_ONLY === "1";
    const seedIdSet = this.seedPeerIds();
    if (seedsOnly) log.info(`SEEDS-ONLY isolation active: accepting only ${seedIdSet.size} seed/master peer(s), refusing all community connections (recovery mode)`);
    const connectionGater = seedsOnly
      ? {
          denyDialPeer: async (peerId: { toString(): string }) => !seedIdSet.has(peerId.toString()),
          denyInboundEncryptedConnection: async (peerId: { toString(): string }) => !seedIdSet.has(peerId.toString()),
        }
      : undefined;

    this.node = await createLibp2p({
      privateKey,
      addresses: { listen, announce: this.opts.announce.length ? this.opts.announce : undefined },
      ...(connectionGater ? { connectionGater } : {}),
      // F7: bound inbound connection pressure so a public node cannot be exhausted by a flood of
      // dials. maxConnections is generous for a healthy mesh; excess connections are pruned by libp2p.
      connectionManager: {
        maxConnections: this.maxConnections,
        maxIncomingPendingConnections: 32,
      },
      // circuitRelayTransport reservation tuning (R2): a NAT/CGNAT node reserves a relay slot on a public
      // node so the masters can reach it (reverse liveness probe) and it can serve the field. The default
      // reservation-completion timeout is too tight for a busy public relay, so reservations aborted with a
      // TimeoutError and the home node never got a /p2p-circuit address (diagnosed live 2026-07-14: 0 of 8
      // reservations succeeded). Give the handshake room, and try a few relays at once so one slow/full relay
      // does not strand the node.
      transports: [tcp(), webSockets(), circuitRelayTransport({
        reservationCompletionTimeout: Number(process.env.ZIRA_RELAY_RESERVE_TIMEOUT_MS ?? 20_000),
        reservationConcurrency: Number(process.env.ZIRA_RELAY_RESERVE_CONCURRENCY ?? 3),
      })],
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
        // Public nodes (the VPS, bootstrap) relay for peers stuck behind NAT. The default reservation cap is
        // only 15 slots, so the public relays filled up and refused new home nodes (RESERVATION_REFUSED,
        // diagnosed live 2026-07-14) — far too few for the field's home-node count. Raise it well past the
        // expected home-node population so every NAT miner can hold a relay slot and stay reachable.
        ...(this.opts.relayServer ? { relay: circuitRelayServer({
          reservations: { maxReservations: Number(process.env.ZIRA_RELAY_MAX_RESERVATIONS ?? 1024) },
        }) } : {}),
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

    // If a seed/master connection drops, re-dial it IMMEDIATELY rather than waiting for the periodic sweep,
    // so the window where the masters cannot probe us (and we silently stop being vouched) is as short as
    // possible. A home node behind NAT losing its master link is the main cause of "1-2 peers, flapping,
    // never earning" — this closes the gap to the next dial instead of up to a full sweep interval.
    this.node.addEventListener("peer:disconnect", (evt: any) => {
      const peer = evt.detail?.toString?.();
      if (peer && this.seedPeerIds().has(peer)) void this.redialSeed(peer);
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
  private pingFails = new Map<string, number>();   // consecutive keepalive-ping misses per peer
  private async keepAliveSweep(): Promise<void> {
    if (!this.node) return;
    const pinger: any = this.node.services?.ping;
    if (!pinger || typeof pinger.ping !== "function") return;
    const conns = this.node.getConnections();
    const seen = new Set<string>();
    await Promise.allSettled(conns.map(async (c) => {
      const id = c.remotePeer.toString(); seen.add(id);
      try {
        await pinger.ping(c.remotePeer, { signal: AbortSignal.timeout(15_000) });
        this.pingFails.delete(id);   // responsive again: reset the miss counter
      } catch {
        // A busy-but-ALIVE master (co-located, hundreds of connections) is often slow to answer a single ping.
        // Do NOT drop it on one timeout, or a home node churns off the masters and drifts to a single relay peer
        // (the "degraded, 1 peer" state). Close only after several consecutive misses = genuinely dead.
        const n = (this.pingFails.get(id) ?? 0) + 1;
        this.pingFails.set(id, n);
        if (n >= 3) { this.pingFails.delete(id); try { await c.close(); } catch { /* pruned; discoverySweep redials */ } }
      }
    }));
    for (const id of [...this.pingFails.keys()]) if (!seen.has(id)) this.pingFails.delete(id);   // forget gone peers
  }

  /** Dial all configured bootstrap + announce seeds in parallel (best effort). */
  private async dialAllSeeds(): Promise<void> {
    const seeds = [...new Set([...this.opts.bootstrap, ...this.opts.announce])]
      .filter((a) => a.startsWith("/") && a.includes("/p2p/"));
    await Promise.allSettled(seeds.map((addr) => this.dialQuiet(addr)));
  }

  /** Periodic sweep: ALWAYS keep the masters held, then (while under target) discover more peers. */
  private async discoverySweep(): Promise<void> {
    if (!this.node) return;
    // Keep the seed/master connections up FIRST, even when we are already at the peer target. Staying
    // connected to the masters is what earns — they liveness-probe over that same connection — and a node
    // can otherwise sit at TARGET_PEERS on DHT-discovered HOME peers while silently disconnected from every
    // master, so it never gets vouched and never earns even though it "looks" healthy. Cheap: it only dials
    // the seeds we are not already connected to.
    await this.ensureSeedsConnected();
    if (this.peerCount() >= TARGET_PEERS) return;       // enough peers; skip extra DHT discovery
    if (this.peerCount() >= this.maxConnections) return; // respect the F7 cap
    await this.discoverViaDHT();
  }

  /** The peer ids of our configured seeds/masters, parsed from their /p2p/<id> multiaddrs. */
  private seedPeerIds(): Set<string> {
    const ids = new Set<string>();
    for (const a of [...this.opts.bootstrap, ...this.opts.announce]) {
      const m = /\/p2p\/([A-Za-z0-9]+)/.exec(a);
      if (m?.[1]) ids.add(m[1]);
    }
    return ids;
  }

  /** Re-dial every configured seed/master we are NOT currently connected to. Keeps the masters held even
   *  once the general peer target is met, so a node never drifts off all masters and quietly stops earning. */
  private async ensureSeedsConnected(): Promise<void> {
    if (!this.node) return;
    const connected = new Set(this.node.getConnections().map((c) => c.remotePeer.toString()));
    const seeds = [...new Set([...this.opts.bootstrap, ...this.opts.announce])]
      .filter((a) => a.startsWith("/") && a.includes("/p2p/"));
    await Promise.allSettled(seeds.map(async (addr) => {
      const m = /\/p2p\/([A-Za-z0-9]+)/.exec(addr);
      if (m?.[1] && connected.has(m[1])) return;        // already connected to this master
      await this.dialQuiet(addr);
    }));
  }

  /** Immediately re-dial a specific seed/master by peer id (used the instant one disconnects). */
  private async redialSeed(peerId: string): Promise<void> {
    const addr = [...new Set([...this.opts.bootstrap, ...this.opts.announce])].find((a) => a.includes(`/p2p/${peerId}`));
    if (addr) await this.dialQuiet(addr);
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

  // Per-peer sync cooldown. A churning peer (connect -> sync -> drop -> reconnect) must not be able to
  // re-trigger a full backfill pull faster than this, or dozens of NAT peers cycling per minute pull a
  // sync-stream each and saturate the event loop — the node then gets too busy to process the vote gossip
  // that carries finality (the 2026-07 co-located-master finality freeze: masters pegged a core on the
  // community reconnect flood and could never re-reach quorum). Consensus-neutral: only gates WHEN a
  // backfill is pulled, never what is applied.
  private lastSyncFromPeerAt = new Map<string, number>();
  private static readonly SYNC_FROM_PEER_COOLDOWN_MS = 120_000;

  private async syncFromPeer(peerIdStr: string): Promise<void> {
    if (!this.node) return;
    // Only auto-pull a backfill sync from SEED/master peers. A random community node that briefly connects
    // has LESS state than we do, so pulling its sync stream is pointless work; and with many NAT peers
    // reconnecting per minute those pulls saturate the loop and freeze finality. Community nodes still
    // converge by pulling FROM us (we are their seed). When no seeds are configured (never on mainnet) we
    // keep the old behavior so a seedless devnet still bootstraps.
    const seeds = this.seedPeerIds();
    if (seeds.size > 0 && !seeds.has(peerIdStr)) return;
    if (this.syncedPeers.has(peerIdStr)) return;
    const now = Date.now();
    const last = this.lastSyncFromPeerAt.get(peerIdStr) ?? 0;
    if (now - last < Libp2pNetwork.SYNC_FROM_PEER_COOLDOWN_MS) return;   // recently synced this peer; skip churn re-sync
    this.lastSyncFromPeerAt.set(peerIdStr, now);
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

  handle(protocol: string, handler: (req: Uint8Array, from: string) => AsyncIterable<Uint8Array>): void {
    if (!this.node) { this.pendingHandlers.push([protocol, handler]); return; }
    void this.registerHandler(protocol, handler);
  }

  /** Connected peers whose id is one of our configured seeds/masters. A miner pushes its signed liveness to
   *  these over its own outbound connection, so it stays vouched even when the reverse probe cannot reach it. */
  seedPeers(): string[] {
    if (!this.node) return [];
    const seeds = this.seedPeerIds();
    return [...new Set(this.node.getConnections().map((c) => c.remotePeer.toString()))].filter((p) => seeds.has(p));
  }
  private pendingHandlers: Array<[string, (req: Uint8Array, from: string) => AsyncIterable<Uint8Array>]> = [];
  private async registerHandler(protocol: string, handler: (req: Uint8Array, from: string) => AsyncIterable<Uint8Array>): Promise<void> {
    await this.node!.handle(protocol, ({ stream, connection }) => {
      const from = connection?.remotePeer?.toString?.() ?? "";
      void pipe(
        stream,
        (s) => lp.decode(s),
        async function* (source) {
          let req: Uint8Array | undefined;
          for await (const f of source) { req = f.subarray(); break; }
          if (!req) return;
          yield* handler(req, from);
        },
        (s) => lp.encode(s),
        stream,
      ).catch((e) => log.debug("protocol handler error", (e as Error).message));
    });
  }

  async request(peerIdStr: string, protocol: string, req: Uint8Array, timeoutMs = 25_000): Promise<Uint8Array[]> {
    if (!this.node) return [];
    const conns = this.node.getConnections().filter((c) => c.remotePeer.toString() === peerIdStr);
    if (!conns.length) throw new Error("not connected to peer " + peerIdStr);
    // Try a FULL (non-limited) connection first. A limited connection — a circuit-relay v2 hop, which is how a
    // peer behind NAT is often reached — rejects opening a normal protocol stream, so if we picked it the
    // request would fail even though the peer is perfectly reachable. That made a huge share of connected
    // miners look "unreachable" to the liveness probe and never get vouched or paid. We order full connections
    // first, fall back to any (opening the stream on a limited conn via runOnLimitedConnection), and move to
    // the next connection if one cannot carry the stream.
    const isLimited = (c: unknown): boolean => Boolean((c as { limits?: unknown; transient?: unknown }).limits ?? (c as { transient?: unknown }).transient);
    const ordered = [...conns.filter((c) => !isLimited(c)), ...conns.filter(isLimited)];
    let lastErr: unknown;
    for (const conn of ordered) {
      let stream;
      try { stream = await conn.newStream(protocol, isLimited(conn) ? { runOnLimitedConnection: true } as never : undefined); }
      catch (e) { lastErr = e; continue; }   // this connection cannot carry the stream: try the next one
      const frames: Uint8Array[] = [];
      // A peer can open the stream and then stall forever (accepts the request, never responds). Bound every
      // request: on timeout, abort the stream and try the next connection / caller falls through.
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
        lastErr = e;   // try the next connection to this peer, if any
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    throw lastErr ?? new Error("no usable connection to " + peerIdStr);
  }

  async dial(addr: string): Promise<void> {
    if (!this.node) throw new Error("node not started");
    // A busy public master accepts the TCP quickly but is slow to finish the encrypted libp2p handshake
    // (noise + mux + identify) under load, so the default dial timeout aborts before it completes and a home
    // node fails to hold the masters. Give the handshake room so slow-but-alive masters actually connect.
    await this.node.dial(multiaddr(addr), { signal: AbortSignal.timeout(Number(process.env.ZIRA_DIAL_TIMEOUT_MS ?? 30_000)) });
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
