// node/src/p2p/Network.ts
// The network abstraction the node logic talks to. The libp2p implementation lives in
// Libp2pNetwork.ts. Keeping the core behind this interface means the transport can change
// (or be tested in process) without touching the ledger or consensus.
export interface ZiraNetwork {
  start(): Promise<void>;
  stop(): Promise<void>;
  publish(topic: string, data: Uint8Array): Promise<void>;
  onMessage(cb: (topic: string, data: Uint8Array, from: string) => void): void;
  /** Provide the frames a peer receives when it syncs from us (the full durable event log). */
  setSyncProvider(fn: () => AsyncIterable<Uint8Array> | Iterable<Uint8Array>): void;
  /** Called for every frame received while syncing from a peer. */
  onSyncFrame(cb: (data: Uint8Array) => void): void;

  /** Register a direct request/response protocol (used for peer to peer model transfer). The handler also
   *  receives the remote peer id of the connection the request arrived on (needed to bind a pushed liveness
   *  assertion to a real connection). */
  handle(protocol: string, handler: (req: Uint8Array, from: string) => AsyncIterable<Uint8Array>): void;
  /** The peer ids of currently-connected bootstrap seeds/masters (a node pushes its liveness to these). */
  seedPeers?(): string[];
  /** Send one request to a specific peer over a protocol and collect the response frames. A stalled peer is
   * abandoned after timeoutMs (default in the implementation) so a caller never hangs indefinitely. */
  request(peerId: string, protocol: string, req: Uint8Array, timeoutMs?: number): Promise<Uint8Array[]>;
  /** Called with the peer id whenever a new peer connects (used to trigger fast sync). */
  onPeerConnect(cb: (peerId: string) => void): void;
  /** Dial a peer by multiaddr at runtime (used to connect to a node a user pasted in). */
  dial(multiaddr: string): Promise<void>;
  /** Ensure a live connection to a peer by its id (dialing by id resolves relay/DHT addresses), so a
   *  subsequent request() has a connection to reuse. Best-effort; returns true if connected afterwards.
   *  Optional so non-libp2p (test) networks need not implement it. */
  ensureConnected?(peerId: string, timeoutMs?: number): Promise<boolean>;

  multiaddrs(): string[];
  peerId(): string;
  peerCount(): number;
  peers(): string[];
  peerMultiaddrs?(): string[];
  /** Live connection detail for the Settings diagnostics view: remote peer id, remote multiaddr, and
   *  dial direction. Optional so non-libp2p (test) networks need not implement it. */
  connections?(): { peerId: string; addr: string; direction: string }[];
}
