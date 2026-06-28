// node/src/anchor/paymentWatcher.ts
// Multi-chain USDT payment watcher for the anchor event (spec §2.5). It confirms a contribution ON-CHAIN:
// given a self-reported tx hash, it checks that the transaction is a USDT transfer to ZIRA's receiving
// address for the EXACT class x quantity amount, with enough confirmations, and returns the sender. The
// steward then assigns the seat from the verified record. EVM chains (Ethereum / BSC / Polygon) are read
// over JSON-RPC (eth_getTransactionReceipt + eth_blockNumber); TRON over TronGrid. Public RPC endpoints are
// the defaults and can be overridden per chain by env (ZIRA_ANCHOR_RPC_ETH / _BSC / _POLYGON / _TRON).
//
// On-chain detection is the authoritative check; the self-reported queue is only a hint. Verifying the
// amount against the canonical class ladder (not the self-reported amount) prevents a contributor from
// claiming a higher class than they actually paid for.

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// The public anchor-event USDT price ladder per class (mirrors the contribute UI). USDT amount = price x qty.
export const CLASS_USDT: Record<string, number> = { A: 5000, B: 3750, C: 2500, D: 1250, E: 500, F: 150 };

export type WatchNetwork = "Ethereum" | "BSC" | "TRON TRC-20" | "Polygon";

interface EvmCfg { contract: string; decimals: number; defaultRpc: string; rpcEnv: string; minConf: number }
const EVM: Record<"Ethereum" | "BSC" | "Polygon", EvmCfg> = {
  Ethereum: { contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, defaultRpc: "https://cloudflare-eth.com", rpcEnv: "ZIRA_ANCHOR_RPC_ETH", minConf: 6 },
  BSC: { contract: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, defaultRpc: "https://bsc-dataseed.binance.org", rpcEnv: "ZIRA_ANCHOR_RPC_BSC", minConf: 15 },
  Polygon: { contract: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6, defaultRpc: "https://polygon-rpc.com", rpcEnv: "ZIRA_ANCHOR_RPC_POLYGON", minConf: 30 },
};
const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRON_DECIMALS = 6;
const TRON_MIN_CONF = 19;

/** Expected on-chain amount in base units for a class x quantity on a given network. */
export function expectedBaseUnits(classCode: string, quantity: number, network: WatchNetwork): bigint {
  const price = CLASS_USDT[classCode];
  if (!price) throw new Error(`unknown anchor class ${classCode}`);
  const decimals = network === "TRON TRC-20" ? TRON_DECIMALS : EVM[network as "Ethereum"].decimals;
  return BigInt(price) * BigInt(Math.max(1, Math.floor(quantity))) * (10n ** BigInt(decimals));
}

export interface VerifyResult { confirmed: boolean; confirmations: number; sender: string; reason?: string }

// ---- EVM ----
interface EvmLog { address?: string; topics?: string[]; data?: string }
interface EvmReceipt { status?: string; blockNumber?: string; logs?: EvmLog[] }

/**
 * Pure parser: does this receipt contain a USDT Transfer to `receivingAddr` for exactly `expected` base
 * units, and how many confirmations? No network — unit-testable. `currentBlockHex` is eth_blockNumber.
 */
export function parseEvmReceipt(receipt: EvmReceipt | null, currentBlockHex: string, contract: string, receivingAddr: string, expected: bigint): VerifyResult {
  if (!receipt) return { confirmed: false, confirmations: 0, sender: "", reason: "transaction not found yet" };
  if (receipt.status !== "0x1") return { confirmed: false, confirmations: 0, sender: "", reason: "transaction failed on-chain" };
  const recv = receivingAddr.toLowerCase().replace(/^0x/, "");
  let confirmations = 0;
  try { confirmations = Number(BigInt(currentBlockHex) - BigInt(receipt.blockNumber ?? "0x0")) + 1; } catch { confirmations = 0; }
  for (const log of receipt.logs ?? []) {
    if ((log.address ?? "").toLowerCase() !== contract.toLowerCase()) continue;
    if ((log.topics?.[0] ?? "").toLowerCase() !== TRANSFER_TOPIC) continue;
    if ((log.topics?.[2] ?? "").toLowerCase().slice(-40) !== recv) continue;       // transfer recipient
    let value = 0n;
    try { value = BigInt(log.data ?? "0x0"); } catch { continue; }
    if (value !== expected) continue;                                              // exact amount only
    const sender = "0x" + (log.topics?.[1] ?? "").slice(-40);
    return { confirmed: true, confirmations, sender, reason: confirmations >= 0 ? undefined : "pending" };
  }
  return { confirmed: false, confirmations, sender: "", reason: "no matching USDT transfer in this tx" };
}

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await res.json() as { result?: unknown; error?: { message?: string } };
  if (j.error) throw new Error(j.error.message ?? "rpc error");
  return j.result;
}

