// packages/protocol/ops/seed-launch-resonators.mjs
// Secure operator helper for launch Resonators. It finds a local mainnet founder key without
// printing it, publishes deterministic founder-owned Resonators, and funds each to a conservative
// target balance so autonomous coordination can start without the Console browser staying open.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { sha3_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { bech32m } from "@scure/base";

const PROTOCOL = { UZIR_PER_ZIR: 1_000_000, BASE_FEE_UZIR: 1_000 };
const DOMAINS = [
  "compute", "energy", "carbon", "data", "currency", "goods", "code", "science",
  "reasoning", "language", "vision", "audio", "video", "robotics", "medicine", "law",
  "finance", "education", "creative", "security", "planning", "multimodal", "general",
];
const founders = new Set([
  "zir1km32wyjkya4h6utahkuckm56zgshnevy4v3a7t",
  "zir1c7q2fzk6lmaxsnx4s7twftzlpcd749xa6v0r7z",
  "zir1czsjyrjf8wts662kd7s9um4nmyaapjhcvr0x7n",
]);
const rpc = process.env.ZIRA_RPC || "http://127.0.0.1:8645";
const dryRun = process.argv.includes("--dry-run");
// Candidate key files. Paths are checked relative to the working directory, which may be the repo
// root or the source/ workspace depending on how the script is launched, so both are listed. An
// explicit ZIRA_KEYS_FILE always wins. local-private is the canonical sibling of source/.
const secretFiles = [
  process.env.ZIRA_KEYS_FILE,
  "secrets/FOUNDER_WALLET.dm",
  "secrets/ZIRA_MAINNET_FOUNDERS_LOCAL.dm",
  "local-private/ZIRA_WALLETS_AND_KEYS_LOCAL.dm",
  "../local-private/ZIRA_WALLETS_AND_KEYS_LOCAL.dm",
].filter(Boolean);

const launchResonators = [
  {
    id: "field-orchestrator",
    name: "Field Orchestrator",
    purpose: "Coordinates field-level plans across providers, storage peers, Resonators, and launch operations.",
    domains: ["planning", "reasoning", "general"],
    targetZir: 600,
    perTxZir: 12,
    perDayZir: 140,
    priceZir: 6,
    prompt: "You coordinate the ZIRA field. Prefer clear plans, verify live state, and route work to the right peer, Resonator, or operator action.",
  },
  {
    id: "model-steward",
    name: "Model Steward",
    purpose: "Watches authorized model readiness, provider health, endpoint readiness, and future multimodal model expansion.",
    domains: ["reasoning", "code", "multimodal", "general"],
    targetZir: 500,
    perTxZir: 10,
    perDayZir: 120,
    priceZir: 5,
    prompt: "You steward model readiness for ZIRA. Track signed models, provider availability, endpoint/native inference health, and safe model rollout.",
  },
  {
    id: "storage-weaver",
    name: "Storage Weaver",
    purpose: "Coordinates P2P storage, replication, storage caps, and model byte availability.",
    domains: ["data", "compute", "planning", "general"],
    targetZir: 400,
    perTxZir: 8,
    perDayZir: 90,
    priceZir: 4,
    prompt: "You coordinate decentralized storage for ZIRA. Watch replication, caps, storage pressure, model byte availability, and peer continuity.",
  },
  {
    id: "task-settler",
    name: "Task Settler",
    purpose: "Coordinates task lifecycle, settlement checks, released work, and Resonator learning signals.",
    domains: ["finance", "reasoning", "planning", "general"],
    targetZir: 500,
    perTxZir: 10,
    perDayZir: 120,
    priceZir: 5,
    prompt: "You coordinate ZIRA task settlement. Track assigned, delivered, verified, released, refunded, balances, spend limits, and ZTI learning.",
  },
  {
    id: "training-collaborator",
    name: "Training Collaborator",
    purpose: "Coordinates AI-to-AI training loops, critique, distillation notes, and collaboration tasks across miners.",
    domains: ["code", "reasoning", "education", "planning", "general"],
    targetZir: 450,
    perTxZir: 9,
    perDayZir: 100,
    priceZir: 5,
    prompt: "You coordinate AI-to-AI training collaboration. Ask independent miners for solution drafts, critiques, test ideas, and improvement loops. Prefer evidence and reusable learning signals.",
  },
  {
    id: "task-collaboration-router",
    name: "Task Collaboration Router",
    purpose: "Splits user tasks across multiple Resonators, miners, evidence checks, and settlement paths.",
    domains: ["planning", "code", "security", "reasoning", "general"],
    targetZir: 450,
    perTxZir: 9,
    perDayZir: 100,
    priceZir: 5,
    prompt: "You route tasks across multiple factors: specialized Resonators, model-backed miners, storage evidence, wallet/payment constraints, and verification. Return coordinated work, not isolated answers.",
  },
];

