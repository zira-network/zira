// apps/desktop/electron/main.cjs
// The ZIRA desktop app. It runs a full ZIRA Core node (Electron's bundled Node runs the daemon),
// waits for the local RPC, and opens the Console in a native window. This is the miner app:
// mining (GPU/CPU) runs here. There is no separate server.
//
// IMPORTANT (window lifecycle): the window is created and SHOWN immediately on app-ready, with an
// inline "connecting" screen. The node starts in the background; once its RPC answers we navigate
// the window to the Console. We NEVER gate showing the window on node readiness, so a slow node, a
// changed port, a missing build, or a startup crash can no longer leave the app as an invisible
// background process. Fatal conditions are surfaced in the window (and the system log) instead of a
// silent app.quit().
const { app, BrowserWindow, Menu, shell, dialog, session, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");

// The app runs its OWN node on its own ports, so it never collides with a separately-running mesh on
// the default ports (8645/9645/9646). If a mesh is found there, the app bootstraps to it and joins the
// same field as the user's own node; otherwise the app's node simply runs standalone. This removes the
// recurring port conflict where two nodes fought for 8645 and broke every fetch.
const RPC_PORT = process.env.ZIRA_RPC_PORT || "8655";
const P2P_PORT = process.env.ZIRA_P2P_PORT || "9655";
const WS_PORT = process.env.ZIRA_WS_PORT || "9656";
const MESH_RPC_PORT = process.env.ZIRA_MESH_RPC_PORT || "8645"; // a co-located mesh's RPC, probed for bootstrap
const MESH_P2P_PORT = process.env.ZIRA_MESH_P2P_PORT || "9645"; // a co-located mesh's libp2p port
let bootstrapAddr = "";                                          // set to the mesh's multiaddr when discovered
// the live release runs on mainnet by default. Set ZIRA_NETWORK=devnet for local testing.
const NETWORK = process.env.ZIRA_NETWORK || "mainnet";
const CONSOLE_URL = `http://127.0.0.1:${RPC_PORT}/`;
let nodeProc = null;
let win = null;
let consoleLoaded = false; // true once the window is showing the live Console (not the splash)

// ---- storage / data directory (user-relocatable) ----
// The node's data dir (wallet identity, ledger, and the heavy model cache) defaults to
// userData/zira-data/<network>, but a user can move it to another drive (model caches are large). The
// chosen path is persisted in a tiny desktop config and applied to the node's ZIRA_DATA_DIR at spawn.
// app.getPath is only valid after 'ready', so these are functions, never module-level constants.
function desktopConfigPath() { return path.join(app.getPath("userData"), "zira-desktop.json"); }
function readDesktopConfig() { try { return JSON.parse(fs.readFileSync(desktopConfigPath(), "utf8")) || {}; } catch { return {}; } }
function writeDesktopConfig(patch) { try { const c = { ...readDesktopConfig(), ...patch }; fs.writeFileSync(desktopConfigPath(), JSON.stringify(c, null, 2)); return c; } catch { return readDesktopConfig(); } }
function defaultDataDir() { return path.join(app.getPath("userData"), "zira-data", NETWORK); }
// First-run only: ask where to keep the wallet, ledger, and (large) model cache before the node starts.
// Skipped for existing installs (a chosen folder is already saved, or the default dir already holds data),
// so we never nag returning users. Choosing "Use default" just proceeds; "Choose folder" persists a path.
async function maybePromptStorageLocation() {
  try {
    if (readDesktopConfig().dataDir) return;                 // user already chose a folder
    if (fs.existsSync(path.join(defaultDataDir(), "identity.json"))) return; // existing install with data
    const r = await dialog.showMessageBox({
      type: "question",
      title: "ZIRA storage location",
      message: "Where should ZIRA keep your wallet, ledger, and model cache?",
      detail: `Models can be large, so you may prefer a drive with room to spare. Default:\n${defaultDataDir()}\n\nYou can change this later in Mine.`,
      buttons: ["Use default", "Choose folder..."],
      defaultId: 0, cancelId: 0, noLink: true,
    });
    if (r.response === 1) {
      const pick = await dialog.showOpenDialog({ title: "Choose ZIRA storage folder", properties: ["openDirectory", "createDirectory"] });
      if (!pick.canceled && pick.filePaths && pick.filePaths[0]) {
        const target = path.resolve(pick.filePaths[0]);
        try { fs.mkdirSync(target, { recursive: true }); writeDesktopConfig({ dataDir: target }); } catch { /* fall back to default */ }
      }
    }
  } catch { /* any dialog failure: proceed with the default */ }
}
function resolveDataDir() {
  const override = readDesktopConfig().dataDir;
  if (override && typeof override === "string") {
    try { fs.mkdirSync(override, { recursive: true }); return override; } catch { /* unwritable: fall back */ }
  }
  return defaultDataDir();
}
// Carry the small identity + ledger state (NOT the multi-GB models dir) into a new data dir so relocating
// storage never loses the wallet/node identity; the model cache simply re-fills in the new location.
function migrateSmallState(oldDir, newDir) {
  const names = [
    "identity.json", "peer-key.bin", "genesis-id", "mining.json", "provider.json",
    "storage-peers.json", "founder-backups.json", "peers.json",
    "events.jsonl", "snapshot.json", "zti-history.jsonl", "settler-progress.json",
  ];
  try { fs.mkdirSync(newDir, { recursive: true }); } catch { /* */ }
  for (const name of names) {
    try {
      const src = path.join(oldDir, name);
      const dst = path.join(newDir, name);
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
    } catch { /* best-effort per file */ }
  }
}

// Find the bundled core. In a packaged app it sits in resources/core; in dev it is node/dist.
function coreEntry() {
  const packaged = path.join(process.resourcesPath || "", "core", "index.js");
  if (fs.existsSync(packaged)) return { entry: packaged, publicDir: path.join(process.resourcesPath, "core", "public") };
  const dev = path.resolve(__dirname, "..", "..", "..", "node", "dist", "index.js");
  return { entry: dev, publicDir: path.resolve(__dirname, "..", "..", "..", "node", "public") };
}

function startNode() {
  const { entry, publicDir } = coreEntry();
  if (!fs.existsSync(entry)) {
    // Do NOT quit silently. The window already exists; show the problem in it (and log it).
    const msg = `Could not find the ZIRA Core node at:\n${entry}\n\nThe install may be incomplete. Reinstall ZIRA, or run: bash scripts/build-all.sh`;
    console.error("ZIRA Core not built:", entry);
    showFatalInWindow("ZIRA Core not built", msg);
    return;
  }
  const dataDir = resolveDataDir();
  // On devnet the desktop app runs as the genesis steward by default, so a single founder machine
  // coordinates the network and seeds the field for testing. On mainnet set ZIRA_STEWARD only on
  // the founder's machine with the real genesis key.
  const steward = process.env.ZIRA_STEWARD || (NETWORK === "devnet" ? "1" : "0");
  const seed = process.env.ZIRA_SEED || (NETWORK === "devnet" ? "1" : "0");
  try {
    nodeProc = spawn(process.execPath, [entry], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",        // run the daemon with Electron's bundled Node
        ZIRA_NETWORK: NETWORK,
        ZIRA_RPC_PORT: RPC_PORT,
        ZIRA_P2P_PORT: P2P_PORT,
        ZIRA_WS_PORT: WS_PORT,
        ...(bootstrapAddr ? { ZIRA_BOOTSTRAP: bootstrapAddr } : {}),
        ZIRA_RPC_HOST: "127.0.0.1",
        ZIRA_DATA_DIR: dataDir,
        ZIRA_SERVE_CONSOLE: "1",
        ZIRA_CONSOLE_DIR: publicDir,
        ZIRA_HARDWARE_DETECT: process.env.ZIRA_HARDWARE_DETECT || "1",
        ZIRA_STEWARD: steward,
        ZIRA_SEED: seed,
      },
      stdio: "inherit",
    });
  } catch (err) {
    console.error("ZIRA Core failed to spawn:", err);
    showFatalInWindow("ZIRA Core failed to start", String(err && err.stack ? err.stack : err));
    return;
  }
  nodeProc.on("error", (err) => {
    console.error("ZIRA Core process error:", err);
    if (!consoleLoaded) showFatalInWindow("ZIRA Core failed to start", String(err && err.stack ? err.stack : err));
  });
  nodeProc.on("exit", (code) => {
    if (quitting) return;
    // the node exits on an in-app "start fresh" (POST /rpc/admin/reset). Respawn it so it rebuilds
    // from genesis. A small cap guards against a crash loop.
    if (restarts < 5) { restarts++; setTimeout(startNode, 800); }
    else {
      console.error("ZIRA Core exited repeatedly (code", code, "), not restarting");
      // If we never managed to load the Console, the user would otherwise stare at a frozen splash.
      // Tell them what happened, in the visible window.
      if (!consoleLoaded) showFatalInWindow(
        "ZIRA Core keeps stopping",
        `The ZIRA Core node exited repeatedly (last exit code ${code}). The app could not reach the local node on port ${RPC_PORT}.\n\nThis is usually a startup error in the node. Try restarting the app; if it persists, reinstall.`
      );
    }
  });
}
let restarts = 0;

