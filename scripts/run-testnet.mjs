// scripts/run-testnet.mjs
// Bring up a local two node ZIRA testnet to see real peer to peer sync. Node A is the genesis
// steward (bootstrap master) and seeds the devnet field. Node B is a fresh peer that bootstraps
// to A. Run after building the node: pnpm build:node, then node scripts/run-testnet.mjs
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "node", "dist", "index.js");
const dataA = join(root, ".zira-testnet", "a");
const dataB = join(root, ".zira-testnet", "b");

function start(name, env) {
  const child = spawn(process.execPath, [entry], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const tag = `[${name}]`;
  child.stdout.on("data", (d) => process.stdout.write(prefix(tag, d)));
  child.stderr.on("data", (d) => process.stderr.write(prefix(tag, d)));
  child.on("exit", (code) => console.log(`${tag} exited ${code}`));
  return child;
}
function prefix(tag, buf) {
  return buf.toString().split("\n").filter(Boolean).map((l) => `${tag} ${l}\n`).join("");
}

console.log("Starting node A (steward, seed)...");
const a = start("A", {
  ZIRA_NETWORK: "devnet", ZIRA_STEWARD: "1", ZIRA_SEED: "1",
  ZIRA_RPC_PORT: "8645", ZIRA_P2P_PORT: "9645", ZIRA_WS_PORT: "9646",
  ZIRA_DATA_DIR: dataA, ZIRA_SERVE_CONSOLE: "1",
});

// wait for A to print a dialable multiaddr, then start B bootstrapped to it
let started = false;
a.stdout.on("data", (d) => {
  if (started) return;
  const m = d.toString().match(/listening (\/ip4\/127\.0\.0\.1\/tcp\/9645\/p2p\/\S+)/);
  if (m) {
    started = true;
    const aAddr = m[1];
    console.log("\nNode A is up. Bootstrapping node B to:", aAddr, "\n");
    start("B", {
      ZIRA_NETWORK: "devnet",
      ZIRA_RPC_PORT: "8745", ZIRA_P2P_PORT: "9745", ZIRA_WS_PORT: "9746",
      ZIRA_DATA_DIR: dataB, ZIRA_BOOTSTRAP: aAddr, ZIRA_SERVE_CONSOLE: "1",
    });
    console.log("\nConsole A: http://127.0.0.1:8645   Console B: http://127.0.0.1:8745");
    console.log("Open either. They sync over libp2p. Ctrl+C to stop.\n");
  }
});

process.on("SIGINT", () => { a.kill(); process.exit(0); });
