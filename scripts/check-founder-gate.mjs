// scripts/check-founder-gate.mjs
// CI audit: the public Console bundle must contain no model-management *implementation*. The built-in
// inference engine, GGUF storage/chunking, and auto-reconcile are node-side only and must never ship
// in the browser bundle. The founder's "add a model by link" UI is allowed — it is just an RPC call
// to the node (POST /models/provide), so the literal token "gguf" in UI copy is fine. Fail the build
// only if real model-management modules leak into apps/console/dist.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "apps", "console", "dist");
const FORBIDDEN = ["ModelStore", "ModelService", "node-llama-cpp", "reconcileAuto"];

if (!existsSync(distDir)) {
  console.error(`Founder gate check: dist not found at ${distDir}. Run "pnpm build:console" first.`);
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".js")) out.push(p);
  }
  return out;
}

let failed = false;
for (const file of walk(distDir)) {
  const src = readFileSync(file, "utf-8");
  for (const word of FORBIDDEN) {
    if (src.includes(word)) {
      console.error(`FAIL: "${word}" found in Console bundle at ${file}`);
      failed = true;
    }
  }
}

if (failed) {
  console.error("Founder gate check: FAIL — model-management code leaked into the public Console bundle.");
  process.exit(1);
}
console.log("Founder gate check: PASS");
