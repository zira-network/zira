// node/src/index.ts
// ZIRA Core entry point. Run a peer to peer node that validates every rule, gossips signed events,
// computes Proof of Resonance Locks and checkpoint finality, and serves the Console GUI.
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { genesisId, keypairFromPrivate, hashHex, signRecord, DOMAINS, TASK_DELIVER_TIMEOUT_MS, type Resonator } from "@zira/protocol";
import { loadConfig } from "./config.js";
import { setLogLevel, log } from "./log.js";
import { genesisFor, DEVNET_STEWARD_PRIVATE_KEY } from "./genesis-docs.js";
import { loadOrCreateIdentity } from "./identity.js";
import { Libp2pNetwork } from "./p2p/Libp2pNetwork.js";
import { loadSavedBootstrapPeers, mergeBootstrapPeers, resolveBootstrapPeers } from "./p2p/bootstrapRegistry.js";
import { topics as buildTopics } from "./p2p/topics.js";
import { ZiraNode } from "./core/ZiraNode.js";
import { startRpc } from "./rpc/server.js";
import { startDevnetSeed } from "./devnet-seed.js";

void TASK_DELIVER_TIMEOUT_MS;

async function main(): Promise<void> {
  // Subprocess inference mode: this same bundle, spawned with ZIRA_INFERENCE_SERVER=1, runs ONLY the
  // node-llama-cpp OpenAI-compatible server (no node, no ledger), so model load and generation are fully
  // isolated from a serving node's RPC and consensus event loop. The node points its endpoint here.
  if (process.env.ZIRA_INFERENCE_SERVER === "1") {
    setLogLevel("info");
    const modelPath = process.env.ZIRA_INFERENCE_MODEL || "";
    const port = Number(process.env.ZIRA_INFERENCE_PORT || 8676);
    if (!modelPath) { log.error("ZIRA_INFERENCE_SERVER set but ZIRA_INFERENCE_MODEL missing"); process.exit(1); }
    const { runInferenceServer } = await import("./models/inferenceServer.js");
    await runInferenceServer(modelPath, port);
    return;
  }
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  log.info("starting ZIRA Core", cfg.network);
  // F6: a publicly-bound RPC must carry an admin token to gate sensitive routes. Refuse to start
  // otherwise (was previously only a warning) so a public node can never expose /admin, /tx,
  // /mining, etc. ungated. Loopback binds stay convenient and are protected by the Host-header guard.
  const rpcLoopback = cfg.rpcHost === "127.0.0.1" || cfg.rpcHost === "localhost" || cfg.rpcHost === "::1";
  // F6 reconciled with gateway mode. A public bind is allowed when EITHER an admin token is set (all
  // sensitive routes token-gated, nothing public-readable beyond the safe subset) OR gateway mode is on
  // (the safe public read+query subset is served without a token; every sensitive/mutating/admin route
  // still requires the admin token if one is configured, and is otherwise blocked). Without gateway mode
  // AND without a token, a public bind is still refused. Loopback binds stay convenient (Host-guard).
  if (!rpcLoopback && !cfg.rpcAdminToken && !cfg.gateway) {
    throw new Error(`refusing to start: public RPC bind (${cfg.rpcHost}) requires ZIRA_RPC_ADMIN_TOKEN to gate sensitive routes, or ZIRA_GATEWAY=1 to serve only the safe public read+query subset. Bind RPC to 127.0.0.1, set ZIRA_RPC_ADMIN_TOKEN, or set ZIRA_GATEWAY=1.`);
  }
  if (!rpcLoopback && cfg.gateway) {
    log.info(`gateway mode: public RPC bind (${cfg.rpcHost}) serving the safe public read+query subset; sensitive/admin routes ${cfg.rpcAdminToken ? "require the admin token" : "are blocked (no admin token set)"}`);
  }
  if (cfg.network === "mainnet") {
    if (!cfg.fastSync) log.info("mainnet fast sync disabled; this node will replay the full chain from genesis");
    else log.info("mainnet fast sync on; peer snapshots are adopted only when verified against a finalized master checkpoint (set ZIRA_FULL_SYNC=1 to replay from genesis instead)");
  }

  const genesis = genesisFor(cfg.network, cfg.founderAddress);
  const gid = genesisId(genesis);
  const founders = genesis.founders?.length ? genesis.founders : [genesis.founder];

  // fresh start: wipe local chain identity/state so the node rebuilds from genesis. Heavy model
  // caches can be kept with ZIRA_KEEP_MODELS=1 so launch rehearsals do not re-download GGUF bytes.
  if (process.env.ZIRA_RESET === "1") {
    const resetFiles = ["events.jsonl", "snapshot.json", "mining.json", "provider.json", "storage-peers.json", "founder-backups.json", "zti-history.jsonl", "peers.json", "bootstrap-seeds-cache.json", "identity.json", "peer-key.bin"];
    if (process.env.ZIRA_KEEP_MODELS !== "1") resetFiles.push("models");
    for (const f of resetFiles) {
      try { rmSync(join(cfg.dataDir, f), { recursive: true, force: true }); } catch { /* */ }
    }
    log.info(process.env.ZIRA_KEEP_MODELS === "1" ? "reset: local node state cleared, model cache kept, starting fresh from genesis" : "reset: local node state cleared, starting fresh from genesis");
  }

  // Genesis-migration guard. If this data dir was built on a DIFFERENT genesis (e.g. after a fresh relaunch
  // with new wallets), its old chain history is for a now-abandoned network and the node would stall trying
  // to replay it — the exact "node not reachable" symptom on an upgraded install. We stamp the genesis id in
  // the data dir and, when it changes, clear the incompatible chain/identity state so the node starts cleanly
  // on the current genesis. The model cache (content-addressed, genesis-independent) is intentionally kept.
  try {
    const gidMarker = join(cfg.dataDir, "genesis-id");
    const priorGid = existsSync(gidMarker) ? readFileSync(gidMarker, "utf8").trim() : "";
    // Existing chain state with a missing marker (a data dir from a release before this guard) OR a
    // different marker means the local history belongs to another genesis. Either way it must be cleared.
    const hasState = existsSync(join(cfg.dataDir, "snapshot.json")) || existsSync(join(cfg.dataDir, "events.jsonl"));
    if (hasState && priorGid !== gid) {
      const stale = ["events.jsonl", "snapshot.json", "mining.json", "provider.json", "storage-peers.json", "founder-backups.json", "zti-history.jsonl", "peers.json", "bootstrap-seeds-cache.json", "identity.json", "peer-key.bin"];
      for (const f of stale) { try { rmSync(join(cfg.dataDir, f), { recursive: true, force: true }); } catch { /* */ } }
      log.info(`local state is from a different genesis (${priorGid ? priorGid.slice(0, 12) : "pre-marker"} != ${gid.slice(0, 12)}); cleared it and starting fresh on the current genesis (model cache kept)`);
    }
    mkdirSync(cfg.dataDir, { recursive: true });
    writeFileSync(gidMarker, gid);
  } catch (e) { log.warn("genesis-migration guard skipped", (e as Error).message); }

  const bootstrapDiscovery = await resolveBootstrapPeers({
    explicit: cfg.bootstrap,
    network: cfg.network,
    dataDir: cfg.dataDir,
    authorizedFounders: founders,
    auto: cfg.bootstrapAuto,
    requireSignature: cfg.bootstrapRequireSignature,
    registryUrl: cfg.bootstrapRegistryUrl,
    registryPath: cfg.bootstrapRegistryPath,
  });
  if (bootstrapDiscovery.discovered.length) {
    log.info("automatic bootstrap discovery loaded", `${bootstrapDiscovery.discovered.length} peers from ${bootstrapDiscovery.registriesLoaded} registries`);
  }
  const savedBootstrap = loadSavedBootstrapPeers(cfg.dataDir);
  const startupBootstrap = mergeBootstrapPeers([...bootstrapDiscovery.peers, ...savedBootstrap]);
  if (savedBootstrap.length && startupBootstrap.length > bootstrapDiscovery.peers.length) {
    log.info("saved bootstrap peers loaded", `${savedBootstrap.length} cached peers`);
  }
  if (cfg.network === "mainnet" && startupBootstrap.length === 0) {
    log.warn("mainnet has no bootstrap peers configured, discovered, or cached; this node will not join the public field until a signed seed registry or ZIRA_BOOTSTRAP is available");
  }

  // identity selection: the founder key (steward) if it matches the genesis founder, else the devnet
  // steward for local testing, else a persisted random peer identity.
  let identity;
  if (cfg.founderKey) {
    try {
      const kp = keypairFromPrivate(cfg.founderKey.trim());
      const founders = genesis.founders?.length ? genesis.founders : [genesis.founder];
      if (founders.includes(kp.address)) { identity = kp; log.info("running as an active founder"); }
      else log.warn("ZIRA_FOUNDER_KEY does not match this network's founder, ignoring it");
    } catch { log.warn("ZIRA_FOUNDER_KEY is not a valid key, ignoring it"); }
  }
  const isStewardIdentity = !!identity; // founder key matched above => this node runs steward ops
  if (!identity) {
    const useSteward = cfg.network === "devnet" && process.env.ZIRA_STEWARD === "1";
    identity = loadOrCreateIdentity(cfg.dataDir, useSteward ? DEVNET_STEWARD_PRIVATE_KEY : undefined);
  }

  // MINING WALLET POLICY (public launch): a miner EARNS into whatever wallet `identity` is. By default
  // that is a freshly generated, dedicated wallet persisted at <dataDir>/identity.json — never the
  // steward/founder/anchor-reserve key. The steward key is adopted ONLY when ZIRA_FOUNDER_KEY is set
  // and matches a genesis founder (coordination funding + steward ops). VPS miners must NOT set that
  // key; they just run with ZIRA_MINE=1 and earn on their generated wallet. We surface this explicitly
  // so an operator can never silently mine into the steward wallet without being warned.
  const wantsMining = process.env.ZIRA_MINE === "1" || process.env.ZIRA_MINE === "true";
  if (isStewardIdentity) {
    log.info(`identity is the STEWARD/FOUNDER wallet ${identity.address} (coordination funding + steward ops)`);
    if (wantsMining) log.warn(`ZIRA_MINE is on while running as the steward/founder wallet ${identity.address}: a public MINER should run WITHOUT ZIRA_FOUNDER_KEY so it earns on its own generated wallet, keeping steward keys private`);
  } else {
    log.info(`mining wallet is the node's own generated wallet ${identity.address} (dedicated; no steward/founder key in use)${wantsMining ? ", mining ON" : ""}`);
  }

  const net = new Libp2pNetwork({
    p2pPort: cfg.p2pPort, wsPort: cfg.wsPort, bootstrap: startupBootstrap, announce: cfg.announce,
    topics: buildTopics(gid).all(), dataDir: cfg.dataDir,
    // A publicly reachable node (one that advertises public addresses) runs the circuit relay so
    // peers behind NAT can reach the field through it. NAT'd nodes leave this off and use relays.
    relayServer: cfg.announce.length > 0 || process.env.ZIRA_RELAY === "1",
  });

  const node = new ZiraNode(genesis, identity, net, cfg.dataDir, {
    observeEnabled: cfg.observeEnabled,
    hardwareDetect: cfg.hardwareDetect,
    selfContained: cfg.selfContained,
    serveBaseline: cfg.serveBaseline,
    taskReapMs: cfg.taskReapMs,
    providerConfig: cfg.provider,
    fastSync: cfg.fastSync,
    eventsKey: cfg.eventsKey,
    eventsClaimZir: cfg.eventsClaimZir,
    anchorReserveKey: cfg.anchorReserveKey,
  });
  node.rememberPeers(bootstrapDiscovery.peers);
  await node.start();

  // serve the Console: prefer an explicit dir, then a bundled ./public, then the workspace build
  let consoleDir = cfg.consoleDir;
  if (!consoleDir && cfg.serveConsole) {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [join(here, "public"), resolve(here, "../public"), resolve(here, "../../apps/console/dist")];
    consoleDir = candidates.find((c) => existsSync(c));
  }
  const stopRpc = startRpc(node, { host: cfg.rpcHost, port: cfg.rpcPort, consoleDir: cfg.serveConsole ? consoleDir : undefined, obsRateLimit: cfg.obsRateLimit, freeQueryLimit: cfg.freeQueryLimit, freeQueryWindowMs: cfg.freeQueryWindowMs, freeTierStartMs: cfg.freeTierStartMs, freeTierDurationMs: cfg.freeTierDurationMs, adminToken: cfg.rpcAdminToken, gateway: cfg.gateway });

  const stops: Array<() => void> = [stopRpc];
  // Tier 2 inference serving is owned by the node (started in node.start when provider.enabled), and
  // can be toggled at runtime from the Console via POST /rpc/status.
  if (cfg.network === "devnet" && process.env.ZIRA_SEED === "1") { stops.push(startDevnetSeed(node)); log.info("devnet seeding on"); }

  // the founder publishes the default resonator, ZIRA, from the start. It is owned by the founder and
  // answered by the field, so every user can chat with it right away. Deterministic, so restarts are idempotent.
  if (node.isFounder()) {
    const agent = keypairFromPrivate(hashHex(identity.privateKey + ":zira-default-resonator"));
    const def: Resonator = signRecord({
      id: "zira", owner: genesis.founder, address: agent.address, name: "ZIRA",
      purpose: "The ZIRA assistant, answered by the whole field.",
      systemPrompt: "You are a clear and helpful assistant. Answer the user's question directly and concisely. Do not bring up the network, how you are hosted, or tokens unless the user asks about them. Never use an em dash.",
      domains: [...DOMAINS], modelPref: "zira-field", zti: 0, ztiByDomain: {},
      resonanceEnabled: true, balanceUZIR: 0,
      spendLimits: { perTxUZIR: 0, perDayUZIR: 0, minCounterpartyZti: 0, allowedDomains: [...DOMAINS] },
      totalEarnedUZIR: 0, totalSpentUZIR: 0, jobsDone: 0, priceUZIR: 0, listed: true,
      createdAt: genesis.timestamp, updatedAt: genesis.timestamp, status: "idle",
    }, identity.privateKey) as Resonator;
    node.publishResonator(def);
    log.info("published the default resonator ZIRA");
  }

  const shutdown = async () => {
    log.info("shutting down");
    for (const s of stops) try { s(); } catch { /* ignore */ }
    await node.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => { log.error("fatal", e); process.exit(1); });
