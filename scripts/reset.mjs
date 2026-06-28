// scripts/reset.mjs
// Delete local ZIRA state so everything starts fresh while preserving heavy model caches by default.
// Close the ZIRA app first, then run this. Usage: node scripts/reset.mjs [--deep]
import { rmSync, existsSync, readdirSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const home = homedir();
const appData = process.env.APPDATA || join(home, "AppData", "Roaming");
const targets = [
  join(home, ".zira"),                                    // CLI node data (all networks)
  join(appData, "ZIRA"),                                  // Windows desktop app (userData: ledger + wallet + cache)
  join(home, "Library", "Application Support", "ZIRA"),   // macOS desktop app
  join(home, ".config", "ZIRA"),                          // Linux desktop app
  join(home, ".cache", "ZIRA"),                           // Linux cache
];
const deep = process.argv.includes("--deep");

function removePreservingModels(dir) {
  if (!existsSync(dir)) return false;
  if (deep || basename(dir) !== "models") {
    if (deep) { rmSync(dir, { recursive: true, force: true }); return true; }
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "models") continue;
      removePreservingModels(path);
      try { rmdirSync(path); } catch { /* keep non-empty dirs such as parents of models */ }
    } else {
      rmSync(path, { force: true });
    }
  }
  return true;
}

let removed = 0;
for (const dir of targets) {
  if (existsSync(dir)) {
    removePreservingModels(dir);
    console.log(deep ? "removed" : "reset, kept models if present", dir);
    removed++;
  }
}
console.log(removed ? (deep ? "done. ZIRA will start completely fresh from genesis." : "done. ZIRA will start fresh from genesis and reuse any model cache.") : "nothing to remove, already fresh.");
console.log("Tip: launch the desktop app with ZIRA_RESET=1 for the same model-preserving reset, or pass --deep to delete models too.");
