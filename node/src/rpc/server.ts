// node/src/rpc/server.ts
// The local RPC the Console GUI talks to: a small HTTP + WebSocket API over the node, plus serving
// the built Console static files. A user runs a node and opens its address to get the GUI, synced
// by peers. Pointing the Console at your own node is fully trustless for you.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { connect } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import {
  ANCHOR_CLASSES, TOTAL_ANCHOR_SEATS, PROTOCOL, DOMAIN_META, addressFromPubKey, type Domain, type QueryFusion,
} from "@zira/protocol";
import type { BootstrapSeedCandidate, ZiraNode } from "../core/ZiraNode.js";
import type { AnswerMsg } from "../core/types.js";
import { log } from "../log.js";

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".json": "application/json", ".woff2": "font/woff2", ".ico": "image/x-icon", ".png": "image/png",
};

// System prompt for own-task local inference (the user's own hardware, the user's own work). Kept
// distinct from the field provider prompt: this is private local help, not a field answer.
const OWN_TASK_SYSTEM_PROMPT =
  "You are a helpful, accurate, and concise assistant running on the user's own machine. Help build, " +
  "edit, plan, debug, or reason about the user's files and questions. Answer the question directly; do " +
  "not bring up the ZIRA network, how you are hosted, or tokens unless the user asks about them. Never " +
  "use an em dash. Use periods, commas, colons, or parentheses instead.";

/**
 * F5: best-effort client IP for rate limiting. The observation and free-query limiters key on this,
 * NOT on the caller-supplied observer/asker address, so an attacker cannot defeat the caps by
 * rotating freshly-generated identities. (Making identity creation itself costly — stake or PoW —
 * is a separate future protocol upgrade; IP keying closes the trivial rotate-address bypass.)
 */
function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

// Sliding-window rate limiter for observation submissions, keyed on client IP (F5).
const obsRates = new Map<string, { count: number; windowStart: number }>();
function checkObsRate(address: string, limit: number): boolean {
  const now = Date.now();
  const r = obsRates.get(address);
  if (!r || now - r.windowStart > 60_000) { obsRates.set(address, { count: 1, windowStart: now }); return true; }
  r.count++;
  return r.count <= limit;
}

// Free tier for asking the field. Field queries cost nothing to submit, so this caps how many a
// single identity may ask per window, the "limited per pause" free allowance. Paid coordination
// (hiring Resonators, funded tasks) is a separate path and is not limited here. The node's own
// autonomous coordination calls publishQuery directly and never passes through this gate.
const queryRates = new Map<string, { count: number; windowStart: number }>();
function queryQuota(address: string, limit: number, windowMs: number): { limit: number; used: number; remaining: number; resetMs: number; windowMs: number } {
  const now = Date.now();
  const r = queryRates.get(address);
  if (!r || now - r.windowStart > windowMs) return { limit, used: 0, remaining: limit, resetMs: 0, windowMs };
  return { limit, used: r.count, remaining: Math.max(0, limit - r.count), resetMs: Math.max(0, windowMs - (now - r.windowStart)), windowMs };
}
function consumeQuery(address: string, limit: number, windowMs: number): { ok: boolean; remaining: number; resetMs: number } {
  const now = Date.now();
  const r = queryRates.get(address);
  if (!r || now - r.windowStart > windowMs) { queryRates.set(address, { count: 1, windowStart: now }); return { ok: true, remaining: limit - 1, resetMs: windowMs }; }
  if (r.count >= limit) return { ok: false, remaining: 0, resetMs: windowMs - (now - r.windowStart) };
  r.count++;
  return { ok: true, remaining: limit - r.count, resetMs: windowMs - (now - r.windowStart) };
}

// Free-tier sunset. The free allowance is a launch subsidy, not a permanent fixture: it tapers across
// the network's first year (freeTierDurationMs measured from the genesis timestamp) and closes at the
// end of it, after which non-contributors use the ZIR tier (pay the adaptive price) or the Machine tier
// (their own hardware). This is local RPC policy keyed on wall-clock, NOT consensus, so it never touches
// the state root. With no start/duration wired (the default in unit tests) the allowance stays flat at
// the initial limit, so existing behavior is unchanged.
export function effectiveFreeLimit(initial: number, startMs: number | undefined, durationMs: number | undefined, now: number): number {
  if (!startMs || !durationMs || durationMs <= 0) return initial;
  const elapsed = now - startMs;
  if (elapsed <= 0) return initial;
  if (elapsed >= durationMs) return 0;                  // year one is over: the free tier is closed
  const frac = elapsed / durationMs;                    // 0..1 progress through the first year
  return Math.max(1, Math.floor(initial * (1 - frac))); // taper down, keeping at least 1 until the cutoff
}

interface RpcOptions {
  host: string;
  port: number;
  consoleDir?: string;
  obsRateLimit?: number;
  freeQueryLimit?: number;     // free field queries allowed per window per identity (the INITIAL allowance)
  freeQueryWindowMs?: number;  // the free-tier window ("period of pause")
  freeTierStartMs?: number;    // network genesis time; the free-tier taper is measured from here
  freeTierDurationMs?: number; // the free tier closes this long after genesis (default one year)
  adminToken?: string;
  gateway?: boolean;           // public gateway mode: serve the safe public read+query subset without a token
}

export function startRpc(node: ZiraNode, opts: RpcOptions): () => void {
  const server = createServer((req, res) => handle(node, req, res, opts));
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws: WebSocket) => {
    const send = () => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "stats", data: node.stats() })); };
    send();
    const iv = setInterval(send, 4000);
    ws.on("close", () => clearInterval(iv));
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "locks") ws.send(JSON.stringify({ type: "locks", data: node.state.recentLocks(msg.limit ?? 20) }));
      } catch { /* ignore */ }
    });
  });

  server.listen(opts.port, opts.host, () => {
    log.info(`RPC and Console on http://${opts.host}:${opts.port}`);
  });
  return () => { wss.close(); server.close(); };
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-ZIRA-Admin", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" });
  res.end(JSON.stringify(data));
}

