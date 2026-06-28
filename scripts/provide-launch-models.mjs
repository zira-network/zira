// scripts/provide-launch-models.mjs
// Adds the first launch GGUF models through the active launch-authority node. The node downloads,
// hashes, signs, and announces each model. Storage peers then replicate from P2P or the signed URL.
import { existsSync, openSync, readSync, closeSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const rpc = process.env.ZIRA_RPC || "http://127.0.0.1:8645";
const firstOnly = process.argv.includes("--first-only");
const localDirArg = process.argv.find((arg) => arg.startsWith("--local-dir="));
const localDir = localDirArg ? resolve(localDirArg.slice("--local-dir=".length)) : "";
const onlyIndexArg = process.argv.find((arg) => arg.startsWith("--only-index="));
const onlyIndex = onlyIndexArg ? Number(onlyIndexArg.slice("--only-index=".length)) : null;
const includeDefaults = process.argv.includes("--include-defaults");
const localModelPaths = process.argv
  .filter((arg) => arg.startsWith("--local-model="))
  .map((arg) => resolve(arg.slice("--local-model=".length)));

const defaultLaunchModels = [
  {
    // Small, CPU-servable BASELINE so the field always has an answerer. A plain CPU node (the VPS, the
    // 8 GiB default storage cap) holds and serves this; the larger models below are gated to capable
    // (GPU / high-cap) miners purely by their byte size — a node serves the best model it can actually
    // fit and run. As real miners join, the field coordinates the baseline with the larger models.
    url: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf",
    file: "qwen2.5-3b-instruct-q4_k_m.gguf",
    name: "Qwen2.5 3B Instruct Q4_K_M",
    arch: "qwen2.5-3b",
    quant: "Q4_K_M",
    domains: ["general", "language", "reasoning", "code", "science", "education", "planning"],
    version: 1,
  },
  {
    url: "https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q8_0.gguf",
    file: "Qwen3-8B-Q8_0.gguf",
    name: "Qwen3 8B Q8 GGUF",
    arch: "qwen3-8b",
    quant: "Q8_0",
    domains: ["general", "language", "reasoning", "code", "science", "education", "planning"],
    version: 2,
  },
];

const launchModels = localModelPaths.length > 0 && !includeDefaults ? [] : [...defaultLaunchModels];

for (const path of localModelPaths) {
  const file = path.split(/[\\/]/).pop() || "local-model.gguf";
  launchModels.push({
    url: `local://${file}`,
    file: path,
    name: file.replace(/\.gguf$/i, "").replace(/[-_]+/g, " "),
    arch: file.toLowerCase().includes("coder") ? "local-coder" : "local-gguf",
    quant: file.toLowerCase().includes("bf16") ? "BF16" : "GGUF",
    domains: file.toLowerCase().includes("coder")
      ? ["code", "reasoning", "planning", "general", "language"]
      : ["general", "language", "reasoning", "education"],
    version: 1,
  });
}

function assertGguf(path) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(4);
    if (readSync(fd, buf, 0, 4, 0) !== 4 || buf.toString("utf8") !== "GGUF") {
      throw new Error(`local file is not a valid GGUF: ${path}`);
    }
  } finally {
    closeSync(fd);
  }
}

async function readJson(path) {
  const res = await fetch(`${rpc}/rpc${path}`);
  if (!res.ok) throw new Error(`${path} failed with HTTP ${res.status}`);
  return res.json();
}

async function postJson(path, body) {
  const res = await fetch(`${rpc}/rpc${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(parsed?.error || `${path} failed with HTTP ${res.status}`);
  return parsed;
}

const status = await readJson("/status");
if (!status.isFounder) {
  throw new Error("bootstrap node is not running with active launch authority");
}

const existing = await readJson("/models");
const selected = onlyIndex !== null ? [launchModels[onlyIndex]].filter(Boolean) : firstOnly ? launchModels.slice(0, 1) : launchModels;
const added = [];

for (const model of selected) {
  const already = existing.find((m) => m.meta?.url === model.url || m.meta?.name === model.name);
  if (already) {
    console.log(`Already announced: ${model.name} (${already.meta.id.slice(0, 12)})`);
    added.push(already.meta);
    continue;
  }

  console.log(`Providing launch model: ${model.name}`);
  const body = { ...model };
  if (isAbsolute(model.file)) {
    body.path = model.file;
    if (!existsSync(body.path)) throw new Error(`local model file not found: ${body.path}`);
    assertGguf(body.path);
  } else if (localDir) {
    body.path = isAbsolute(model.file) ? model.file : join(localDir, model.file);
    if (!existsSync(body.path)) throw new Error(`local model file not found: ${body.path}`);
    assertGguf(body.path);
  }
  console.log(`Source: ${body.path || model.url}`);
  const meta = await postJson("/models/provide", body);
  console.log(`Authorized and announced: ${meta.name} (${meta.id.slice(0, 12)}), ${(meta.sizeBytes / 1024 ** 3).toFixed(2)} GiB`);
  added.push(meta);
}

console.log(JSON.stringify({ rpc, added }, null, 2));