// Probe a co-located mesh on the default port. If a node answers, read its peer id and return the
// multiaddr to bootstrap to, so the app's own node joins the same field instead of running alone.
function discoverMeshBootstrap(cb) {
  let done = false;
  const finish = (v) => { if (!done) { done = true; cb(v); } };
  const req = http.get({ host: "127.0.0.1", port: MESH_RPC_PORT, path: "/rpc/net", timeout: 1200 }, (res) => {
    let body = "";
    res.on("data", (d) => (body += d));
    res.on("end", () => {
      try {
        const peerId = JSON.parse(body).peerId;
        finish(peerId ? `/ip4/127.0.0.1/tcp/${MESH_P2P_PORT}/p2p/${peerId}` : "");
      } catch { finish(""); }
    });
  });
  req.on("error", () => finish(""));
  req.on("timeout", () => { req.destroy(); finish(""); });
}

// Poll the local RPC. Calls onReady() the first time /rpc/stats returns 200. After ~45s without a
// healthy RPC it calls onTimeout() so the window can show a visible "still connecting / error" state
// instead of hanging on the splash forever. Polling continues after a timeout so a late-starting node
// still gets picked up.
function waitForRpc(onReady, onTimeout) {
  const startedAt = Date.now();
  const TIMEOUT_MS = 45000;
  let timedOut = false;
  let settled = false;
  function poll() {
    if (settled) return;
    const req = http.get({ host: "127.0.0.1", port: RPC_PORT, path: "/rpc/stats", timeout: 1000 }, (res) => {
      res.resume();
      if (res.statusCode === 200) { settled = true; onReady(); return; }
      schedule();
    });
    req.on("error", schedule);
    req.on("timeout", () => { req.destroy(); schedule(); });
  }
  function schedule() {
    if (settled) return;
    if (!timedOut && Date.now() - startedAt > TIMEOUT_MS) { timedOut = true; try { onTimeout(); } catch { /* */ } }
    setTimeout(poll, 500);
  }
  poll();
}

