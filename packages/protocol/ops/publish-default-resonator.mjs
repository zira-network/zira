// packages/protocol/ops/publish-default-resonator.mjs
// Publish the deterministic founder-owned default "ZIRA" Resonator (id "zira"), matching
// node/src/index.ts. Normally the bootstrap node publishes this automatically when it runs with the
// founder identity; this helper publishes it to a running node when the bootstrap was started as a
// plain node. It finds a local mainnet founder key without printing it.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { sha3_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { bech32m } from "@scure/base";

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
const secretFiles = [
  process.env.ZIRA_KEYS_FILE,
  "secrets/FOUNDER_WALLET.dm",
  "secrets/ZIRA_MAINNET_FOUNDERS_LOCAL.dm",
  "local-private/ZIRA_WALLETS_AND_KEYS_LOCAL.dm",
  "../local-private/ZIRA_WALLETS_AND_KEYS_LOCAL.dm",
].filter(Boolean);

function resolvePath(p) { return isAbsolute(p) ? p : resolve(p); }
function canonical(value) {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "number") { if (!Number.isFinite(value)) throw new Error("canonical: non finite"); return JSON.stringify(value); }
  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (t === "object") { const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort(); return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}"; }
  throw new Error("canonical: unsupported type " + t);
}
function hashHex(input) { return bytesToHex(sha3_256(typeof input === "string" ? utf8ToBytes(input) : input)); }
function sign(body, pk) { return bytesToHex(ed25519.sign(utf8ToBytes(body), hexToBytes(pk))); }
function addressFromPubKey(pub) { const full = sha3_256(hexToBytes(pub)); return bech32m.encode("zir", bech32m.toWords(full.slice(0, 20))); }
function keypairFromPrivate(pk) { const pub = bytesToHex(ed25519.getPublicKey(hexToBytes(pk))); return { privateKey: pk, publicKey: pub, address: addressFromPubKey(pub) }; }
function signRecord(record, pk) { const pub = bytesToHex(ed25519.getPublicKey(hexToBytes(pk))); const body = { ...record, pubKey: pub, sig: undefined }; return { ...record, pubKey: pub, sig: sign(canonical(body), pk) }; }
function findFounderKey() {
  for (const file of secretFiles.map(resolvePath)) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/(?:0x)?[0-9a-f]{64}/gi)) {
      const pk = m[0].toLowerCase().replace(/^0x/, "");
      try { const kp = keypairFromPrivate(pk); if (founders.has(kp.address)) return kp; } catch { /* ignore */ }
    }
  }
  return null;
}
async function get(path) { const r = await fetch(`${rpc}/rpc${path}`); if (!r.ok) throw new Error(`GET ${path} HTTP ${r.status}`); return r.json(); }
async function post(path, body) { const r = await fetch(`${rpc}/rpc${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const t = await r.text(); const p = t ? JSON.parse(t) : null; if (!r.ok) throw new Error(p?.error || `POST ${path} HTTP ${r.status}`); return p; }

const founder = findFounderKey();
if (!founder) throw new Error("No local private key matched the mainnet founder address set.");
const stats = await get("/stats");
const genesisFounder = stats.founderAddress;
if (founder.address !== genesisFounder) throw new Error(`Found founder ${founder.address} but genesis founder is ${genesisFounder}`);
const agent = keypairFromPrivate(hashHex(founder.privateKey + ":zira-default-resonator"));
const now = Date.now();
const def = signRecord({
  id: "zira", owner: founder.address, address: agent.address, name: "ZIRA",
  purpose: "The ZIRA assistant, answered by the whole field.",
  systemPrompt: "You are a clear and helpful assistant. Answer the user's question directly and concisely. Do not bring up the network, how you are hosted, or tokens unless the user asks about them. Never use an em dash.",
  domains: [...DOMAINS], modelPref: "zira-field", zti: 0, ztiByDomain: {},
  resonanceEnabled: true, balanceUZIR: 0,
  spendLimits: { perTxUZIR: 0, perDayUZIR: 0, minCounterpartyZti: 0, allowedDomains: [...DOMAINS] },
  totalEarnedUZIR: 0, totalSpentUZIR: 0, jobsDone: 0, priceUZIR: 0, listed: true,
  createdAt: now, updatedAt: now, status: "idle",
}, founder.privateKey);
const published = await post("/resonator", { resonator: def });
console.log(JSON.stringify({ ok: true, rpc, owner: founder.address, id: "zira", published: Boolean(published?.id) }, null, 2));