function applyCors(req: IncomingMessage, res: ServerResponse, gateway: boolean): void {
  const origin = req.headers.origin;
  if (!origin) return;
  try {
    const u = new URL(origin);
    const isLocal = ["localhost", "127.0.0.1", "::1"].includes(u.hostname);
    // Loopback/desktop nodes only echo CORS to local origins (so a random web page can't read a user's
    // local node through their browser). A PUBLIC GATEWAY serves public, no-cookie data and must be usable
    // from any web/mobile origin, so it reflects any origin; the route allowlist + token still gate writes.
    if (isLocal || gateway) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
  } catch { /* ignore malformed origins */ }
}

// Hard cap on a single request body so a malicious client cannot exhaust memory by streaming an
// unbounded POST. 1 MiB is far above any legitimate ZIRA payload (a tx, query, or model manifest stub).
// Once exceeded we stop accumulating and destroy the socket, resolving to an empty object so the route
// handler rejects it as a normal bad request rather than the process growing without bound.
const MAX_BODY_BYTES = 1 << 20;
async function body(req: IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let s = "";
    let aborted = false;
    req.on("data", (c) => {
      if (aborted) return;
      s += c;
      if (s.length > MAX_BODY_BYTES) { aborted = true; s = ""; try { req.destroy(); } catch { /* already closing */ } resolve({}); }
    });
    req.on("end", () => { if (aborted) return; try { resolve(s ? JSON.parse(s) : {}); } catch { resolve({}); } });
    req.on("error", () => { if (!aborted) { aborted = true; resolve({}); } });
  });
}

async function handle(node: ZiraNode, req: IncomingMessage, res: ServerResponse, opts: RpcOptions): Promise<void> {
  applyCors(req, res, Boolean(opts.gateway));
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const q = url.searchParams;

  if (req.method === "OPTIONS") return json(res, { ok: true });

  // F6: reject cross-host requests on a loopback bind (blocks DNS-rebinding from a browser page).
  if (!hostAllowed(req, opts)) return json(res, { error: "host not allowed" }, 403);

  if (path.startsWith("/rpc/")) {
    try { return await rpc(node, path.slice(4), req, res, q, opts); }
    catch (e) { return json(res, { error: (e as Error).message }, 500); }
  }

  if (opts.consoleDir && existsSync(opts.consoleDir)) return serveStatic(opts.consoleDir, path, res);
  return json(res, { error: "not found", hint: "RPC is under /rpc, the Console is not bundled with this node" }, 404);
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Constant-time string equality. Falls back to a length-mismatch shortcut (lengths are not secret). */
function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function hasAdmin(req: IncomingMessage, token?: string): boolean {
  if (!token) return false;
  const header = req.headers["x-zira-admin"];
  if (typeof header === "string" && safeEq(header, token)) return true;
  const auth = req.headers.authorization;
  return typeof auth === "string" && safeEq(auth, `Bearer ${token}`);
}

/**
 * F6 anti-DNS-rebinding. When the node is bound to loopback, only accept requests whose Host header
 * is a loopback name. A malicious web page that rebinds DNS to 127.0.0.1 still carries its own
 * hostname in the Host header, so this rejects it, while the local Console (Host 127.0.0.1/localhost)
 * passes untouched. For public binds we cannot enumerate every valid hostname, so the admin token is
 * the gate there instead (and the node refuses to start publicly without one).
 */
function hostAllowed(req: IncomingMessage, opts: RpcOptions): boolean {
  if (!isLoopbackHost(opts.host)) return true; // public bind: token-gated, not host-gated
  const raw = req.headers.host ?? "";
  const host = raw.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return host === "" || host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function seedEndpoint(multiaddr: string): { host: string; port: number } | null {
  const parts = multiaddr.split("/").filter(Boolean);
  let host = "";
  let port = 0;
  for (let i = 0; i < parts.length - 1; i++) {
    const token = parts[i];
    const next = parts[i + 1];
    if (token && next && ["ip4", "ip6", "dns4", "dns6"].includes(token)) host = next;
    if (token === "tcp" && next) port = Number(next);
  }
  return host && Number.isInteger(port) && port > 0 ? { host, port } : null;
}

function checkTcpReachable(host: string, port: number, timeoutMs = 2500): Promise<{ ok: boolean; reason: string }> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (ok: boolean, reason: string) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({ ok, reason });
    };
    socket.setTimeout(timeoutMs, () => done(false, `TCP timed out to ${host}:${port}`));
    socket.once("connect", () => done(true, `Public TCP accepted on ${host}:${port}`));
    socket.once("error", (e) => done(false, (e as Error).message || `TCP failed to ${host}:${port}`));
  });
}

function mappedPublicPort(host: string, port: number): boolean {
  const mappingPath = process.env.ZIRA_PUBLIC_MAPPING_PATH || "local-private/public-port-mapping.json";
  try {
    if (!existsSync(mappingPath)) return false;
    const mapping = JSON.parse(readFileSync(mappingPath, "utf8")) as { publicHost?: string; results?: { port?: number; mapped?: boolean }[] };
    if (mapping.publicHost && mapping.publicHost !== host) return false;
    return Array.isArray(mapping.results) && mapping.results.some((row) => row.port === port && row.mapped);
  } catch {
    return false;
  }
}

async function withBootstrapReachability(candidates: BootstrapSeedCandidate[]): Promise<BootstrapSeedCandidate[]> {
  const checked = await Promise.all(candidates.map(async (seed) => {
    if (!seed.shareable) return { ...seed, eligible: false, status: "local" as const };
    const endpoint = seedEndpoint(seed.multiaddr);
    if (!endpoint) {
      return { ...seed, eligible: false, status: "unreachable" as const, reason: "Could not parse public TCP endpoint." };
    }
    const check = await checkTcpReachable(endpoint.host, endpoint.port);
    const mapped = !check.ok && mappedPublicPort(endpoint.host, endpoint.port);
    return {
      ...seed,
      eligible: check.ok || mapped,
      status: check.ok || mapped ? "ready" as const : "unreachable" as const,
      reason: check.ok
        ? check.reason
        : mapped
          ? `Router accepted a public TCP mapping for ${endpoint.host}:${endpoint.port}; local hairpin check did not connect.`
          : check.reason,
      score: check.ok ? seed.score + 500 : mapped ? seed.score + 350 : seed.score,
    };
  }));
  checked.sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.priority - b.priority || a.multiaddr.localeCompare(b.multiaddr));
  return checked;
}