function toUZIR(zir) { return Math.round(zir * PROTOCOL.UZIR_PER_ZIR); }
function canonical(value) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical: non finite number");
    return JSON.stringify(value);
  }
  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (t === "object") {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  throw new Error("canonical: unsupported type " + t);
}
function hashHex(input) { return bytesToHex(sha3_256(typeof input === "string" ? utf8ToBytes(input) : input)); }
function sign(canonicalBody, privateKey) { return bytesToHex(ed25519.sign(utf8ToBytes(canonicalBody), hexToBytes(privateKey))); }
function addressFromPubKey(publicKey) {
  const full = sha3_256(hexToBytes(publicKey));
  return bech32m.encode("zir", bech32m.toWords(full.slice(0, 20)));
}
function keypairFromPrivate(privateKey) {
  const publicKey = bytesToHex(ed25519.getPublicKey(hexToBytes(privateKey)));
  return { privateKey, publicKey, address: addressFromPubKey(publicKey) };
}
function signTx(body, privateKey) {
  const encoded = canonical({ ...body });
  return { ...body, id: hashHex(encoded), sig: sign(encoded, privateKey) };
}
function signRecord(record, privateKey) {
  const publicKey = bytesToHex(ed25519.getPublicKey(hexToBytes(privateKey)));
  const body = { ...record, pubKey: publicKey, sig: undefined };
  return { ...record, pubKey: publicKey, sig: sign(canonical(body), privateKey) };
}
function resolvePath(path) { return isAbsolute(path) ? path : resolve(path); }
function findFounderKey() {
  const derivedAddresses = [];
  const seen = new Set();
  for (const file of secretFiles.map(resolvePath)) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?:0x)?[0-9a-f]{64}/gi)) {
      const privateKey = match[0].toLowerCase().replace(/^0x/, "");
      if (seen.has(privateKey)) continue;
      seen.add(privateKey);
      try {
        const kp = keypairFromPrivate(privateKey);
        derivedAddresses.push(kp.address);
        if (founders.has(kp.address)) return { ...kp, source: file, derivedAddresses };
      } catch {
        // Ignore malformed note snippets.
      }
    }
  }
  return { derivedAddresses };
}
async function get(path) {
  const res = await fetch(`${rpc}/rpc${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed with HTTP ${res.status}`);
  return res.json();
}
async function post(path, body) {
  const res = await fetch(`${rpc}/rpc${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(parsed?.error || parsed?.reason || `POST ${path} failed with HTTP ${res.status}`);
  return parsed;
}

const founder = findFounderKey();
if (!founder.privateKey) {
  console.log(JSON.stringify({
    ok: false,
    message: "No local private key matched the mainnet launch-authority address set.",
    checkedFiles: secretFiles.map(resolvePath),
    derivedAddresses: [...new Set(founder.derivedAddresses ?? [])],
  }, null, 2));
  process.exit(1);
}

const stats = await get("/stats");
let nonce = Number((await get(`/nonce?address=${encodeURIComponent(founder.address)}`)).nonce ?? 0);
const results = [];

for (const spec of launchResonators) {
  const agent = keypairFromPrivate(hashHex(`${founder.privateKey}:launch-resonator:${spec.id}`));
  const current = await get(`/resonator?id=${encodeURIComponent(spec.id)}`).catch(() => null);
  if (current && current.owner && current.owner !== founder.address) throw new Error(`${spec.id} is owned by ${current.owner}, not ${founder.address}`);

  const currentBalance = Number((await get(`/balance?address=${encodeURIComponent(agent.address)}`).catch(() => ({ uZIR: 0 }))).uZIR ?? 0);
  const targetUZIR = toUZIR(spec.targetZir);
  const amountUZIR = Math.max(0, targetUZIR - currentBalance);
  let tx = null;
  let txResult = null;
  if (amountUZIR > 0) {
    tx = signTx({
      network: stats.network,
      from: founder.address,
      fromPubKey: founder.publicKey,
      to: agent.address,
      amountUZIR,
      feeUZIR: PROTOCOL.BASE_FEE_UZIR,
      nonce,
      kind: "transfer",
      memo: `launch fund ${spec.name}`,
      parents: [],
      timestamp: Date.now(),
    }, founder.privateKey);
    nonce += 1;
    if (!dryRun) txResult = await post("/tx", { tx });
  }

  const now = Date.now();
  const resonator = signRecord({
    id: spec.id,
    owner: founder.address,
    address: agent.address,
    name: spec.name,
    purpose: spec.purpose,
    systemPrompt: spec.prompt,
    domains: spec.domains,
    modelPref: "zira-field",
    zti: current?.zti ?? 0,
    ztiByDomain: current?.ztiByDomain ?? {},
    resonanceEnabled: true,
    balanceUZIR: Math.max(currentBalance, targetUZIR),
    spendLimits: {
      perTxUZIR: toUZIR(spec.perTxZir),
      perDayUZIR: toUZIR(spec.perDayZir),
      minCounterpartyZti: 0,
      allowedDomains: spec.domains,
    },
    totalEarnedUZIR: current?.totalEarnedUZIR ?? 0,
    totalSpentUZIR: current?.totalSpentUZIR ?? 0,
    jobsDone: current?.jobsDone ?? 0,
    priceUZIR: toUZIR(spec.priceZir),
    listed: true,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
    status: "learning",
  }, founder.privateKey);

  let published = null;
  if (!dryRun) published = await post("/resonator", { resonator });
  results.push({
    id: spec.id,
    name: spec.name,
    address: agent.address,
    fundedUZIR: amountUZIR,
    targetUZIR,
    tx: tx ? { id: tx.id, accepted: txResult?.accepted ?? null, reason: txResult?.reason } : null,
    published: dryRun ? null : Boolean(published?.id),
  });
}

console.log(JSON.stringify({ ok: true, dryRun, rpc, founder: founder.address, resonators: results }, null, 2));

