// packages/protocol/ops/seed-bootstrap-registry.mjs
// Generate and sign the launch bootstrap registry consumed by clean nodes for first-contact peers.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import net from "node:net";
import { ed25519 } from "@noble/curves/ed25519";
import { sha3_256 } from "@noble/hashes/sha3";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { bech32m } from "@scure/base";

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
function flag(name) { return process.argv.includes(`--${name}`); }
function resolvePath(path) { return isAbsolute(path) ? path : resolve(path); }
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
function findFounderKey() {
  const privateFromEnv = process.env.ZIRA_FOUNDER_KEY?.trim().replace(/^0x/, "").toLowerCase();
  const candidates = privateFromEnv ? [{ key: privateFromEnv, source: "ZIRA_FOUNDER_KEY" }] : [];
  const derivedAddresses = [];
  const seen = new Set(privateFromEnv ? [privateFromEnv] : []);
  for (const file of secretFiles.map(resolvePath)) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?:0x)?[0-9a-f]{64}/gi)) {
      const key = match[0].toLowerCase().replace(/^0x/, "");
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ key, source: file });
    }
  }
  for (const candidate of candidates) {
    try {
      const kp = keypairFromPrivate(candidate.key);
      derivedAddresses.push(kp.address);
      if (founders.has(kp.address)) return { ...kp, source: candidate.source, derivedAddresses };
    } catch {
      // Ignore malformed secret snippets.
    }
  }
  return { derivedAddresses };
}
function parseRoles(value) {
  return String(value || "bootstrap,community-seed").split(",").map((role) => role.trim()).filter(Boolean);
}
function parseSeeds() {
  const positional = process.argv.filter((value) => value.startsWith("/") && value.includes("/p2p/"));
  const seeds = [...process.argv.filter((value) => value.startsWith("--seed=")).map((value) => value.slice("--seed=".length)), ...positional];
  const csv = arg("seeds", "");
  if (csv) seeds.push(...csv.split(","));
  return [...new Set(seeds.map((seed) => seed.trim()).filter(Boolean))];
}
function parseMultiaddr(addr) {
  const match = addr.match(/^\/(ip4|ip6|dns4|dns6)\/([^/]+)\/tcp\/(\d+)(?:\/ws)?\/p2p\/([^/]+)$/);
  if (!match) throw new Error(`unsupported seed multiaddr: ${addr}`);
  return { kind: match[1], host: match[2], port: Number(match[3]), peerId: match[4] };
}
function publicish(addr) {
  return !/\/(ip4|dns4)\/(127\.|localhost|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(addr);
}
async function inferSeedFromRpc(rpc) {
  const res = await fetch(`${rpc}/rpc/net`);
  if (!res.ok) throw new Error(`GET /rpc/net failed with HTTP ${res.status}`);
  const netInfo = await res.json();
  const addrs = Array.isArray(netInfo.addrs) ? netInfo.addrs : [];
  const peerId = netInfo.peerId;
  const withPeer = addrs.map((addr) => addr.includes("/p2p/") ? addr : `${addr}/p2p/${peerId}`);
  return withPeer.find((addr) => addr.includes("/tcp/") && addr.includes("/p2p/") && publicish(addr)) ?? "";
}
async function tcpReachable(seed, timeoutMs) {
  const parsed = parseMultiaddr(seed);
  if (parsed.kind !== "ip4" && parsed.kind !== "dns4") return { ok: false, reason: `reachability check only supports ip4/dns4, got ${parsed.kind}` };
  return new Promise((resolveCheck) => {
    const socket = net.createConnection({ host: parsed.host, port: parsed.port });
    const done = (ok, reason = "") => {
      socket.removeAllListeners();
      socket.destroy();
      resolveCheck({ ok, reason });
    };
    socket.setTimeout(timeoutMs, () => done(false, "timeout"));
    socket.once("connect", () => done(true));
    socket.once("error", (e) => done(false, e.message));
  });
}

const output = resolvePath(arg("output", "docs/bootstrap-seeds.json"));
const network = arg("network", "mainnet");
const rpc = process.env.ZIRA_RPC || arg("rpc", "http://127.0.0.1:8645");
const label = arg("label", "Official ZIRA bootstrap seed");
const region = arg("region", undefined);
const roles = parseRoles(arg("roles"));
const masterRoles = parseRoles(arg("master-roles", "master,bootstrap,community-seed"));
const masterCount = Math.max(0, Number(arg("master-count", "0")) || 0);
const empty = flag("empty");
const allowUnreachable = flag("allow-unreachable");
const skipCheck = flag("skip-check");
const dryRun = flag("dry-run");
const ttlDays = arg("ttl-days", "");

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

let seeds = parseSeeds();
if (seeds.length === 0 && !empty) {
  const inferred = await inferSeedFromRpc(rpc).catch(() => "");
  if (inferred) seeds = [inferred];
}
if (seeds.length === 0 && !empty) throw new Error("No seed multiaddr supplied and none could be inferred from /rpc/net");

const checks = [];
if (!skipCheck) {
  for (const seed of seeds) {
    const result = await tcpReachable(seed, Number(arg("timeout-ms", "6000")));
    checks.push({ seed, ...result });
  }
  const failures = checks.filter((check) => !check.ok);
  if (failures.length && !allowUnreachable) {
    console.log(JSON.stringify({
      ok: false,
      message: "One or more seed addresses failed TCP reachability. Re-run with --allow-unreachable only after an outside-network check confirms reachability.",
      checks,
    }, null, 2));
    process.exit(1);
  }
}

const generatedAt = Date.now();
const registry = signRecord({
  version: 1,
  network,
  generatedAt,
  expiresAt: ttlDays ? generatedAt + Number(ttlDays) * 24 * 60 * 60 * 1000 : undefined,
  seeds: seeds.map((multiaddr, index) => ({
    multiaddr,
    label: seeds.length === 1 ? label : `${label} ${index + 1}`,
    roles: index < masterCount ? masterRoles : roles,
    region,
    priority: index + 1,
  })),
}, founder.privateKey);

if (!dryRun) {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}
console.log(JSON.stringify({ ok: true, dryRun, output, network, signer: founder.address, seeds, checks }, null, 2));
