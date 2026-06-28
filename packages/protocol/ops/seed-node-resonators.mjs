// packages/protocol/ops/seed-node-resonators.mjs
// Publish deterministic Resonators owned by a local node identity, funded by the launch authority.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { sha3_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { bech32m } from "@scure/base";

const PROTOCOL = { UZIR_PER_ZIR: 1_000_000, BASE_FEE_UZIR: 1_000 };
const founders = new Set([
  "zir1km32wyjkya4h6utahkuckm56zgshnevy4v3a7t",
  "zir1c7q2fzk6lmaxsnx4s7twftzlpcd749xa6v0r7z",
  "zir1czsjyrjf8wts662kd7s9um4nmyaapjhcvr0x7n",
]);
const secretFiles = [
  "secrets/FOUNDER_WALLET.dm",
  "secrets/ZIRA_MAINNET_FOUNDERS_LOCAL.dm",
  "local-private/ZIRA_WALLETS_AND_KEYS_LOCAL.dm",
];

function arg(name, fallback = undefined) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}
function resolvePath(path) { return isAbsolute(path) ? path : resolve(path); }
function toUZIR(zir) { return Math.round(Number(zir) * PROTOCOL.UZIR_PER_ZIR); }
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
function signRecord(record, privateKey) {
  const publicKey = bytesToHex(ed25519.getPublicKey(hexToBytes(privateKey)));
  const body = { ...record, pubKey: publicKey, sig: undefined };
  return { ...record, pubKey: publicKey, sig: sign(canonical(body), privateKey) };
}
function signTx(body, privateKey) {
  const encoded = canonical({ ...body });
  return { ...body, id: hashHex(encoded), sig: sign(encoded, privateKey) };
}
function findFounderKey() {
  for (const file of secretFiles.map(resolvePath)) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?:0x)?[0-9a-f]{64}/gi)) {
      const privateKey = match[0].toLowerCase().replace(/^0x/, "");
      try {
        const kp = keypairFromPrivate(privateKey);
        if (founders.has(kp.address)) return { ...kp, source: file };
      } catch {
        // Ignore malformed note snippets.
      }
    }
  }
  return null;
}
async function get(rpc, path) {
  const res = await fetch(`${rpc}/rpc${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed with HTTP ${res.status}`);
  return res.json();
}
async function post(rpc, path, body) {
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

const rpc = process.env.ZIRA_RPC || arg("rpc", "http://127.0.0.1:8645");
const identityPath = resolvePath(arg("identity", "local-private/runtime-mainnet/nodes/storage-peer/identity.json"));
const prefix = arg("prefix", "node");
const ownerLabel = arg("label", "Node");
const targetZir = Number(arg("target-zir", "25"));
const founder = findFounderKey();
if (!founder) throw new Error("No local private key matched the mainnet launch-authority address set.");
if (!existsSync(identityPath)) throw new Error(`Node identity file not found: ${identityPath}`);

const identity = JSON.parse(readFileSync(identityPath, "utf8"));
const owner = keypairFromPrivate(String(identity.privateKey).trim());
const specs = [
  {
    id: `${prefix}-workspace-builder`,
    name: `${ownerLabel} Workspace Builder`,
    purpose: "Builds, edits, plans, and debugs local workspace tasks routed through the ZIRA field.",
    domains: ["code", "planning", "general"],
    prompt: "You help this node execute local workspace build, file, planning, and debugging tasks through field coordination.",
  },
  {
    id: `${prefix}-field-coordinator`,
    name: `${ownerLabel} Field Coordinator`,
    purpose: "Coordinates peer continuity, Resonator state, observations, and field status from this node.",
    domains: ["reasoning", "planning", "general"],
    prompt: "You coordinate ZIRA field status from this node. Track peer sync, observations, task routing, and continuity.",
  },
];

const stats = await get(rpc, "/stats");
let nonce = Number((await get(rpc, `/nonce?address=${encodeURIComponent(founder.address)}`)).nonce ?? 0);
const results = [];
for (const spec of specs) {
  const agent = keypairFromPrivate(hashHex(`${owner.privateKey}:node-resonator:${spec.id}`));
  const current = await get(rpc, `/resonator?id=${encodeURIComponent(spec.id)}`).catch(() => null);
  if (current && current.owner && current.owner !== owner.address) throw new Error(`${spec.id} is owned by ${current.owner}, not ${owner.address}`);
  const currentBalance = Number((await get(rpc, `/balance?address=${encodeURIComponent(agent.address)}`).catch(() => ({ uZIR: 0 }))).uZIR ?? 0);
  const targetUZIR = toUZIR(targetZir);
  const amountUZIR = Math.max(0, targetUZIR - currentBalance);
  let txResult = null;
  let tx = null;
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
      memo: `node resonator fund ${spec.name}`,
      parents: [],
      timestamp: Date.now(),
    }, founder.privateKey);
    nonce += 1;
    txResult = await post(rpc, "/tx", { tx });
  }
  const now = Date.now();
  const resonator = signRecord({
    id: spec.id,
    owner: owner.address,
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
    spendLimits: { perTxUZIR: toUZIR(1), perDayUZIR: toUZIR(8), minCounterpartyZti: 0, allowedDomains: spec.domains },
    totalEarnedUZIR: current?.totalEarnedUZIR ?? 0,
    totalSpentUZIR: current?.totalSpentUZIR ?? 0,
    jobsDone: current?.jobsDone ?? 0,
    priceUZIR: toUZIR(1),
    listed: true,
    createdAt: current?.createdAt ?? now,
    updatedAt: now,
    status: "learning",
  }, owner.privateKey);
  const published = await post(rpc, "/resonator", { resonator });
  results.push({ id: spec.id, name: spec.name, owner: owner.address, address: agent.address, fundedUZIR: amountUZIR, tx: tx ? { id: tx.id, accepted: txResult?.accepted ?? null } : null, published: Boolean(published?.id) });
}

console.log(JSON.stringify({ ok: true, rpc, owner: owner.address, resonators: results }, null, 2));