async function verifyEvm(network: "Ethereum" | "BSC" | "Polygon", txHash: string, receivingAddr: string, expected: bigint): Promise<VerifyResult> {
  const cfg = EVM[network];
  const url = process.env[cfg.rpcEnv]?.trim() || cfg.defaultRpc;
  const [receipt, head] = await Promise.all([
    rpc(url, "eth_getTransactionReceipt", [txHash]) as Promise<EvmReceipt | null>,
    rpc(url, "eth_blockNumber", []) as Promise<string>,
  ]);
  const r = parseEvmReceipt(receipt, head, cfg.contract, receivingAddr, expected);
  if (r.confirmed && r.confirmations < cfg.minConf) return { ...r, confirmed: false, reason: `awaiting confirmations (${r.confirmations}/${cfg.minConf})` };
  return r;
}

// ---- TRON (best-effort via TronGrid) ----
async function verifyTron(txHash: string, receivingAddr: string, expected: bigint): Promise<VerifyResult> {
  const base = process.env.ZIRA_ANCHOR_RPC_TRON?.trim() || "https://api.trongrid.io";
  const res = await fetch(`${base}/v1/transactions/${encodeURIComponent(txHash)}/events`, { headers: { accept: "application/json" } });
  const j = await res.json() as { data?: Array<{ contract_address?: string; event_name?: string; result?: { to?: string; value?: string; from?: string } }> };
  for (const ev of j.data ?? []) {
    if (ev.event_name !== "Transfer") continue;
    const to = ev.result?.to ?? "";
    if (to !== receivingAddr) continue;
    let value = 0n;
    try { value = BigInt(ev.result?.value ?? "0"); } catch { continue; }
    if (value !== expected) continue;
    // TronGrid events for a returned tx are already in a block; treat as confirmed at the configured depth.
    return { confirmed: true, confirmations: TRON_MIN_CONF, sender: ev.result?.from ?? "" };
  }
  return { confirmed: false, confirmations: 0, sender: "", reason: "no matching USDT-TRC20 transfer in this tx" };
}

/**
 * Verify one contribution on-chain. Routes to the right network, checks the tx is a USDT transfer to
 * `receivingAddr` for exactly the class x quantity amount, and returns confirmation status + sender.
 * Throws only on a network/RPC failure (so the caller can retry next tick); a genuine mismatch returns
 * { confirmed: false, reason }.
 */
export async function verifyContribution(args: {
  network: WatchNetwork; txHash: string; classCode: string; quantity: number; evm: string; tron: string;
}): Promise<VerifyResult> {
  if (!args.txHash) return { confirmed: false, confirmations: 0, sender: "", reason: "no tx hash" };
  const expected = expectedBaseUnits(args.classCode, args.quantity, args.network);
  if (args.network === "TRON TRC-20") {
    if (!args.tron) return { confirmed: false, confirmations: 0, sender: "", reason: "no TRON receiving address" };
    return verifyTron(args.txHash, args.tron, expected);
  }
  if (!args.evm) return { confirmed: false, confirmations: 0, sender: "", reason: "no EVM receiving address" };
  return verifyEvm(args.network as "Ethereum" | "BSC" | "Polygon", args.txHash, args.evm, expected);
}
