// packages/protocol/ops/settle-launch-miners.mjs
// Founder-funded launch settlement for online miners/providers. This is transparent ledger payment
// for live launch work; it is not protocol-minted emission and does not print private keys.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { ed25519 } from "@noble/curves/ed25519";
import { sha3_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { bech32m } from "@scure/base";

const PROTOCOL = { UZIR_PER_ZIR: 1_000_000, BASE_FEE_UZIR: 1_000 };
const rpc = process.env.ZIRA_RPC || "http://127.0.0.1:8645";
const minerPorts = (process.env.ZIRA_MINER_PORTS || "8645,8745,8845,8945,9045,9145,9245,9345").split(",").map((p) => Number(p.trim())).filter(Boolean);
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
const perProviderZir = numberArg("per-provider-zir", 1);
const minAnswered = numberArg("min-answered", 1);
const dailyCapZir = numberArg("daily-cap-zir", 20);
const settlementStatePath = resolvePath(process.env.ZIRA_SETTLEMENT_STATE || "local-private/launch-miner-settlements.json");

// ─────────────────────────────────────────────────────────────────────────────────────────────
// DEPRECATED — the founder does NOT pay miners. Miners now earn through the field's COORDINATION
// economy: paid field questions and Resonator hires split real ZIR to the contributing miners (by
// domain-trust weight) and the Resonators that did the work, plus the 5% network/stewardship fee,
// and those transfers settle on the live ledger. This founder-funded settlement path is retained
// only as a break-glass bootstrap tool and refuses to run unless explicitly forced.
// ─────────────────────────────────────────────────────────────────────────────────────────────
if (process.env.ZIRA_ALLOW_FOUNDER_PAY !== "1") {
  console.error(
    "settle-launch-miners is deprecated: the founder does not pay miners.\n" +
      "Miners earn via the coordination economy (field-query + hire splits to miners + Resonators + the 5% fee),\n" +
      "which settles on the ledger. If you genuinely need the break-glass bootstrap payout, set ZIRA_ALLOW_FOUNDER_PAY=1.",
  );
  process.exit(2);
}

function numberArg(name, fallback) {
  const raw = args.get(name);
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid --${name}: ${raw}`);
  return n;
}
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
function resolvePath(path) { return isAbsolute(path) ? path : resolve(path); }
function readSettlementState() {
  if (!existsSync(settlementStatePath)) return { miners: {} };
  try {
    const parsed = JSON.parse(readFileSync(settlementStatePath, "utf8"));
    return parsed && typeof parsed === "object" ? { miners: parsed.miners ?? {} } : { miners: {} };
  } catch {
    return { miners: {} };
  }
}
function writeSettlementState(state) {
  mkdirSync(dirname(settlementStatePath), { recursive: true });
  writeFileSync(settlementStatePath, JSON.stringify(state, null, 2) + "\n", "utf8");
}
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
async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} failed with HTTP ${res.status}`);
  return res.json();
}
async function get(path) { return getJson(`${rpc}/rpc${path}`); }
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
const founderBalance = Number((await get(`/balance?address=${encodeURIComponent(founder.address)}`)).uZIR ?? 0);
const amountUZIR = toUZIR(perProviderZir);
const dailyCapUZIR = toUZIR(dailyCapZir);
const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
const todayStartMs = todayStart.getTime();
const todayKey = todayStart.toISOString().slice(0, 10);
const settlementState = readSettlementState();
const candidates = [];
const skipped = [];

async function settlementProgress(address) {
  const history = await get(`/history?address=${encodeURIComponent(address)}&limit=200`).catch(() => []);
  let lastSettledAnswered = 0;
  let settledTodayUZIR = 0;
  for (const entry of Array.isArray(history) ? history : []) {
    if (entry.to !== address || entry.kind !== "transfer" || !/launch mining settlement/i.test(entry.memo ?? "")) continue;
    const match = String(entry.memo ?? "").match(/\bq=(\d+)\b/i);
    if (match) lastSettledAnswered = Math.max(lastSettledAnswered, Number(match[1]));
    if (Number(entry.timestamp ?? 0) >= todayStartMs) settledTodayUZIR += Number(entry.amountUZIR ?? 0);
  }
  const local = settlementState.miners?.[address];
  if (local?.date === todayKey) {
    lastSettledAnswered = Math.max(lastSettledAnswered, Number(local.lastSettledAnswered ?? 0));
    settledTodayUZIR = Math.max(settledTodayUZIR, Number(local.settledTodayUZIR ?? 0));
  }
  return { lastSettledAnswered, settledTodayUZIR };
}

