// scripts/provide-image-models.mjs
// Adds the launch TEXT-TO-IMAGE (SD) GGUF model through the active launch-authority node (the steward
// founder). The node downloads, hashes, signs, and announces the model exactly like the LLM launch
// models; storage peers then replicate from P2P or the signed URL. The model is registered as
// type "image" (routing domains vision/creative/multimodal), so a query in a vision/creative domain
// routes to it once image serving is armed.
//
// Model distribution is VERSION-INDEPENDENT: the founder signs a manifest over the GGUF bytes, so an
// older founder node (e.g. the installed 2.7.0 desktop app) provides an image model correctly even
// though it cannot yet SERVE it. Serving is gated separately (ZIRA_IMAGE_ENABLE + the sd-bundle +
// the arm activation epoch). Recommended order: provide the model now if you want it replicating, but
// it stays inert to users until T2I serving is armed after a shadow proof.
//
// Usage (open the steward founder first, then):
//   ZIRA_RPC=http://127.0.0.1:8646 node scripts/provide-image-models.mjs               # default SDXL by URL
//   ZIRA_RPC=http://127.0.0.1:8646 node scripts/provide-image-models.mjs --local-model="C:\path\model.gguf"
//   ZIRA_RPC=http://127.0.0.1:8646 node scripts/provide-image-models.mjs --only-index=0
import { existsSync, openSync, readSync, closeSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const rpc = process.env.ZIRA_RPC || "http://127.0.0.1:8646";
const firstOnly = process.argv.includes("--first-only");
const localDirArg = process.argv.find((arg) => arg.startsWith("--local-dir="));
const localDir = localDirArg ? resolve(localDirArg.slice("--local-dir=".length)) : "";
const onlyIndexArg = process.argv.find((arg) => arg.startsWith("--only-index="));
const onlyIndex = onlyIndexArg ? Number(onlyIndexArg.slice("--only-index=".length)) : null;
const includeDefaults = process.argv.includes("--include-defaults");
const localModelPaths = process.argv
  .filter((arg) => arg.startsWith("--local-model="))
  .map((arg) => resolve(arg.slice("--local-model=".length)));

// SDXL Base 1.0 in GGUF (gpustack conversion). Q8_0 is the quality/size balance for the launch image
// model; a smaller quant or SD1.5 can be added the same way. GGUF-only: importUrl asserts the GGUF
// magic, and SD GGUFs carry it, so an image GGUF is accepted by the same store as the LLMs.
const defaultImageModels = [
  {
    url: "https://huggingface.co/gpustack/stable-diffusion-xl-base-1.0-GGUF/resolve/main/stable-diffusion-xl-base-1.0-Q8_0.gguf",
    file: "stable-diffusion-xl-base-1.0-Q8_0.gguf",
    name: "Stable Diffusion XL Base 1.0 Q8_0",
    arch: "sdxl-1.0",
    quant: "Q8_0",
    type: "image",
    domains: ["vision", "creative", "multimodal"],
    version: 1,
  },
];

const imageModels = localModelPaths.length > 0 && !includeDefaults ? [] : [...defaultImageModels];

for (const path of localModelPaths) {
  const file = path.split(/[\\/]/).pop() || "local-image-model.gguf";
  imageModels.push({
    url: `local://${file}`,
    file: path,
    name: file.replace(/\.gguf$/i, "").replace(/[-_]+/g, " "),
    arch: file.toLowerCase().includes("xl") ? "sdxl-1.0" : "sd-1.x",
    quant: /q\d/i.test(file) ? (file.match(/q\d[_a-z0-9]*/i)?.[0].toUpperCase() ?? "GGUF") : "GGUF",
    type: "image",
    domains: ["vision", "creative", "multimodal"],
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
  throw new Error(`node at ${rpc} is not running with active launch authority (open the steward founder first)`);
}

const existing = await readJson("/models");
const selected = onlyIndex !== null ? [imageModels[onlyIndex]].filter(Boolean) : firstOnly ? imageModels.slice(0, 1) : imageModels;
const added = [];

for (const model of selected) {
  const already = existing.find((m) => m.meta?.url === model.url || m.meta?.name === model.name);
  if (already) {
    console.log(`Already announced: ${model.name} (${already.meta.id.slice(0, 12)})`);
    added.push(already.meta);
    continue;
  }

  console.log(`Providing image model: ${model.name}`);
  const body = { ...model };
  if (isAbsolute(model.file)) {
    body.path = model.file;
    if (!existsSync(body.path)) throw new Error(`local model file not found: ${body.path}`);
    assertGguf(body.path);
  } else if (localDir) {
    body.path = join(localDir, model.file);
    if (!existsSync(body.path)) throw new Error(`local model file not found: ${body.path}`);
    assertGguf(body.path);
  }
  console.log(`Source: ${body.path || model.url}`);
  const meta = await postJson("/models/provide", body);
  console.log(`Authorized and announced: ${meta.name} (${meta.id.slice(0, 12)}), ${(meta.sizeBytes / 1024 ** 3).toFixed(2)} GiB, type=${meta.type ?? "image"}`);
  added.push(meta);
}

console.log(JSON.stringify({ rpc, added }, null, 2));
