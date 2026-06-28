// apps/desktop/electron/preload.cjs
// Tell the Console it is running inside the desktop app, so it can show miner features (GPU/CPU
// mining is desktop only). Exposed safely through the context bridge.
const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("zira", {
  isDesktop: true,
  platform: process.platform,
  version: process.versions.electron,
});
