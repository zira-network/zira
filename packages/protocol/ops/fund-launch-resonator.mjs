// packages/protocol/ops/fund-launch-resonator.mjs
// Secure operator helper for the launch Resonator. It finds a local mainnet founder key without
// printing it, funds the default ZIRA Resonator up to a target balance, and republishes sane spend
// limits so resonance can coordinate paid work.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { sha3_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { bech32m } from "@scure/base";

const PROTOCOL = {
  UZIR_PER_ZIR: 1_000_000,
  BASE_FEE_UZIR: 1_000,
};
const DOMAINS = [
  "compute", "energy", "carbon", "data", "currency", "goods", "code", "science",
  "reasoning", "language", "vision", "audio", "video", "robotics", "medicine", "law",
  "finance", "education", "creative", "security", "planning", "multimodal", "general",
];

const rpc = process.env.ZIRA_RPC || "http://127.0.0.1:8645";
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

const args = new Map(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith("--") && arg.includes("="))
    .map((arg) => {
      const [key, ...rest] = arg.slice(2).split("=");
      return [key, rest.join("=")];
    }),
);

const dryRun = process.argv.includes("--dry-run");
const resonatorId = args.get("id") || "zira";
const targetZir = numberArg("target-zir", 1000);
const perTxZir = numberArg("per-tx-zir", 10);
const perDayZir = numberArg("per-day-zir", 100);

function numberArg(name, fallback) {
  const raw = args.get(name);
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid --${name}: ${raw}`);
  return n;
}

function toUZIR(zir) {
  return Math.round(zir * PROTOCOL.UZIR_PER_ZIR);
}

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

function hashHex(input) {
  return bytesToHex(sha3_256(typeof input === "string" ? utf8ToBytes(input) : input));
}

function sign(canonicalBody, privateKey) {
  return bytesToHex(ed25519.sign(utf8ToBytes(canonicalBody), hexToBytes(privateKey)));
}

function addressFromPubKey(publicKey) {
  const full = sha3_256(hexToBytes(publicKey));
  const words = bech32m.toWords(full.slice(0, 20));
  return bech32m.encode("zir", words);
}

function keypairFromPrivate(privateKey) {
  const publicKey = bytesToHex(ed25519.getPublicKey(hexToBytes(privateKey)));
  return { privateKey, publicKey, address: addressFromPubKey(publicKey) };
}

function signTx(body, privateKey) {
  const normalized = { ...body };
  const encoded = canonical(normalized);
  return { ...normalized, id: hashHex(encoded), sig: sign(encoded, privateKey) };
}

function signRecord(record, privateKey) {
  const publicKey = bytesToHex(ed25519.getPublicKey(hexToBytes(privateKey)));
  const body = { ...record, pubKey: publicKey, sig: undefined };
  return { ...record, pubKey: publicKey, sig: sign(canonical(body), privateKey) };
}

function resolvePath(path) {
  return isAbsolute(path) ? path : resolve(path);
}

function candidatesFromFiles() {
  const out = [];
  const seen = new Set();
  for (const file of secretFiles.map(resolvePath)) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?:0x)?[0-9a-f]{64}/gi)) {
      const privateKey = match[0].toLowerCase().replace(/^0x/, "");
      if (seen.has(privateKey)) continue;
      seen.add(privateKey);
      out.push({ privateKey, source: file });
    }
  }
  return out;
}

function findFounderKey() {
  const derivedAddresses = [];
  for (const candidate of candidatesFromFiles()) {
    try {
      const kp = keypairFromPrivate(candidate.privateKey);
      derivedAddresses.push(kp.address);
      if (founders.has(kp.address)) return { ...candidate, ...kp, derivedAddresses };
    } catch {
      // Ignore malformed hex candidates from notes.
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

const [stats, resonator] = await Promise.all([
  get("/stats"),
  get(`/resonator?id=${encodeURIComponent(resonatorId)}`),
]);
if (!resonator) throw new Error(`resonator not found: ${resonatorId}`);
if (resonator.owner !== founder.address) {
  throw new Error(`resonator owner ${resonator.owner} does not match launch authority ${founder.address}`);
}

const [founderBalance, resonatorBalance, nonceResult] = await Promise.all([
  get(`/balance?address=${encodeURIComponent(founder.address)}`),
  get(`/balance?address=${encodeURIComponent(resonator.address)}`),
  get(`/nonce?address=${encodeURIComponent(founder.address)}`),
]);

const targetUZIR = toUZIR(targetZir);
const currentUZIR = Number(resonatorBalance.uZIR ?? 0);
const amountUZIR = Math.max(0, targetUZIR - currentUZIR);
const feeUZIR = amountUZIR > 0 ? PROTOCOL.BASE_FEE_UZIR : 0;
if (amountUZIR > 0 && Number(founderBalance.uZIR ?? 0) < amountUZIR + feeUZIR) {
  throw new Error("founder balance is too low for launch Resonator funding");
}

let txResult = null;
let tx = null;
if (amountUZIR > 0) {
  tx = signTx({
    network: stats.network,
    from: founder.address,
    fromPubKey: founder.publicKey,
    to: resonator.address,
    amountUZIR,
    feeUZIR,
    nonce: Number(nonceResult.nonce ?? 0),
    kind: "transfer",
    memo: `launch fund ${resonator.name}`,
    parents: [],
    timestamp: Date.now(),
  }, founder.privateKey);
  if (!dryRun) txResult = await post("/tx", { tx });
}

const updated = signRecord({
  ...resonator,
  balanceUZIR: amountUZIR > 0 ? currentUZIR + amountUZIR : currentUZIR,
  spendLimits: {
    ...(resonator.spendLimits ?? {}),
    perTxUZIR: toUZIR(perTxZir),
    perDayUZIR: toUZIR(perDayZir),
    minCounterpartyZti: resonator.spendLimits?.minCounterpartyZti ?? 0,
    allowedDomains: [...DOMAINS],
  },
  resonanceEnabled: true,
  status: "learning",
  updatedAt: Date.now(),
  pubKey: undefined,
  sig: undefined,
}, founder.privateKey);

let resonatorResult = null;
if (!dryRun) resonatorResult = await post("/resonator", { resonator: updated });

console.log(JSON.stringify({
  ok: true,
  dryRun,
  rpc,
  founder: founder.address,
  resonator: {
    id: resonator.id,
    address: resonator.address,
    targetUZIR,
    previousBalanceUZIR: currentUZIR,
    fundedUZIR: amountUZIR,
    spendLimits: updated.spendLimits,
    status: updated.status,
  },
  tx: tx ? { id: tx.id, accepted: txResult?.accepted ?? null, reason: txResult?.reason } : null,
  resonatorPublished: dryRun ? null : Boolean(resonatorResult?.id),
}, null, 2));

