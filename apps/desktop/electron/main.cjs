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
  const dataDir = path.join(app.getPath("userData"), "zira-data", NETWORK);
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
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;background:#070B14;color:#cdd6e4;font:15px/1.5 system-ui,Segoe UI,Roboto,sans-serif}
    .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;text-align:center;padding:24px}
    .logo{width:54px;height:54px;border-radius:14px;background:linear-gradient(135deg,#3b82f6,#8b5cf6);box-shadow:0 0 40px rgba(99,102,241,.45)}
    h1{margin:0;font-size:19px;font-weight:600;color:#eef2f8}
    p{margin:0;max-width:460px;color:#8b97ab;white-space:pre-wrap}
    .spin{width:26px;height:26px;border:3px solid rgba(255,255,255,.15);border-top-color:#6366f1;border-radius:50%;animation:s 1s linear infinite}
    @keyframes s{to{transform:rotate(360deg)}}
    button{margin-top:6px;padding:9px 18px;border:0;border-radius:9px;background:#6366f1;color:#fff;font-size:14px;cursor:pointer}
    button:hover{background:#5457e6}
  </style></head><body><div class="wrap">
    <div class="logo"></div>
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

    if (process.env.ZIRA_RESET === "1") { try { await fullReset(); } catch (e) { console.error("reset failed", e); } }

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
    const dataDir = path.join(app.getPath("userData"), "zira-data", NETWORK);
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

// Settings -> "Reset ZIRA": stop the node, wipe EVERYTHING (ledger + wallet/app storage + model cache),
// then relaunch the app clean. Driven from the renderer via the contextBridge.
ipcMain.handle("zira:reset", async () => {
  try { stopNode(); } catch { /* */ }
  await fullReset(true);
  app.relaunch();
  app.exit(0);
  return true;
});

// Plain relaunch (no wipe): used after importing a wallet so the node reloads its new identity.json.
ipcMain.handle("zira:relaunch", async () => {
  try { stopNode(); } catch { /* */ }
  app.relaunch();
  app.exit(0);
  return true;
});

// The application menu bar is intentionally off (Menu.setApplicationMenu(null) above). Copy/paste and
// text selection still work natively inside inputs; the app is driven entirely from the Console UI.