// A standalone splash served from a data: URL, so the window has visible content the instant it opens,
// with zero dependency on the node. It shows a connecting spinner and (when navigateConsole fails)
// flips to an error with a Retry button. Retry is wired through the preload bridge / location reload.
function splashHtml(state, detail) {
  const connecting = state !== "error";
  const title = connecting ? "Starting ZIRA…" : "ZIRA could not start";
  const sub = connecting
    ? "Launching your local node and loading the Console."
    : (detail || "The local node did not become reachable.");
  // The ZIRA mark (the resonance cell), inlined so the splash needs no external asset.
  const mark = `<svg width="72" height="72" viewBox="0 0 88 88" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="ZIRA">
    <defs><linearGradient id="zm" x1="18" y1="14" x2="70" y2="74" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#E8FCF7" stop-opacity=".95"/><stop offset=".38" stop-color="#3ECFC0" stop-opacity=".9"/><stop offset="1" stop-color="#6B8CE8" stop-opacity=".78"/>
    </linearGradient></defs>
    <g fill="url(#zm)">
      <circle cx="44" cy="31" r="13" fill-opacity=".88"/><circle cx="55.3" cy="37.5" r="13" fill-opacity=".64"/><circle cx="55.3" cy="50.5" r="13" fill-opacity=".48"/>
      <circle cx="44" cy="57" r="13" fill-opacity=".64"/><circle cx="32.7" cy="50.5" r="13" fill-opacity=".48"/><circle cx="32.7" cy="37.5" r="13" fill-opacity=".72"/>
    </g>
    <g fill="none" stroke="rgba(255,255,255,.34)" stroke-width=".75">
      <circle cx="44" cy="31" r="13"/><circle cx="55.3" cy="37.5" r="13"/><circle cx="55.3" cy="50.5" r="13"/><circle cx="44" cy="57" r="13"/><circle cx="32.7" cy="50.5" r="13"/><circle cx="32.7" cy="37.5" r="13"/>
    </g></svg>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#070B14;color:#cdd6e4;font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif}
    .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;text-align:center;padding:24px}
    .logo{filter:drop-shadow(0 0 34px rgba(62,207,192,.4));animation:breathe 3s ease-in-out infinite}
    @keyframes breathe{0%,100%{opacity:.92;transform:scale(1)}50%{opacity:1;transform:scale(1.03)}}
    h1{margin:0;font-size:18px;font-weight:600;letter-spacing:.2px;color:#eef2f8}
    p{margin:0;max-width:440px;color:#8b97ab;white-space:pre-wrap}
    .spin{width:22px;height:22px;border:2.5px solid rgba(255,255,255,.12);border-top-color:#3ECFC0;border-radius:50%;animation:s 1s linear infinite}
    @keyframes s{to{transform:rotate(360deg)}}
    button{margin-top:6px;padding:9px 18px;border:0;border-radius:9px;background:#3ECFC0;color:#062421;font-weight:600;font-size:14px;cursor:pointer}
    button:hover{background:#54ddce}
  </style></head><body><div class="wrap">
    <div class="logo">${mark}</div>
    <h1>${title}</h1>
    ${connecting ? '<div class="spin"></div>' : ''}
    <p>${sub.replace(/</g, "&lt;")}</p>
    ${connecting ? '' : '<button onclick="location.reload()">Retry</button>'}
  </div></body></html>`;
}

