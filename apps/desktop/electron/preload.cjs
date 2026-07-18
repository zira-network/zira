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
});