function isPublicCandidateAddr(addr: string): boolean {
  if (!addr.includes("/tcp/") || !addr.includes("/p2p/") || addr.includes("/ws")) return false;
  if (/\/dns[46]\//.test(addr) && !/\/dns[46]\/localhost\//.test(addr)) return true;
  return /\/ip4\//.test(addr)
    && !/\/ip4\/(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.|0\.0\.0\.0)/.test(addr);
}

function numberList(value: string | null, fallback: number[]): number[] {
  if (!value) return fallback;
  const parsed = value.split(",").map((part) => Number(part.trim())).filter((n) => Number.isInteger(n) && n > 0);
  return parsed.length ? parsed : fallback;
}

async function bootstrapPublicHost(q: URLSearchParams): Promise<{ publicHost?: string; publicHostType: string; source: "operator" | "detected" | "none"; error?: string }> {
  const requestedType = q.get("publicHostType");
  const publicHostType = requestedType === "dns4" || requestedType === "dns6" || requestedType === "ip6" ? requestedType : "ip4";
  const explicit = q.get("publicHost")?.trim();
  if (explicit) return { publicHost: explicit, publicHostType, source: "operator" };
  if (q.get("inferPublicHost") !== "1") return { publicHostType, source: "none" };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch("https://api.ipify.org", { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return { publicHostType, source: "none", error: `public IP lookup failed: HTTP ${res.status}` };
    const detected = (await res.text()).trim();
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(detected)) return { publicHostType, source: "none", error: "public IP lookup returned an unsupported address" };
    return { publicHost: detected, publicHostType: "ip4", source: "detected" };
  } catch (e) {
    return { publicHostType, source: "none", error: (e as Error).message || "public IP lookup failed" };
  }
}

async function localRpcNet(port: number, node: ZiraNode, opts: RpcOptions): Promise<{ peerId: string; peers: number } | null> {
  if (port === opts.port) {
    const net = node.netInfo();
    return { peerId: net.peerId, peers: net.peers };
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`http://127.0.0.1:${port}/rpc/net`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const net = await res.json() as { peerId?: string; peers?: number };
    return net.peerId ? { peerId: net.peerId, peers: Number(net.peers ?? 0) } : null;
  } catch {
    return null;
  }
}

async function localMeshBootstrapCandidates(node: ZiraNode, opts: RpcOptions, q: URLSearchParams, publicHost: string | undefined, publicHostType: string): Promise<BootstrapSeedCandidate[]> {
  if (!publicHost || q.get("scanLocalMesh") !== "1") return [];
  const kind = publicHostType === "dns4" || publicHostType === "dns6" || publicHostType === "ip6" ? publicHostType : "ip4";
  const rpcPorts = numberList(q.get("meshRpcPorts"), [8645, 8745, 8845, 8945]);
  const p2pPorts = numberList(q.get("meshP2pPorts"), [9645, 9745, 9845, 9945]);
  const out: BootstrapSeedCandidate[] = [];
  const baseP2pPort = p2pPorts[0] ?? 9645;
  for (let i = 0; i < rpcPorts.length; i++) {
    const rpcPort = rpcPorts[i];
    if (!rpcPort) continue;
    const net = await localRpcNet(rpcPort, node, opts);
    if (!net?.peerId) continue;
    const p2pPort = p2pPorts[i] ?? baseP2pPort + (i * 100);
    const multiaddr = `/${kind}/${publicHost}/tcp/${p2pPort}/p2p/${net.peerId}`;
    const shareable = isPublicCandidateAddr(multiaddr);
    const roles = i === 0 ? ["master", "bootstrap", "community-seed"] : ["master-candidate", "bootstrap", "community-seed"];
    const priority = i + 1;
    out.push({
      multiaddr,
      label: i === 0 ? "Active steward public seed" : `Active mesh public seed ${i + 1}`,
      roles,
      source: i === 0 ? "self" : "connected",
      shareable,
      eligible: shareable,
      status: shareable ? "public-unchecked" : "local",
      reason: shareable ? "Active local node mapped to the provided public host. Check reachability before publishing." : "Provided host is local/LAN and is excluded from public registry downloads.",
      score: 220 + (net.peers * 10) - priority,
      priority,
    });
  }
  return out;
}

function mergeBootstrapCandidates(candidates: BootstrapSeedCandidate[]): BootstrapSeedCandidate[] {
  const byAddr = new Map<string, BootstrapSeedCandidate>();
  for (const candidate of candidates) {
    const current = byAddr.get(candidate.multiaddr);
    if (!current || candidate.score > current.score) byAddr.set(candidate.multiaddr, candidate);
  }
  return [...byAddr.values()].sort((a, b) => Number(b.eligible) - Number(a.eligible) || b.score - a.score || a.priority - b.priority || a.multiaddr.localeCompare(b.multiaddr));
}

// ---- Public gateway access control -------------------------------------------------------------
// A public/gateway bind serves ONLY a SAFE PUBLIC subset without an admin token. The subset is an
// explicit ALLOWLIST (default-deny): a route is public ONLY if it is named here. Everything else —
// every mutating/admin/founder/own-task route, plus reads that expose operator-private state — stays
// blocked on a public bind unless the admin token is presented. This is the inverse of the old
// denylist, so a newly-added route is private-by-default and can never silently leak.
//
// Public GET reads (safe, non-operator state the field already gossips publicly):
const PUBLIC_GET_ROUTES = new Set<string>([
  "/stats", "/net", "/status", "/mining", "/models", "/models/route", "/models/by-type",
  "/supply", "/pricing", "/locks", "/query/quota",
  // explorer / history reads
  "/history", "/events", "/explorer/history",
  // balances/nonce/value/fieldnodes/zti reads are public chain reads
  "/balance", "/nonce", "/value", "/fieldnodes", "/zti", "/zti/history",
  // marketplace / resonators / tasks reads
  "/marketplace", "/resonators", "/resonator", "/resonator/stats", "/tasks", "/task",
  // providers + query reads
  "/providers", "/provider/poll", "/query/answers", "/query/fusion", "/query/result",
  // anchors* + resonators* reads
  "/anchors", "/anchors/classes", "/anchors/seats", "/anchors/mine", "/anchors/listings", "/anchor", "/anchors/event",
  // events status (read), own-task STATUS read (does not run inference), governance/objects reads
  "/events/status", "/own-task/status",
  "/governance/proposals", "/objects", "/agreements", "/recommendations",
]);
// Public POST submits: already IP-rate-limited (F5) and consensus-validated; safe for anonymous web/mobile
// clients. These are the ask/observe/answer paths plus signed-tx submission (a tx must carry a valid
// signature to do anything, so accepting it from the public is safe — the same as any public mempool).
const PUBLIC_POST_ROUTES = new Set<string>([
  "/query", "/observation", "/observations",
  // signed-tx submission paths: the body is a signed transaction; invalid signatures are rejected by state.
  "/tx", "/provider/register", "/provider/answer",
  "/anchors/claim", "/anchors/transfer", "/anchors/list", "/anchors/delist", "/anchors/code-edit",
  "/anchors/position-transfer", "/anchors/activate", "/anchors/set-contributions", "/anchors/contribution", "/events/claim",
  // steward-signed anchor-event toggle: the handler re-verifies the steward signature, so accepting the
  // POST on a public gateway is safe (a non-steward POST is rejected 403 by the handler). This lets the
  // steward turn the event on/off on the shared gateway so every user, on any node, sees the same status.
  "/anchors/event",
  // publishing soft-state resonators/tasks is signed + validated like the field gossip it mirrors.
  "/resonator", "/task",
]);

async function rpc(node: ZiraNode, route: string, req: IncomingMessage, res: ServerResponse, q: URLSearchParams, opts: RpcOptions): Promise<void> {
  const s = node.state;
  const methodRoute = `${req.method} ${route}`;
  // Public-bind access control (default-deny). On a public bind, a request without the admin token is
  // allowed ONLY for the safe public subset: read routes always, and the public submit routes (/query,
  // /observation, signed-tx paths — already F5 IP-rate-limited and signature/consensus-validated) when
  // gateway mode is on. Every sensitive/mutating/admin/founder/own-task route stays blocked unless the
  // admin token is presented. Loopback binds are unaffected (the Host-guard already protects them).
  if (!isLoopbackHost(opts.host) && !hasAdmin(req, opts.adminToken)) {
    const isPublicGet = req.method === "GET" && PUBLIC_GET_ROUTES.has(route);
    const isPublicSubmit = opts.gateway === true && req.method === "POST" && PUBLIC_POST_ROUTES.has(route);
    // Steward-signed read of the contributions queue on a public bind: the steward reviews the queue from
    // the gateway (where all contributions converge) without the founder key on the server. The signature
    // (carried in the query) is verified here and again in the handler.
    const isStewardSignedRead = req.method === "GET" && route === "/anchors/contributions"
      && node.verifyStewardSig(q.get("stewardPubKey") ?? "", q.get("stewardChallenge") ?? "", q.get("stewardSig") ?? "");
    if (!isPublicGet && !isPublicSubmit && !isStewardSignedRead) {
      return json(res, { error: "admin token required for this route on a public RPC bind", gateway: Boolean(opts.gateway) }, 403);
    }
  }
  switch (methodRoute) {
    case "GET /stats": return json(res, node.stats());
    case "GET /treasury": return json(res, node.treasury());
    case "GET /net": return json(res, node.netInfo());
    case "POST /peers/add": { const b = await body(req); return json(res, await node.addPeer(String(b.multiaddr ?? ""))); }
    case "GET /founder/storage-peers": return json(res, { peers: node.storagePeers(), isFounder: node.isFounder() });
    case "POST /founder/storage-peers": { const b = await body(req); return json(res, node.setStoragePeers(Array.isArray(b.peers) ? b.peers.map(String) : [])); }
    case "GET /founder/backups": return json(res, { addresses: node.founderBackups(), isFounder: node.isFounder() });
    case "POST /founder/backups": { const b = await body(req); return json(res, node.setFounderBackups(Array.isArray(b.addresses) ? b.addresses.map(String) : [])); }
    // Steward capability: (re)seed the steward/founder network Resonators and the 512 anchor Resonators,
    // and re-key any whose anchor position changed owner. Gated to the steward/founder identity.
    case "POST /founder/seed-resonators": { const b = await body(req); if (!node.isFounder() && !node.canSteward() && !node.verifyStewardSig(b.stewardPubKey, b.stewardChallenge, b.stewardSig)) return json(res, { error: "only the steward/founder can seed resonators" }, 403); return json(res, node.seedStewardResonators()); }
    case "GET /events/status": return json(res, node.eventsStatus());
    case "POST /events/claim": { const b = await body(req); return json(res, node.claimEvent(String(b.address ?? ""))); }
    case "POST /events/config": { const b = await body(req); if (!node.isFounder() && !node.verifyStewardSig(b.stewardPubKey, b.stewardChallenge, b.stewardSig)) return json(res, { error: "only the founder can configure events" }, 403); return json(res, node.setEventsConfig({ active: b.active, claimZir: b.claimZir })); }
    // Steward Anchor Event toggle (spec §2.1/§6.2): public read so clients can gate the contribute section;
    // steward-gated write so only the steward turns it on/off.
    case "GET /anchors/event": return json(res, node.anchorEventStatus());
    case "POST /anchors/event": { const b = await body(req); if (!node.isFounder() && !node.verifyStewardSig(b.stewardPubKey, b.stewardChallenge, b.stewardSig)) return json(res, { error: "only the steward can toggle the anchor event" }, 403); return json(res, node.setAnchorEvent({ enabled: b.enabled, evm: b.evm, tron: b.tron, wcProjectId: b.wcProjectId })); }
    // Anchor contributions: a contributor's app reports its USDT payment (public, best-effort); the steward
    // reviews the queue (steward-gated). On-chain detection confirms before a seat is assigned.
    case "POST /anchors/contribution": { const b = await body(req); return json(res, node.recordAnchorContribution(b ?? {})); }
    case "GET /anchors/contributions": { if (!node.isFounder() && !node.verifyStewardSig(q.get("stewardPubKey") ?? "", q.get("stewardChallenge") ?? "", q.get("stewardSig") ?? "")) return json(res, { error: "only the steward can view contributions" }, 403); return json(res, node.anchorContributions()); }
    case "GET /founder/bootstrap-candidates": {
      const host = await bootstrapPublicHost(q);
      const view = node.bootstrapSeedCandidates({
        publicHost: host.publicHost,
        publicHostType: host.publicHostType,
        publicP2pPort: q.get("publicP2pPort") ? Number(q.get("publicP2pPort")) : undefined,
      });
      if (view.isFounder) {
        view.candidates = mergeBootstrapCandidates([...view.candidates, ...await localMeshBootstrapCandidates(node, opts, q, host.publicHost, host.publicHostType)]);
        if (q.get("checkReachability") === "1") view.candidates = await withBootstrapReachability(view.candidates);
      }
      return json(res, { ...view, publicHost: host.publicHost ?? "", publicHostType: host.publicHostType, publicHostSource: host.source, publicHostError: host.error }, node.isFounder() ? 200 : 403);
    }
    case "POST /admin/reset": { json(res, { ok: true }); node.wipeAndExit(); return; }
    case "GET /balance": return json(res, { uZIR: s.provisionalBalance(q.get("address") ?? "") });
    case "GET /nonce": return json(res, { nonce: s.provisionalNonce(q.get("address") ?? "") });
    case "POST /tx": { const b = await body(req); return json(res, node.submitTx(b.tx)); }
    // The node's own (mining) wallet key, so the local Console can adopt it as the active wallet (the
    // wallet the node earns into). LOOPBACK-ONLY: even a valid admin token over a public bind is refused,
    // because the raw private key must never cross the network. The desktop app runs the node on 127.0.0.1,
    // so the key is only ever handed to the Console on the same machine.
    case "GET /wallet/export": {
      if (!isLoopbackHost(opts.host)) return json(res, { error: "wallet export is only available on a loopback node" }, 403);
      return json(res, node.exportWallet());
    }
    // Import a wallet as this node's identity (it mines into the imported wallet after a restart). LOOPBACK-ONLY.
    case "POST /wallet/import": {
      if (!isLoopbackHost(opts.host)) return json(res, { error: "wallet import is only available on a loopback node" }, 403);
      const b = await body(req);
      return json(res, node.importIdentity(String(b.privateKey ?? "")));
    }
    case "GET /history": return json(res, history(node, q));
    case "GET /events": return json(res, s.recentHistory(null, int(q, "limit", 100)));
    case "GET /locks": return json(res, s.recentLocks(int(q, "limit", 50)));
    case "GET /value": return json(res, s.valueOf(q.get("subject") ?? ""));
    case "GET /fieldnodes": return json(res, fieldNodes(node, q.get("subject") ?? ""));
    case "POST /observation": {
      const b = await body(req);
      const o = b.obs;
      // inference-only domains are never measured by hand
      if (o && DOMAIN_META[o.domain as Domain]?.observationType === "inference") {
        return json(res, { accepted: false, reason: `domain ${o.domain} is inference-only and cannot accept observations` }, 400);
      }
      if (o && o.observer) {
        if (!checkObsRate(clientIp(req), opts.obsRateLimit ?? 20)) return json(res, { accepted: false, reason: "rate limit: max observations per minute exceeded" }, 429);
      }
      return json(res, node.submitObservation(o));
    }
    case "POST /observations": { const b = await body(req); let n = 0; for (const o of b.obs ?? []) if (node.submitObservation(o).accepted) n++; return json(res, { accepted: n }); }
    case "GET /supply": {
      // Exchange-grade reconciliation computed in EXACT integers (bigint), so it is immune to float64
      // rounding at supply scale (the reserve, ~1.18e16 uZIR, is above 2^53 where not every integer is
      // representable, so a float sum of odd uZIR amounts drifts by a fraction of a ZIR). Account balances
      // are exact integer uZIR (< 2^53 each), so BigInt() is lossless. The invariant an exchange cares
      // about: conservation — every uZIR in existence is held in some account balance (issued − burned ==
      // sum of balances) — plus issuance staying within the earned cap and the 28.7B max supply.
      const R = (n: number) => BigInt(Math.round(n));
      const balanceSum = [...s.accounts.values()].reduce((t, a) => t + R(a.balance), 0n);
      const circulatingExact = R(PROTOCOL.RESERVE_UZIR) + R(s.supply.emitted) - R(s.supply.burned);
      const issued = PROTOCOL.RESERVE_UZIR + s.supply.emitted;
      const earnedCapUZIR = Math.round(PROTOCOL.MAX_SUPPLY_UZIR * PROTOCOL.EARNED_SHARE);
      const auditAgrees =
        balanceSum === circulatingExact &&
        s.supply.emitted <= earnedCapUZIR &&
        issued <= PROTOCOL.MAX_SUPPLY_UZIR;
      return json(res, {
        emitted: s.supply.emitted, burned: s.supply.burned, reserve: s.supply.reserve,
        issued, circulating: issued - s.supply.burned, maxSupplyUZIR: PROTOCOL.MAX_SUPPLY_UZIR,
        auditAgrees, balanceSum: balanceSum.toString(),
      });
    }

    // ---- node + provider status (Tier 1 + Tier 2) ----
    case "GET /status":
    case "GET /mining": return json(res, await node.statusInfo());
    case "POST /status":
    case "POST /mining": { const b = await body(req); await node.applyStatusPatch(b); return json(res, await node.statusInfo()); }
    case "POST /hardware/refresh": { await node.refreshHardware(); return json(res, await node.statusInfo()); }

    // ---- user-controllable peer-to-peer storage (soft infrastructure, NOT ledger/consensus state) ----
    // enabled + capBytes are persisted runtime state in mining.json; the cap defaults to 1 GiB. Gated
    // like other node-owner routes (sensitiveRoute) so a public bind needs the admin token to change it.
    case "GET /storage": return json(res, node.storageState());
    case "POST /storage": {
      const b = await body(req);
      const patch: { enabled?: boolean; capBytes?: number } = {};
      if (typeof b.enabled === "boolean") patch.enabled = b.enabled;
      if (b.capBytes !== undefined && Number.isFinite(Number(b.capBytes))) patch.capBytes = Number(b.capBytes);
      return json(res, await node.setStorage(patch));
    }

    // ---- live, decentralized pricing (everyone computes the same fair price) ----
    case "GET /pricing": return json(res, node.pricing());

    // ---- ZTI ----
    case "GET /zti": { const a = q.get("address") ?? ""; const acct = node.state.accounts.get(a); return json(res, { address: a, zti: acct?.zti ?? 0, ztiByDomain: acct?.ztiByDomain ?? {} }); }
    case "GET /zti/history": return json(res, node.ztiHistory(q.get("address") ?? "", (q.get("domain") as Domain) || undefined, int(q, "limit", 100)));

    // ---- marketplace + resonators ----
    case "GET /marketplace": return json(res, node.soft.marketplace({ sort: q.get("sort") ?? "zti", domain: (q.get("domain") as Domain) || undefined, q: q.get("q") || undefined, limit: int(q, "limit", 50) }));
    case "GET /resonators": return json(res, [...node.soft.resonators.values()].filter((r) => r.owner === q.get("owner")));
    case "GET /resonator": return json(res, node.soft.resonators.get(q.get("id") ?? "") ?? null);
    case "POST /resonator": { const b = await body(req); const ok = node.publishResonator(b.resonator); return json(res, ok ? b.resonator : { error: "rejected: unsigned or stale resonator" }, ok ? 200 : 400); }
    case "GET /resonator/stats": return json(res, resonatorStats(node, q.get("id") ?? "", q.get("window") ?? "7d"));
    case "GET /tasks": {
      // Filter by resonator (so an owner sees every task their Resonator worked, including autonomous
      // coordination whose client is the founder) or by client (the hirer's own tasks).
      const byResonator = q.get("resonator");
      const byClient = q.get("client");
      return json(res, [...node.soft.tasks.values()].filter((t) => byResonator ? t.resonatorId === byResonator : t.client === byClient));
    }
    case "GET /task": return json(res, node.soft.tasks.get(q.get("id") ?? "") ?? null);
    case "POST /task": { const b = await body(req); node.publishTask(b.task); return json(res, b.task); }

    // ---- providers + query fusion ----
    case "GET /providers": return json(res, providers(node));
    case "GET /providers/mine": return json(res, node.inferenceProvider?.lastProfile ?? null);
    case "POST /provider/register": { const b = await body(req); return json(res, { ok: node.publishProvider(b.provider ?? b) }); }
    case "GET /provider/poll": return json(res, node.soft.openQueries((q.get("domains") ? q.get("domains")!.split(",") : []) as Domain[], Date.now()));
    case "POST /provider/answer": { const b = await body(req); return json(res, { ok: node.publishAnswer(b.answer ?? b) }); }
    case "POST /query": {
      const b = await body(req);
      const query = b.query ?? b;
      const fqWindow = opts.freeQueryWindowMs ?? 600_000;
      const fqLimit = effectiveFreeLimit(opts.freeQueryLimit ?? 10, opts.freeTierStartMs, opts.freeTierDurationMs, Date.now());
      // A node that lends its hardware to the field (mining on) gets free, unlimited field questions: it
      // already pays with coordination work, consumes no extra ZIR, and needs no model or storage of its
      // own (other miners answer). Only non-contributors are held to the newcomer free-query allowance.
      const contributing = node.models.miningEnabled();
      // Once the first-year subsidy has closed, non-contributors must use the ZIR tier or their own machine.
      if (!contributing && fqLimit <= 0) {
        return json(res, { ok: false, freeTierEnded: true, limit: 0, reason: "the free tier has ended. fund a wallet to ask with ZIR, or use your own machine (Machine tier)" }, 402);
      }
      const rl = contributing ? null : consumeQuery(clientIp(req), fqLimit, fqWindow);
      if (rl && !rl.ok) return json(res, { ok: false, reason: "free tier reached: too many free questions for now", retryInMs: rl.resetMs, limit: fqLimit, windowMs: fqWindow }, 429);
      node.publishQuery(query);
      return json(res, { ok: true, freeTier: contributing ? { contributor: true, unlimited: true, remaining: -1 } : { limit: fqLimit, remaining: rl!.remaining, resetMs: rl!.resetMs } });
    }
    case "GET /query/quota": {
      if (node.models.miningEnabled()) return json(res, { limit: -1, used: 0, remaining: -1, resetMs: 0, windowMs: 0, contributor: true, unlimited: true });
      const lim = effectiveFreeLimit(opts.freeQueryLimit ?? 10, opts.freeTierStartMs, opts.freeTierDurationMs, Date.now());
      if (lim <= 0) return json(res, { limit: 0, used: 0, remaining: 0, resetMs: 0, windowMs: opts.freeQueryWindowMs ?? 600_000, freeTierEnded: true });
      return json(res, queryQuota(clientIp(req), lim, opts.freeQueryWindowMs ?? 600_000));
    }
    case "GET /query/answers": return json(res, node.soft.answers.get(q.get("id") ?? "") ?? []);
    case "GET /query/fusion": return json(res, queryFusion(node, q.get("id") ?? ""));
    case "GET /query/result": {
      // Bounded wait so asking NEVER hangs forever: wait up to timeoutMs for an answer, then return the
      // fused answer if one arrived, or a clear timed-out result the Console can render ("no answer yet").
      const id = q.get("id") ?? "";
      const timeoutMs = q.get("timeoutMs") ? Number(q.get("timeoutMs")) : undefined;
      const status = await node.awaitQueryAnswer(id, timeoutMs);
      if (!status.ok) return json(res, { ...status, fusion: null });
      const fusion = queryFusion(node, id);
      return json(res, { ...status, fusion });
    }
    case "POST /query/settle": {
      // Multi-LLM coordination settlement: split a funded budget across the models/Resonators that
      // answered this query (weighted by domain ZTI x confidence), with the small steward-ops share.
      // Founder-gated: the funding wallet is the node identity, which must hold the budget.
      const b = await body(req);
      if (!node.isFounder()) return json(res, { error: "only a founder node can settle coordination payouts" }, 403);
      const result = node.settleQueryCoordination(String(b.queryId ?? b.id ?? ""), Number(b.budgetUZIR ?? 0));
      return json(res, result, result.ok ? 200 : 400);
    }

    // ---- own-task local inference: the user's own hardware for the user's own Console/Resonator
    // tasks, decoupled from mining. This never touches the field, never answers others, never earns.
    case "GET /own-task/status": return json(res, { enabled: node.models.ownTaskEnabled(), ready: await node.ownTaskReady(), label: node.models.ownTaskLabel() });
    case "POST /own-task/generate": {
      const b = await body(req);
      const messages = Array.isArray(b.messages) ? b.messages : [];
      const system = typeof b.system === "string" && b.system ? b.system : OWN_TASK_SYSTEM_PROMPT;
      try {
        const answer = await node.generateOwnTask(messages, system);
        return json(res, { answer });
      } catch (e) { return json(res, { error: (e as Error).message }, 400); }
    }

    // ---- launch-authority model advisory ----
    case "GET /recommendations": return json(res, node.soft.listRecommendations());
    case "POST /recommendations": {
      const b = await body(req);
      if (!node.founderServices) return json(res, { error: "not a founder node" }, 403);
      return json(res, node.founderServices.publishRecommendation({ label: String(b.label ?? ""), backendHint: String(b.backendHint ?? ""), domains: (b.domains ?? []) as Domain[], notes: String(b.notes ?? "") }));
    }

    // ---- model field: everyone sees the field's models (for the chat picker + mining); only active
    // launch authority may introduce one. The console build never bundles model-management code (CI-gated).
    case "GET /models": return json(res, node.models.knownModels());
    case "GET /models/by-type": return json(res, node.models.modelsByType());
    case "GET /models/route": {
      // Diagnostic: which models the field would route a query in this domain to (preferred type first).
      const domain = (q.get("domain") ?? "general") as Domain;
      return json(res, { domain, modelId: node.models.modelForDomain(domain), candidates: node.models.modelsForDomain(domain).map((m) => ({ id: m.id, name: m.name, type: m.type ?? "text", domains: m.domains ?? [] })) });
    }
    case "POST /models/provide": { const b = await body(req); if (!node.isFounder()) return json(res, { error: "only active launch authority can add a model to the field. Import an authorized wallet to use wallet authorization." }, 403); try {
      const meta = b.path
        ? await node.models.provide(String(b.path), String(b.name ?? "model"), { arch: b.arch, quant: b.quant, url: b.url, type: b.type, domains: b.domains, tags: b.tags, version: b.version })
        : await node.models.provideByUrl(String(b.url), String(b.name ?? "model"), { arch: b.arch, quant: b.quant, type: b.type, domains: b.domains, tags: b.tags, version: b.version });
      return json(res, meta);
    } catch (e) { return json(res, { error: (e as Error).message }, 400); } }
    case "POST /models/prepare": { const b = await body(req); try {
      const input = b.input ?? {};
      const meta = await node.models.prepareByUrl({
        url: String(input.url ?? ""), name: String(input.name ?? "model"), arch: input.arch, quant: input.quant,
        type: input.type, domains: input.domains, tags: input.tags, version: input.version, ts: Number(input.ts ?? 0),
      }, String(b.founderPubKey ?? ""), String(b.requestSig ?? ""));
      return json(res, meta);
    } catch (e) { return json(res, { error: (e as Error).message }, 400); } }
    case "POST /models/authorize": { const b = await body(req); try {
      return json(res, node.models.authorizePrepared(b.meta, String(b.founderPubKey ?? ""), String(b.manifestSig ?? "")));
    } catch (e) { return json(res, { error: (e as Error).message }, 400); } }
    case "POST /models/fetch": { const b = await body(req); try { const ok = await node.models.fetch(String(b.id)); return json(res, { ok }); } catch (e) { return json(res, { error: (e as Error).message }, 400); } }

    // ---- anchors: consensus-visible ZRC-1 structural seats, activation future-gated ----
    case "GET /anchors": return json(res, s.anchorSeats());
    case "GET /anchors/classes": return json(res, anchorClasses());
    case "GET /anchors/seats": return json(res, anchorSeats(node, q));
    case "GET /anchors/mine": return json(res, s.anchorsOwnedBy(q.get("owner") ?? ""));
    case "GET /anchors/listings": return json(res, s.anchorListings());
    case "GET /anchor": return json(res, s.anchorSeat(q.get("id") ?? ""));
    case "POST /anchors/claim":
    case "POST /anchors/transfer":
    case "POST /anchors/list":
    case "POST /anchors/delist":
    case "POST /anchors/code-edit":
    case "POST /anchors/position-transfer":
    case "POST /anchors/set-contributions":
    case "POST /anchors/activate": { const b = await body(req); return json(res, node.submitTx(b.tx)); }

    // ---- steward assigns anchor seats by CONTRIBUTION (no codes): transfer a reserve-held position to the
    // confirmed contributor's address, which opens its one-year vesting. See /anchors/contributions. ----
    // Steward (founder) transfers positions it owns out to a chosen address: single or batch in one op.
    case "POST /anchors/transfer-positions": { if (!node.isFounder()) return json(res, { error: "only the founder can transfer steward positions" }, 403); const b = await body(req); const seatIds = Array.isArray(b.seatIds) ? b.seatIds.map(String) : (b.seatId ? [String(b.seatId)] : []); return json(res, node.transferAnchorPositions(seatIds, String(b.to ?? ""))); }

    // ---- governance (types defined; execution coming soon) ----
    case "GET /governance/proposals": return json(res, []);
    case "POST /governance/propose": return json(res, { status: "coming_soon" }, 501);
    case "POST /governance/vote": return json(res, { status: "coming_soon" }, 501);

    // ---- ZRC-1 objects + intelligent agreements (types defined; execution coming soon) ----
    case "GET /objects":
    case "POST /objects":
    case "GET /agreements":
    case "POST /agreements": return json(res, { status: "coming_soon" }, 501);

    case "GET /founder/grants": return json(res, s.recentHistory(null, 500).filter((e) => e.kind === "reserve_grant" && e.from !== ""));
    default: return json(res, { error: `no route for ${req.method} ${route}` }, 404);
  }
}

function int(q: URLSearchParams, k: string, def: number): number { const v = q.get(k); return v ? parseInt(v, 10) : def; }

function history(node: ZiraNode, q: URLSearchParams) {
  const address = q.get("address");
  const type = q.get("type");
  const from = q.get("from") ? Number(q.get("from")) : null;
  const to = q.get("to") ? Number(q.get("to")) : null;
  const limit = int(q, "limit", 50);
  let rows = node.state.recentHistory(address, 2000);
  if (from !== null) rows = rows.filter((e) => e.timestamp >= from);
  if (to !== null) rows = rows.filter((e) => e.timestamp <= to);
  if (type) {
    // typed rewards: reward_consensus|reward_inference|reward_agent map onto the single reward kind for now
    if (type.startsWith("reward")) rows = rows.filter((e) => e.kind === "reward");
    else rows = rows.filter((e) => e.kind === type);
  }
  return rows.slice(0, limit);
}

function fieldNodes(node: ZiraNode, subject: string) {
  void subject;
  return [...node.state.accounts.values()].filter((a) => a.zti > 0).slice(0, 50).map((a) => ({
    pubKey: a.pubkey, zti: a.zti, ztiByDomain: a.ztiByDomain, online: true, isMaster: a.isMaster,
  }));
}

/** Merged provider view: online presence (with ZTI, for chat fusion + tipping) plus signed profiles. */
function providers(node: ZiraNode) {
  const now = Date.now();
  const online = node.soft.onlineProviders(now);
  const profiles = new Map(node.soft.listProviderProfiles().map((p) => [p.address, p]));
  return online.map((p) => {
    const prof = profiles.get(p.address);
    return {
      pubKey: p.pubKey, address: p.address, label: prof?.label ?? p.label, model: p.model,
      domains: prof?.domains ?? p.domains, zti: node.state.accounts.get(p.address)?.zti ?? 0,
      tokensPerSec: prof?.tokensPerSec ?? 0, contextWindowTokens: prof?.contextWindowTokens ?? 0,
      supportsStreaming: prof?.supportsStreaming ?? false, modelHint: prof?.modelHint, updatedAt: prof?.updatedAt ?? p.ts,
    };
  });
}

function queryFusion(node: ZiraNode, id: string): QueryFusion | { error: string } {
  const query = node.soft.queries.get(id);
  const domain = query?.domain ?? "general";
  const answers = node.soft.answers.get(id) ?? [];
  if (answers.length === 0) return { error: "no answers for this query" };
  // ZIRA multi-intelligence fusion: many models/Resonators coordinate on one query. Weight each
  // contribution by its trust IN THIS DOMAIN (falling back to overall trust) times its self-reported
  // confidence — domain ZTI x confidence — so the most domain-credible voices dominate. Keep only the
  // latest answer per provider so one model cannot stuff the vote with repeats.
  const latest = new Map<string, AnswerMsg>();
  for (const a of [...answers].sort((x, y) => x.ts - y.ts)) latest.set(a.provider, a);
  const scored = [...latest.values()].map((a) => {
    const addr = addressFromPubKey(a.provider);
    const acct = node.state.accounts.get(addr);
    const zti = Math.max(0.05, acct?.ztiByDomain?.[domain] ?? acct?.zti ?? 0.05);
    return { address: addr, zti, confidence: a.confidence, raw: zti * a.confidence, answer: a.answer };
  });
  const wsum = scored.reduce((x, a) => x + a.raw, 0) || 1;
  const contributors = scored
    .map((a) => ({ address: a.address, zti: Number(a.zti.toFixed(3)), weight: Number((a.raw / wsum).toFixed(3)), answerSnippet: a.answer.slice(0, 200) }))
    .sort((a, b) => b.weight - a.weight);
  // Aggregate, don't just pick one: lead with the highest-weighted answer, then attach the distinct
  // supporting perspectives from the other weighted contributors so the result reflects the coordinated
  // panel rather than a single model. Near-duplicate answers are folded in by weight, not repeated.
  const ranked = scored.slice().sort((a, b) => b.raw - a.raw);
  const lead = ranked[0]!;
  const supporting = ranked.slice(1).filter((a) => a.raw > 0 && !isNearDuplicate(a.answer, lead.answer));
  const fusedAnswer = supporting.length === 0
    ? lead.answer
    : [lead.answer, "", "Supporting perspectives from coordinating models:",
       ...supporting.slice(0, 4).map((a, i) => `${i + 1}. ${a.answer.trim()}`)].join("\n");
  return {
    queryId: id,
    contributors,
    fusedAnswer,
    confidenceScore: Number(contributors.reduce((x, c) => x + c.weight * c.zti, 0).toFixed(2)),
    domain,
  };
}

/** True when two answers share most of their significant vocabulary, so fusion folds them by weight
 * instead of listing the same point twice. */
function isNearDuplicate(a: string, b: string): boolean {
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  const sa = words(a), sb = words(b);
  if (sa.size === 0 || sb.size === 0) return false;
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared++;
  return shared / Math.min(sa.size, sb.size) >= 0.8;
}

function resonatorStats(node: ZiraNode, id: string, window: string) {
  const days = window.endsWith("d") ? parseInt(window, 10) || 7 : 7;
  const since = Date.now() - days * 86_400_000;
  const tasks = [...node.soft.tasks.values()].filter((t) => t.resonatorId === id && t.createdAt >= since);
  const assigned = tasks.length;
  const completed = tasks.filter((t) => t.status === "released" || t.status === "verified").length;
  const expired = tasks.filter((t) => t.status === "expired" || t.status === "refunded").length;
  const disputed = tasks.filter((t) => t.status === "disputed").length;
  const totalEarned = tasks.filter((t) => t.status === "released").reduce((x, t) => x + t.budgetUZIR, 0);
  const respTimes = tasks.filter((t) => t.assignedAt && t.deliveredAt).map((t) => (t.deliveredAt! - t.assignedAt!));
  const avgResponseMs = respTimes.length ? Math.round(respTimes.reduce((a, b) => a + b, 0) / respTimes.length) : 0;
  return { id, window, assigned, completed, expired, disputed, totalEarnedUZIR: totalEarned, avgResponseMs };
}

function anchorClasses() {
  return Object.entries(ANCHOR_CLASSES).map(([code, c]) => ({ class: code, ...c }));
}
function anchorSeats(node: ZiraNode, q: URLSearchParams) {
  const seats = node.state.anchorSeats();
  const owner = q.get("owner");
  if (owner) return seats.filter((a) => a.owner === owner);
  const byClass = Object.entries(ANCHOR_CLASSES).map(([code, c]) => {
    const classSeats = seats.filter((a) => a.classCode === code);
    const taken = classSeats.filter((a) => a.owner).length;
    const listed = classSeats.filter((a) => a.status === "listed").length;
    return { class: code, name: c.name, total: c.seats, taken, listed, available: c.seats - taken };
  });
  void TOTAL_ANCHOR_SEATS;
  return { total: seats.length, classes: byClass, seats };
}

function serveStatic(dir: string, path: string, res: ServerResponse): void {
  let rel = normalize(path).replace(/^(\.\.[/\\])+/, "");
  if (rel === "/" || rel === "\\") rel = "/index.html";
  let file = join(dir, rel);
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dir, "index.html"); // SPA fallback
  if (!existsSync(file)) { res.writeHead(404); res.end("not found"); return; }
  const ext = extname(file);
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}