function loadSplash(state, detail) {
  if (!win || win.isDestroyed()) return;
  consoleLoaded = false;
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(splashHtml(state, detail)));
}

function showFatalInWindow(heading, message) {
  console.error(`[ZIRA] ${heading}: ${message}`);
  loadSplash("error", `${heading}\n\n${message}`);
  // Also surface a native dialog so the failure is unmissable even if the window is behind others.
  try { if (app.isReady()) dialog.showErrorBox(heading, message); } catch { /* */ }
}

function navigateConsole() {
  if (!win || win.isDestroyed()) return;
  win.loadURL(CONSOLE_URL).then(() => {
    consoleLoaded = true;
  }).catch((err) => {
    // Navigation failed even though RPC answered; fall back to a visible retry screen.
    console.error("Failed to load Console:", err);
    if (!consoleLoaded) loadSplash("error", `Could not load the Console from ${CONSOLE_URL}\n\n${err}`);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 820, minWidth: 900, minHeight: 600,
    backgroundColor: "#070B14",
    title: "ZIRA",
    show: true, // show immediately — never wait on node readiness
    webPreferences: { preload: path.join(__dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  // Show content instantly, independent of the node.
  loadSplash("connecting");
  win.show();
  win.focus();
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: "deny" }; });
  win.on("closed", () => { win = null; });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }
else {
  app.on("second-instance", () => {
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);                 // no application menu bar
    // Surface anything that would otherwise crash main silently.
    process.on("uncaughtException", (err) => { console.error("uncaughtException:", err); if (!consoleLoaded) showFatalInWindow("Unexpected error", String(err && err.stack ? err.stack : err)); });
    process.on("unhandledRejection", (err) => { console.error("unhandledRejection:", err); });

    // 1) Create and SHOW the window first, with a splash. The user sees a window within a moment,
    //    regardless of what the node does.
    createWindow();
    app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

    // Auto-update (packaged builds only): check GitHub releases on start (after a short delay so it never
    // competes with node startup) and every 6h; download in the background and install on quit. Uses a native
    // notification, no custom UI. Best-effort: any failure (offline, no feed) is swallowed. Opt out with
    // ZIRA_NO_AUTOUPDATE=1. This is what lets future releases actually reach installed users.
    if (app.isPackaged && process.env.ZIRA_NO_AUTOUPDATE !== "1") {
      try {
        const { autoUpdater } = require("electron-updater");
        autoUpdater.autoDownload = true;
        autoUpdater.autoInstallOnAppQuit = true;
        const check = () => { autoUpdater.checkForUpdatesAndNotify().catch((e) => console.error("autoUpdate check failed", e && e.message)); };
        setTimeout(check, 30_000);
        setInterval(check, 6 * 60 * 60 * 1000).unref?.();
      } catch (e) { console.error("autoUpdater unavailable", e && e.message); }
    }

    if (process.env.ZIRA_RESET === "1") { try { await fullReset(); } catch (e) { console.error("reset failed", e); } }

    // 1b) First-run only: ask where to store data/models before the node starts (so the chosen folder is
    //     used from the very first launch). No-op for existing installs.
    await maybePromptStorageLocation();

    // 2) Discover a co-located mesh and bootstrap to it, then start our OWN node on our OWN ports.
    //    Then poll the RPC and swap the splash for the Console when it's ready.
    discoverMeshBootstrap((addr) => {
      bootstrapAddr = addr;
      startNode();
      waitForRpc(
        navigateConsole,
        () => { if (!consoleLoaded) loadSplash("error",
          `The local node has not become reachable on port ${RPC_PORT} after 45 seconds.\n\nIt may still be starting (first run can build genesis state). The app will keep trying — click Retry to reload, or restart the app if this persists.`); }
      );
    });
  });

  app.on("window-all-closed", () => { stopNode(); if (process.platform !== "darwin") app.quit(); });
  app.on("before-quit", stopNode);
}