for (const port of minerPorts) {
  try {
    const status = await getJson(`http://127.0.0.1:${port}/rpc/status`);
    const answered = Number(status.providerStatus?.queriesAnswered ?? 0);
    if (founders.has(status.address)) {
      skipped.push({ port, address: status.address, reason: "founder launch authority pays launch settlements; it is not a launch-miner recipient" });
      continue;
    }
    if (!status.mining?.enabled) {
      skipped.push({ port, address: status.address, reason: "mining disabled" });
      continue;
    }
    if (!status.mining?.serving) {
      skipped.push({ port, address: status.address, reason: "node is not serving mining work yet" });
      continue;
    }
    if (!status.providerStatus?.active) {
      skipped.push({ port, address: status.address, reason: "endpoint provider is not active; coordination-only mining is not launch-settled here" });
      continue;
    }
    if (!status.providerStatus?.reachable) {
      skipped.push({ port, address: status.address, reason: "endpoint provider is active but not reachable" });
      continue;
    }
    if (answered < minAnswered) {
      skipped.push({ port, address: status.address, reason: `answered ${answered}, below min ${minAnswered}` });
      continue;
    }
    const progress = await settlementProgress(status.address);
    const deltaAnswered = answered - progress.lastSettledAnswered;
    const remainingTodayUZIR = Math.max(0, dailyCapUZIR - progress.settledTodayUZIR);
    if (deltaAnswered < minAnswered) {
      skipped.push({ port, address: status.address, reason: `no new answered-query progress since q=${progress.lastSettledAnswered}`, queriesAnswered: answered });
      continue;
    }
    if (remainingTodayUZIR <= 0) {
      skipped.push({ port, address: status.address, reason: `daily cap reached (${dailyCapZir} ZIR)`, queriesAnswered: answered, settledTodayUZIR: progress.settledTodayUZIR });
      continue;
    }
    candidates.push({
      port,
      address: status.address,
      answerLabel: status.providerStatus?.active && status.providerConfig?.endpointModel
        ? status.providerConfig.endpointModel
        : status.mining.answerLabel,
      queriesAnswered: answered,
      deltaAnswered,
      amountUZIR: Math.min(amountUZIR, remainingTodayUZIR),
      alreadySettledTodayUZIR: progress.settledTodayUZIR,
    });
  } catch {
    skipped.push({ port, reason: "offline or status unreachable" });
  }
}

const unique = [...new Map(candidates.map((c) => [c.address, c])).values()];
const requiredUZIR = unique.reduce((sum, miner) => sum + miner.amountUZIR + PROTOCOL.BASE_FEE_UZIR, 0);
if (founderBalance < requiredUZIR) throw new Error("founder balance is too low for launch miner settlement");

const settlements = [];
for (const miner of unique) {
  const tx = signTx({
    network: stats.network,
    from: founder.address,
    fromPubKey: founder.publicKey,
    to: miner.address,
    amountUZIR: miner.amountUZIR,
    feeUZIR: PROTOCOL.BASE_FEE_UZIR,
    nonce,
    kind: "transfer",
    timestamp: Date.now(),
    memo: `launch mining settlement ${miner.answerLabel} q=${miner.queriesAnswered}`,
  }, founder.privateKey);
  nonce += 1;
  const result = dryRun ? null : await post("/tx", { tx });
  if (!dryRun && result?.accepted) {
    const previous = settlementState.miners[miner.address]?.date === todayKey ? settlementState.miners[miner.address] : {};
    settlementState.miners[miner.address] = {
      date: todayKey,
      lastSettledAnswered: Math.max(Number(previous.lastSettledAnswered ?? 0), miner.queriesAnswered),
      settledTodayUZIR: Math.max(Number(previous.settledTodayUZIR ?? 0), miner.alreadySettledTodayUZIR) + miner.amountUZIR,
      lastTxId: tx.id,
      updatedAt: Date.now(),
    };
  }
  settlements.push({
    port: miner.port,
    address: miner.address,
    amountUZIR: miner.amountUZIR,
    answerLabel: miner.answerLabel,
    queriesAnswered: miner.queriesAnswered,
    deltaAnswered: miner.deltaAnswered,
    alreadySettledTodayUZIR: miner.alreadySettledTodayUZIR,
    tx: { id: tx.id, accepted: result?.accepted ?? null, reason: result?.reason },
  });
}

if (!dryRun && settlements.some((s) => s.tx.accepted)) writeSettlementState(settlementState);

console.log(JSON.stringify({
  ok: true,
  dryRun,
  rpc,
  founder: founder.address,
  perProviderUZIR: amountUZIR,
  minAnswered,
  dailyCapUZIR,
  minersConsidered: candidates.length,
  minersSettled: settlements.length,
  settlements,
  skipped,
}, null, 2));

