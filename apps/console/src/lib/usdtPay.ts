// apps/console/src/lib/usdtPay.ts
// QR-code USDT contribution for the anchor event (spec §2.4) via WalletConnect. The contributor scans a
// QR with their mobile wallet, which works identically on desktop (Electron), web, and mobile, no browser
// extension or injected provider required. The app constructs the exact USDT transfer to ZIRA's published
// receiving address; the user approves it in their wallet. The WalletConnect SDK is heavy, so it is loaded
// lazily (only when a contribution starts), keeping the main bundle small. Requires a steward-set
// WalletConnect project id.

export type UsdtNetwork = "Ethereum" | "BSC" | "TRON TRC-20" | "Polygon";

// Public per-chain USDT token config. Decimals differ by chain (6 on Ethereum/Polygon, 18 on BSC).
const EVM: Record<"Ethereum" | "BSC" | "Polygon", { chainId: number; contract: string; decimals: number }> = {
  Ethereum: { chainId: 1, contract: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
  BSC: { chainId: 56, contract: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 },
  Polygon: { chainId: 137, contract: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },
};

// Base units for a human USDT amount at the given decimals, as a BigInt (BSC uses 18 decimals, so the
// value can exceed 2^53, BigInt is required, never a float multiply).
function toBaseUnits(amountUsdt: number, decimals: number): bigint {
  if (!Number.isFinite(amountUsdt) || amountUsdt < 0) throw new Error("invalid amount");
  const parts = String(amountUsdt).split(".");
  const whole = parts[0] || "0";
  const frac = parts[1] ?? "";
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * (10n ** BigInt(decimals)) + BigInt(fracPadded || "0");
}

// ERC-20 transfer(address,uint256) calldata, manual ABI encoding, no library needed.
function encodeErc20Transfer(to: string, amount: bigint): string {
  const selector = "a9059cbb";
  const addr = to.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const amt = amount.toString(16).padStart(64, "0");
  return "0x" + selector + addr + amt;
}

/**
 * One-tap USDT contribution over WalletConnect (QR). Opens a QR the contributor scans with their wallet,
 * then pushes the exact USDT transfer to `to` for approval. Returns the on-chain tx hash. EVM chains only
 * (Ethereum/BSC/Polygon); TRON contributions are sent to the displayed address by the contributor's TRON
 * wallet for now (a TRON WalletConnect path is a separate integration).
 */
export async function payUsdt(network: UsdtNetwork, to: string, amountUsdt: number, projectId: string): Promise<{ hash: string; network: UsdtNetwork }> {
  if (!to) throw new Error("No receiving address is set for this network yet.");
  if (network === "TRON TRC-20") throw new Error("For TRON, send USDT-TRC20 to the address shown from your TRON wallet. WalletConnect QR for TRON is a separate step.");
  if (!projectId) throw new Error("The steward has not set a WalletConnect project id yet, so QR contributions are not enabled.");
  const cfg = EVM[network];

  // Lazy-load the heavy WalletConnect SDK only when a contribution actually starts.
  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  const provider = await EthereumProvider.init({
    projectId,
    chains: [cfg.chainId],
    showQrModal: true,
    metadata: {
      name: "ZIRA",
      description: "ZIRA anchor contribution",
      url: typeof location !== "undefined" ? location.origin : "https://zira.network",
      icons: [],
    },
  });
  try {
    await provider.connect();                         // renders the QR modal; resolves once the wallet approves
    const from = (provider.accounts?.[0]) as string | undefined;
    if (!from) throw new Error("No wallet account was provided over WalletConnect.");
    const data = encodeErc20Transfer(to, toBaseUnits(amountUsdt, cfg.decimals));
    const hash = (await provider.request({ method: "eth_sendTransaction", params: [{ from, to: cfg.contract, data }] })) as string;
    return { hash, network };
  } finally {
    try { await provider.disconnect(); } catch { /* session cleanup is best-effort */ }
  }
}