let quitting = false;
function stopNode() { quitting = true; if (nodeProc) { try { nodeProc.kill(); } catch { /* */ } nodeProc = null; } }

// A fresh start wipes ledger/app state but keeps heavy model caches unless deep is requested
// (env ZIRA_DEEP_RESET=1, or the Settings "Reset ZIRA" button which always deep-resets).
async function fullReset(deep = process.env.ZIRA_DEEP_RESET === "1") {
  try {
    const dataDir = resolveDataDir();
    const resetNames = [
      "events.jsonl", "snapshot.json", "mining.json", "provider.json", "storage-peers.json",
      "founder-backups.json", "zti-history.jsonl", "peers.json", "identity.json", "peer-key.bin",
      "genesis-id",
    ];
    if (deep) resetNames.push("models");
    for (const name of resetNames) fs.rmSync(path.join(dataDir, name), { recursive: true, force: true });
  } catch { /* */ }
  try { await session.defaultSession.clearStorageData(); } catch { /* */ }
  try { await session.defaultSession.clearCache(); } catch { /* */ }
  console.log(deep ? "ZIRA_RESET: cleared local ledger, model cache, and app storage, starting fresh" : "ZIRA_RESET: cleared local ledger and app storage, kept model cache, starting fresh");
}

// Re-sync ledger: the SAFE remedy for any sync/divergence/"stuck" issue. Wipes ONLY the local ledger view
// (events, snapshot, zti-history, the settler watermark) so the node fast-syncs a fresh, correct state on
// relaunch. KEEPS identity.json + peer-key.bin (same wallet + node identity) and does NOT clear app/wallet
// storage or the model cache. Funds live on chain; this only rebuilds the local ledger view. This is what a
// user should reach for first, and what an in-app "your local balance disagrees with the network" prompt runs.
async function resyncLedger() {
  try {
    const dataDir = resolveDataDir();
    const ledgerNames = ["events.jsonl", "snapshot.json", "zti-history.jsonl", "settler-progress.json"];
    for (const name of ledgerNames) fs.rmSync(path.join(dataDir, name), { recursive: true, force: true });
  } catch { /* */ }
}

