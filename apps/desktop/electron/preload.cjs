// apps/desktop/electron/preload.cjs
// Tell the Console it is running inside the desktop app, so it can show miner features (GPU/CPU
// mining is desktop only). Exposed safely through the context bridge.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("zira", {
  isDesktop: true,
  platform: process.platform,
  version: process.versions.electron,
  // Settings -> "Reset ZIRA": wipe everything (ledger + wallet + model cache) and relaunch clean.
  resetAndRelaunch: () => ipcRenderer.invoke("zira:reset"),
  // Relaunch without wiping (used after importing a wallet, so the node reloads its new identity).
  relaunchApp: () => ipcRenderer.invoke("zira:relaunch"),
});
