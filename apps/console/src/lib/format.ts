import { PROTOCOL, type uZIR } from "@zira/protocol";

/** Format uZIR as a ZIR string with thousands separators and up to 6 decimals. */
export function formatZir(uzir: uZIR): string {
  const zir = uzir / PROTOCOL.UZIR_PER_ZIR;
  if (Math.abs(zir) >= 1) {
    return zir.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  return zir.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

/** Format the raw uZIR integer with separators. */
export function formatUZir(uzir: uZIR): string {
  return Math.round(uzir).toLocaleString();
}

/** Shorten an address: zir1abc...wxyz. */
export function shortAddress(addr: string, head = 8, tail = 5): string {
  if (!addr) return "";
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}...${addr.slice(-tail)}`;
}

/** Shorten a hash for display. */
export function shortHash(hash: string, head = 6, tail = 6): string {
  if (!hash) return "";
  if (hash.length <= head + tail + 1) return hash;
  return `${hash.slice(0, head)}...${hash.slice(-tail)}`;
}

/** A short word for a 0..1 trust value. */
export function ztiLabel(zti: number): string {
  if (zti >= PROTOCOL.MASTER_NODE_ZTI) return "Master";
  if (zti >= 0.5) return "Trusted";
  if (zti >= 0.25) return "Forming";
  if (zti > 0) return "New";
  return "Unproven";
}

/** A relative time string from a ms timestamp. */
export function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) return "soon";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Format a number for display in mono. */
export function formatNum(n: number, digits = 2): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}