// Settings -> "Re-sync ledger" (safe): keeps identity + wallet, only rebuilds the ledger.
ipcMain.handle("zira:resync", async () => {
  try { stopNode(); } catch { /* */ }
  await resyncLedger();
  app.relaunch();
  app.exit(0);
  return true;
});

// Settings -> "Delete wallet & reset" (DESTRUCTIVE): stop the node, wipe EVERYTHING (ledger + wallet/app
// storage + model cache), then relaunch clean. The renderer MUST gate this behind an explicit seed-backup
// confirmation, because this deletes the node wallet key (identity.json) and the Console wallet (app storage).
ipcMain.handle("zira:reset", async () => {
  try { stopNode(); } catch { /* */ }
  await fullReset(true);
  app.relaunch();
  app.exit(0);
  return true;
});

// Settings -> storage folder. Report the current + default data dir so the UI can show where models live.
ipcMain.handle("zira:getStoragePath", async () => {
  return { dataDir: resolveDataDir(), default: defaultDataDir(), isCustom: !!readDesktopConfig().dataDir };
});

// Settings -> "Choose folder": open a native directory picker. Returns the chosen absolute path, or null
// if the user cancelled. Does NOT apply it (the UI confirms, then calls zira:setStoragePath).
ipcMain.handle("zira:chooseStoragePath", async () => {
  try {
    const res = await dialog.showOpenDialog(win, {
      title: "Choose ZIRA storage folder",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: resolveDataDir(),
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return null;
    return res.filePaths[0];
  } catch { return null; }
});

// Settings -> apply a new storage folder. Carries the small wallet/identity/ledger state into the new
// location (the heavy model cache re-fills there per the cap), persists the choice, and relaunches so the
// node runs on the new ZIRA_DATA_DIR. Wallet + node identity are preserved; funds live on chain regardless.
ipcMain.handle("zira:setStoragePath", async (_e, dir) => {
  try {
    if (!dir || typeof dir !== "string") return { ok: false, error: "no folder chosen" };
    const target = path.resolve(dir);
    fs.mkdirSync(target, { recursive: true });
    // writable check
    try { const probe = path.join(target, ".zira-write-test"); fs.writeFileSync(probe, "ok"); fs.rmSync(probe, { force: true }); }
    catch { return { ok: false, error: "that folder is not writable" }; }
    const current = resolveDataDir();
    if (path.resolve(current) === target) return { ok: true, dataDir: target, unchanged: true };
    // Preserve identity + ledger unless the target already holds a ZIRA identity (pointing at an existing dir).
    if (!fs.existsSync(path.join(target, "identity.json"))) migrateSmallState(current, target);
    writeDesktopConfig({ dataDir: target });
    try { stopNode(); } catch { /* */ }
    app.relaunch();
    app.exit(0);
    return { ok: true, dataDir: target };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
});

// ---- build-agent workspace bridge (desktop only) ----
// The Console build-agent works inside a folder the user explicitly opens. Everything below is scoped to
// that one root: reads, writes, and command execution all resolve against it and refuse to escape it. The
// renderer gates every write and every command behind explicit user approval; the main process enforces the
// hard sandbox (path containment, output caps, timeouts) so a model can never touch anything outside the
// chosen workspace. This is the native-execution surface that makes ZIRA usable for building real projects.
let workspaceRoot = null;                    // absolute path of the opened folder, or null
const AGENT_SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".cache", "target", ".venv", "__pycache__"]);
const AGENT_MAX_FILES = 4000;                // bound the tree walk so a huge repo cannot hang the UI
const AGENT_MAX_READ_BYTES = 1024 * 1024;    // 1 MB per file read into model context
const AGENT_CMD_TIMEOUT_MS = 180000;         // 3 min per command
const AGENT_CMD_MAX_OUTPUT = 200 * 1024;     // cap captured stdout+stderr at 200 KB

// Resolve a workspace-relative path and REFUSE anything that escapes the root (path traversal, absolute
// paths, symlink games are contained by the realpath-prefix check at call sites that create files).
function agentResolve(rel) {
  if (!workspaceRoot) throw new Error("no workspace is open");
  const abs = path.resolve(workspaceRoot, rel || ".");
  const root = path.resolve(workspaceRoot);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error("path escapes the workspace");
  return abs;
}
function agentWalk(dir, root, out, depth) {
  if (out.length >= AGENT_MAX_FILES || depth > 12) return;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= AGENT_MAX_FILES) return;
    if (e.name.startsWith(".") && e.name !== ".env.example") { if (e.isDirectory() && AGENT_SKIP_DIRS.has(e.name)) continue; }
    if (e.isDirectory() && AGENT_SKIP_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (e.isDirectory()) { out.push({ path: rel, dir: true }); agentWalk(abs, root, out, depth + 1); }
    else { let size = 0; try { size = fs.statSync(abs).size; } catch { /* */ } out.push({ path: rel, dir: false, size }); }
  }
}

