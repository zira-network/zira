// apps/desktop/electron/preload.cjs
// Tell the Console it is running inside the desktop app, so it can show miner features (GPU/CPU
// mining is desktop only). Exposed safely through the context bridge.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("zira", {
  isDesktop: true,
  platform: process.platform,
  version: process.versions.electron,
  // Settings -> "Re-sync ledger" (SAFE): rebuild only the local ledger; keeps identity + wallet.
  resyncLedger: () => ipcRenderer.invoke("zira:resync"),
  // Settings -> "Delete wallet & reset" (DESTRUCTIVE): wipe everything incl. wallet + model cache. The UI
  // must gate this behind an explicit seed-backup confirmation.
  resetAndRelaunch: () => ipcRenderer.invoke("zira:reset"),
  // Relaunch without wiping (used after importing a wallet, so the node reloads its new identity).
  relaunchApp: () => ipcRenderer.invoke("zira:relaunch"),
  // Live machine telemetry for the Mine page (hardware names + CPU/RAM utilization). Desktop only.
  hardware: () => ipcRenderer.invoke("zira:hardware"),
  // Storage folder controls (desktop only): where the node keeps its wallet, ledger, and model cache.
  getStoragePath: () => ipcRenderer.invoke("zira:getStoragePath"),
  chooseStoragePath: () => ipcRenderer.invoke("zira:chooseStoragePath"),
  setStoragePath: (dir) => ipcRenderer.invoke("zira:setStoragePath", dir),
  // Build-agent workspace bridge (desktop only). Sandboxed to a user-opened folder: recursive listing,
  // scoped file read/write, and approved command/test execution. The UI gates writes + commands.
  agent: {
    openWorkspace: () => ipcRenderer.invoke("agent:openWorkspace"),
    workspace: () => ipcRenderer.invoke("agent:workspace"),
    listFiles: () => ipcRenderer.invoke("agent:listFiles"),
    readFile: (rel) => ipcRenderer.invoke("agent:readFile", rel),
    writeFile: (rel, content) => ipcRenderer.invoke("agent:writeFile", rel, content),
    runCommand: (command) => ipcRenderer.invoke("agent:runCommand", command),
  },
});