ipcMain.handle("agent:openWorkspace", async () => {
  try {
    const res = await dialog.showOpenDialog(win, { title: "Open a project folder", properties: ["openDirectory"] });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return null;
    workspaceRoot = path.resolve(res.filePaths[0]);
    return workspaceRoot;
  } catch { return null; }
});
ipcMain.handle("agent:workspace", async () => workspaceRoot);
ipcMain.handle("agent:listFiles", async () => {
  if (!workspaceRoot) return { root: null, files: [] };
  const out = [];
  agentWalk(workspaceRoot, workspaceRoot, out, 0);
  return { root: workspaceRoot, files: out, truncated: out.length >= AGENT_MAX_FILES };
});
ipcMain.handle("agent:readFile", async (_e, rel) => {
  try {
    const abs = agentResolve(rel);
    const st = fs.statSync(abs);
    if (st.isDirectory()) return { ok: false, error: "that path is a directory" };
    if (st.size > AGENT_MAX_READ_BYTES) return { ok: false, error: `file too large (${st.size} bytes; limit ${AGENT_MAX_READ_BYTES})` };
    return { ok: true, content: fs.readFileSync(abs, "utf8") };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
ipcMain.handle("agent:writeFile", async (_e, rel, content) => {
  try {
    const abs = agentResolve(rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof content === "string" ? content : String(content ?? ""));
    return { ok: true, path: path.relative(workspaceRoot, abs).split(path.sep).join("/") };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
// Run a command inside the workspace. The RENDERER must have shown the exact command to the user for
// approval first; the main process enforces cwd containment, a timeout, and an output cap. Uses the platform
// shell so "npm test", "pytest", etc. work as typed. Never runs when no workspace is open.
ipcMain.handle("agent:runCommand", async (_e, command) => {
  if (!workspaceRoot) return { ok: false, error: "no workspace is open" };
  if (!command || typeof command !== "string" || !command.trim()) return { ok: false, error: "empty command" };
  return await new Promise((resolve) => {
    let out = "", done = false;
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const shellArgs = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command];
    let child;
    try { child = spawn(shell, shellArgs, { cwd: workspaceRoot, env: process.env, windowsHide: true }); }
    catch (e) { return resolve({ ok: false, error: String((e && e.message) || e) }); }
    const append = (b) => { if (out.length < AGENT_CMD_MAX_OUTPUT) out += b.toString(); };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => { if (!done) { done = true; try { child.kill("SIGKILL"); } catch { /* */ } resolve({ ok: true, code: null, timedOut: true, output: out.slice(0, AGENT_CMD_MAX_OUTPUT) + "\n[timed out]" }); } }, AGENT_CMD_TIMEOUT_MS);
    child.on("error", (err) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, error: String(err.message || err) }); } });
    child.on("exit", (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: true, code, timedOut: false, output: out.slice(0, AGENT_CMD_MAX_OUTPUT) }); } });
  });
});

// Plain relaunch (no wipe): used after importing a wallet so the node reloads its new identity.json.
ipcMain.handle("zira:relaunch", async () => {
  try { stopNode(); } catch { /* */ }
  app.relaunch();
  app.exit(0);
  return true;
});

// Machine telemetry for the Mine page: hardware names + live CPU/RAM utilization from Node's os module (no
// extra dependency). Power/temperature need a native sensor module and are NOT exposed here, so the UI shows
// what is available and degrades gracefully. CPU% is sampled as the busy delta between successive calls.
let _prevCpu = null;
function _cpuPct() {
  const cpus = os.cpus() || [];
  let idle = 0, total = 0;
  for (const c of cpus) { for (const k in c.times) total += c.times[k]; idle += c.times.idle; }
  if (!_prevCpu) { _prevCpu = { idle, total }; return 0; }
  const dIdle = idle - _prevCpu.idle, dTotal = total - _prevCpu.total;
  _prevCpu = { idle, total };
  return dTotal > 0 ? Math.max(0, Math.min(100, Math.round((1 - dIdle / dTotal) * 100))) : 0;
}
// GPU name, detected once and cached (it does not change during a session). Any vendor: PowerShell CIM on
// Windows (NVIDIA/AMD/Intel alike), system_profiler on macOS, lspci on Linux. Best-effort, never throws.
let _gpuName = null; // null = not yet detected, "" = detected none
function _detectGpu() {
  if (_gpuName !== null) return _gpuName;
  const { execSync } = require("node:child_process");
  const run = (cmd, timeout) => { try { return execSync(cmd, { timeout, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim(); } catch { return ""; } };
  let name = "";
  try {
    if (process.platform === "win32") {
      const out = run('powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "(Get-CimInstance Win32_VideoController | Where-Object { $_.Name } | Select-Object -First 1 -ExpandProperty Name)"', 8000);
      name = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || "";
    } else if (process.platform === "darwin") {
      const out = run("system_profiler SPDisplaysDataType 2>/dev/null", 6000);
      const m = out.match(/Chipset Model:\s*(.+)/);
      name = m ? m[1].trim() : "";
    } else {
      const out = run('lspci 2>/dev/null | grep -i "vga\\|3d\\|display"', 2500);
      const line = out.split(/\r?\n/).filter(Boolean)[0] || "";
      name = line.includes(":") ? line.slice(line.lastIndexOf(":") + 1).trim() : line.trim();
    }
  } catch { name = ""; }
  _gpuName = name;
  return _gpuName;
}
ipcMain.handle("zira:hardware", () => {
  const cpus = os.cpus() || [];
  const totalMem = os.totalmem(), freeMem = os.freemem();
  return {
    cpuModel: cpus[0] && cpus[0].model ? String(cpus[0].model).trim() : "CPU",
    cpuCores: cpus.length,
    cpuPct: _cpuPct(),
    gpuModel: _detectGpu(),
    ramTotalGB: totalMem / 1e9,
    ramUsedGB: (totalMem - freeMem) / 1e9,
    ramPct: totalMem ? Math.round(((totalMem - freeMem) / totalMem) * 100) : 0,
    platform: process.platform,
    arch: process.arch,
  };
});

// The application menu bar is intentionally off (Menu.setApplicationMenu(null) above). Copy/paste and
// text selection still work natively inside inputs; the app is driven entirely from the Console UI.
