// apps/console/src/app/Explorer.tsx
// The public RPC surface, read live from the node/gateway: network health, supply audit, online model
// providers, the 512 anchor seats, signed event history, address lookup, and recent Locks. This is the
// same public data an exchange or indexer reads. Every panel shows live data or an honest empty state.
import { useEffect, useState, type ReactNode } from "react";
import { Copy, ChevronDown, ChevronRight } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { PROTOCOL, TOTAL_ANCHOR_SEATS, MAINNET_ANCHOR_STEWARD, type SignedTx } from "@zira/protocol";
import {
  Card, Badge, Meter, Select, Button, Input, PageHeader,
  EmptyState, LoadingState, ErrorState, useSlowHint, usePoll, useToast,
} from "../components/ui";
import { useZira } from "../store/useZira";
import { formatNum, formatZir, shortAddress, shortHash, timeAgo } from "../lib/format";
import { loadReconciledHistory } from "../lib/history";
import { NodeApi, type ExtendedStats, type SupplyInfo, type ProviderView, type AnchorSeatSummary } from "../lib/nodeApi";
import { NeonDial } from "../components/viz";

// ---- local helpers (kept in this file; not promoted to ui.tsx) ----

// Copy any full value to the clipboard with a toast confirmation. Used on hashes, addresses, and the
// state root so every identifier on the explorer is copyable in full even when displayed truncated.
function CopyButton({ value, label = "Copied" }: { value: string; label?: string }) {
  const toast = useToast();
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(value); toast.push(label); }}
      className="shrink-0 text-muted transition-colors hover:text-text"
      title="Copy"
      aria-label="Copy to clipboard"
    >
      <Copy size={12} />
    </button>
  );
}

// One consistent metric cell: small faint label over a mono value, with an optional sub-line.
function Metric({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "teal" | "warn" | "danger" }) {
  const valueColor = tone === "teal" ? "text-[var(--teal)]" : tone === "warn" ? "text-[var(--warn)]" : tone === "danger" ? "text-[var(--danger)]" : "text-text";
  return (
    <div className="rounded-lg border border-hairline bg-base/80 p-3">
      <div className="text-[11px] uppercase tracking-wide text-faint">{label}</div>
      <div className={`mono mt-1 break-words text-sm ${valueColor}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-faint">{sub}</div>}
    </div>
  );
}

export function Explorer() {
  const { mode } = useZira();

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-5">
      <PageHeader
        title="Explorer"
        badge={<Badge tone="teal">live</Badge>}
        description="Trace the whole network. Every transfer, reward, and answer is a signed public record, the same data an exchange or indexer reads."
      />
      <NetworkAndSupply showHealth={mode === "node"} />
      <div className="grid gap-4 lg:grid-cols-2">
        <ProvidersPanel />
        <AnchorsPanel />
      </div>
      <AddressLookup />
      <TxExplorer />
    </div>
  );
}

// Network health + supply audit in one card, on a single shared poll (replaces the two separate
// hero cards that each re-fetched /stats). Checkpoint finality, mempool depth, and an auditable
// supply breakdown live here.
function NetworkAndSupply({ showHealth }: { showHealth: boolean }) {
  const [stats, setStats] = useState<ExtendedStats | null>(null);
  const [supply, setSupply] = useState<SupplyInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatedAt, setUpdatedAt] = useState(0);
  const [showApi, setShowApi] = useState(false);
  const slow = useSlowHint(loading);

  const load = () => {
    // The Explorer shows the canonical NETWORK view from the shared consensus gateway (identical to the
    // website Explorer), so it matches the web and never shows a desktop node's partial/still-syncing state.
    // Fall back to the local node only if the gateway is unreachable, so an offline desktop node still renders.
    Promise.all([NodeApi.networkStats(), NodeApi.networkSupply()])
      .catch(() => Promise.all([NodeApi.stats(), NodeApi.supply()]))
      .then(([nextStats, nextSupply]) => { setStats(nextStats); setSupply(nextSupply); setError(""); setUpdatedAt(Date.now()); })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not reach the network."))
      .finally(() => setLoading(false));
  };
  usePoll(load, 8000, []);

  const maxSupply = supply?.maxSupplyUZIR ?? PROTOCOL.MAX_SUPPLY_UZIR;
  const circulating = supply?.circulating ?? stats?.circulatingUZIR ?? 0;
  const reserve = supply?.reserve ?? stats?.reserveUZIR ?? PROTOCOL.RESERVE_UZIR;
  const emitted = supply?.emitted ?? stats?.emittedUZIR ?? 0;
  const burned = supply?.burned ?? stats?.burnedUZIR ?? 0;
  const issued = supply?.issued ?? (reserve + emitted);
  const earnedCap = maxSupply * PROTOCOL.EARNED_SHARE;
  const emissionPct = earnedCap > 0 ? emitted / earnedCap : 0;
  const auditFailed = supply?.auditAgrees === false;

  // checkpoint finality depth
  const finalized = stats?.finalizedEpoch ?? -1;
  const current = stats?.currentEpoch ?? finalized;
  const lag = finalized >= 0 ? Math.max(0, current - finalized) : -1;

  // supply share fractions for the stacked bar (emitted / reserve / burned over max supply)
  const seg = (n: number) => maxSupply > 0 ? Math.max(0, Math.min(100, (n / maxSupply) * 100)) : 0;

  return (
    <Card>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <Badge tone="indigo">network &amp; supply</Badge>
          <h3 className="mt-2 text-sm font-semibold">Network health and supply audit</h3>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {updatedAt > 0 && <span className="text-[11px] text-faint">updated {timeAgo(updatedAt)}</span>}
          <Badge tone={auditFailed ? "danger" : "teal"}>{auditFailed ? "audit mismatch" : "supply audit ok"}</Badge>
        </div>
      </div>

      {auditFailed && (
        <div className="mb-3">
          <ErrorState message={`Supply audit mismatch: issued ${formatZir(issued)} ZIR does not reconcile with emitted + reserve. An exchange should treat the chain as unverified until this clears.`} onRetry={load} />
        </div>
      )}

      {loading && !stats && !supply ? <LoadingState slow={slow} /> : error && !stats && !supply ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <>
          {/* Network / checkpoint health (node mode only) */}
          {showHealth && stats && (
            <div className="mb-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Metric label="Network" value={stats.network} />
                <Metric label="Peers" value={String(stats.peers)} />
                <Metric label="Master nodes" value={String(stats.mastersCount)} sub={`finality at ${(PROTOCOL.FINALITY_THRESHOLD * 100).toFixed(0)}% trust`} />
                <Metric label="Models in field" value={String(stats.models)} />
                <Metric
                  label="Finality"
                  value={finalized >= 0 ? `${finalized} / ${current}` : "starting"}
                  sub={finalized >= 0 ? `final / current epoch` : undefined}
                  tone={lag < 0 ? undefined : lag <= 1 ? "teal" : "warn"}
                />
                <Metric label="Mempool" value={`${stats.pool?.txs ?? 0} tx`} sub={`${stats.pool?.observations ?? 0} observations`} />
                <Metric label="Locks / min" value={String(stats.locksPerMinute)} />
                <Metric label="Providers online" value={String(stats.providersOnline)} />
              </div>
              <div className="mt-2 flex items-center gap-2 text-[11px] text-faint">
                <span className="mono break-all">state root {shortHash(stats.stateRoot, 10, 8)}</span>
                <CopyButton value={stats.stateRoot} label="State root copied" />
              </div>
            </div>
          )}

          {/* Supply breakdown with a stacked share bar */}
          <div>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
              <div className="flex shrink-0 justify-center sm:block">
                <NeonDial value={emissionPct} size={104} label={`${(emissionPct * 100).toFixed(1)}%`} sub="emitted" />
              </div>
              <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center justify-between text-[11px] text-faint">
              <span>Supply of {formatZir(maxSupply)} ZIR max</span>
              <span className="mono">{(emissionPct * 100).toFixed(2)}% of earned cap emitted</span>
            </div>
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-elevated" title="emitted · reserve · burned of max supply">
              <div className="h-full bg-[var(--teal)]" style={{ width: `${seg(emitted)}%` }} />
              <div className="h-full bg-[var(--accent)]" style={{ width: `${seg(reserve)}%` }} />
              <div className="h-full bg-[var(--danger)]" style={{ width: `${seg(burned)}%` }} />
            </div>
            <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-faint">
              <span><span className="inline-block h-2 w-2 rounded-full bg-[var(--teal)] align-middle" /> emitted</span>
              <span><span className="inline-block h-2 w-2 rounded-full bg-[var(--accent)] align-middle" /> reserve</span>
              <span><span className="inline-block h-2 w-2 rounded-full bg-[var(--danger)] align-middle" /> burned</span>
            </div>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Metric label="Circulating" value={`${formatZir(circulating)} ZIR`} />
              <Metric label="Issued" value={`${formatZir(issued)} ZIR`} />
              <Metric label="Genesis reserve (41%)" value={`${formatZir(reserve)} ZIR`} />
              <Metric label="Burned fees" value={`${formatZir(burned)} ZIR`} tone="danger" />
            </div>
          </div>

          {/* developer / API surface, collapsed by default so it doesn't dominate the page */}
          <button
            type="button"
            onClick={() => setShowApi((v) => !v)}
            className="mt-4 flex items-center gap-1 text-[11px] font-medium text-muted transition-colors hover:text-text"
          >
            {showApi ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Developer / API surface
          </button>
          {showApi && (
            <div className="mt-2 grid gap-2 text-xs lg:grid-cols-3">
              <div className="rounded-lg border border-hairline bg-surface/70 p-3"><div className="font-medium text-text">Explorer API</div><div className="mt-1 text-faint">Use `/rpc/stats`, `/rpc/supply`, `/rpc/history`, `/rpc/balance`, and `/rpc/events` for public indexers.</div></div>
              <div className="rounded-lg border border-hairline bg-surface/70 p-3"><div className="font-medium text-text">Exchange checks</div><div className="mt-1 text-faint">Verify address format `zir1...`, signed tx ids, network `mainnet`, fees in uZIR, and supply audit agreement.</div></div>
              <div className="rounded-lg border border-hairline bg-surface/70 p-3"><div className="font-medium text-text">Units</div><div className="mt-1 text-faint">Ticker ZIR. 1 ZIR = 1,000,000 uZIR. Network {stats?.network ?? "mainnet"}.</div></div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// Exchange grade view of the ledger: recent transactions with full, verifiable detail.
const TX_PAGE_SIZE = 12;
const TX_WINDOW = 400;
const TX_TONE = (k: string): "teal" | "indigo" | "danger" | "neutral" =>
  k === "reward" || k === "reserve_grant" ? "teal" : k === "agent_spend" ? "indigo" : k === "bond_burn" ? "danger" : "neutral";

function TxExplorer() {
  const client = useZira((s) => s.client);
  const [txs, setTxs] = useState<SignedTx[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [sp] = useSearchParams();
  const [query, setQuery] = useState(sp.get("q") ?? "");
  const [kind, setKind] = useState("all");
  // address filter: show only events touching this address (as sender or recipient).
  const [addr, setAddr] = useState(sp.get("addr") ?? "");
  const [page, setPage] = useState(0);
  const slow = useSlowHint(loading);

  const load = () => {
    if (!client) return;
    client.getRecentEvents(TX_WINDOW)
      .then((next) => { setTxs(next); setError(""); })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load the event window."))
      .finally(() => setLoading(false));
  };
  usePoll(load, 6000, [client]);

  const a = addr.trim().toLowerCase();
  const filtered = txs.filter((tx) => {
    if (kind !== "all" && tx.kind !== kind) return false;
    if (a && !(String(tx.from ?? "").toLowerCase().includes(a) || String(tx.to ?? "").toLowerCase().includes(a))) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [tx.id, tx.from, tx.to, tx.kind, tx.memo, ...(tx.parents ?? [])].filter(Boolean).some((v) => String(v).toLowerCase().includes(q));
  });
  // Reset to the first page whenever a filter changes so the user is never stranded on an empty page.
  useEffect(() => { setPage(0); }, [query, kind, addr]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / TX_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const rows = filtered.slice(safePage * TX_PAGE_SIZE, safePage * TX_PAGE_SIZE + TX_PAGE_SIZE);

  // sign the amount relative to an active address filter: credits (to == addr) read as +, debits as -.
  const signFor = (tx: SignedTx): "in" | "out" | "" => {
    if (!a) return "";
    return String(tx.to ?? "").toLowerCase().includes(a) ? "in" : String(tx.from ?? "").toLowerCase().includes(a) ? "out" : "";
  };

  return (
    <Card>
      <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold">Signed event history</h3>
          <p className="text-[11px] text-faint">{TX_WINDOW} events scanned{filtered.length !== txs.length ? `, ${filtered.length} match` : ""}. Filter by kind, address, hash, or memo.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Input className="mono w-44 text-xs" placeholder="hash, address, memo" value={query} onChange={(e) => setQuery(e.target.value)} />
          <Input className="mono w-40 text-xs" placeholder="filter by address zir1..." value={addr} onChange={(e) => setAddr(e.target.value)} />
          <Select className="w-36 text-xs" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="all">All kinds</option>
            <option value="transfer">Transfers</option>
            <option value="reward">Rewards</option>
            <option value="reserve_grant">Reserve</option>
            <option value="agent_spend">Resonator spend</option>
            <option value="bond_burn">Burns</option>
          </Select>
        </div>
      </div>
      {loading && txs.length === 0 ? <LoadingState slow={slow} /> : error && txs.length === 0 ? (
        <ErrorState message={error} onRetry={load} />
      ) : filtered.length === 0 ? (
        <EmptyState title="No signed events match this view" hint={txs.length === 0 ? "Waiting for the field to seal its first events." : "Try clearing the kind, address, or search filters."} />
      ) : (
        <div>
          {/* aligned column header */}
          <div className="grid grid-cols-[5.5rem_1fr_auto] gap-2 border-b border-hairline px-1 pb-1.5 text-[10px] uppercase tracking-wide text-faint sm:grid-cols-[6rem_1fr_8rem_5rem]">
            <span>Kind</span>
            <span>Parties</span>
            <span className="text-right">Amount</span>
            <span className="hidden text-right sm:block">Time</span>
          </div>
          <div className="divide-y divide-hairline">
            {rows.map((tx) => {
              const dir = signFor(tx);
              return (
                <div key={tx.id} className="text-sm">
                  <button onClick={() => setOpen(open === tx.id ? null : tx.id)} className="grid w-full grid-cols-[5.5rem_1fr_auto] items-center gap-2 py-2 text-left sm:grid-cols-[6rem_1fr_8rem_5rem]">
                    <Badge tone={TX_TONE(tx.kind)}>{tx.kind}</Badge>
                    <span className="mono truncate text-xs text-faint">{shortAddress(tx.from || "network")} to {shortAddress(tx.to)}</span>
                    <span className={`mono text-right ${dir === "in" ? "text-[var(--teal)]" : dir === "out" ? "text-muted" : ""}`}>{dir === "in" ? "+" : dir === "out" ? "-" : ""}{formatZir(tx.amountUZIR)} ZIR</span>
                    <span className="mono hidden text-right text-[11px] text-faint sm:block">{timeAgo(tx.timestamp)}</span>
                  </button>
                  {open === tx.id && (
                    <div className="mb-2 rounded-lg border border-hairline bg-base p-2 text-[11px] text-muted space-y-0.5">
                      <div className="flex items-center gap-1">id <span className="mono break-all text-text">{tx.id}</span><CopyButton value={tx.id} label="Tx id copied" /></div>
                      <div className="flex items-center gap-1">from <span className="mono break-all text-text">{tx.from || "network (minted)"}</span>{tx.from && <CopyButton value={tx.from} label="Address copied" />}</div>
                      <div className="flex items-center gap-1">to <span className="mono break-all text-text">{tx.to}</span>{tx.to && <CopyButton value={tx.to} label="Address copied" />}</div>
                      <div>amount <span className="mono text-text">{formatZir(tx.amountUZIR)} ZIR</span>  fee <span className="mono text-text">{formatZir(tx.feeUZIR)} ZIR</span></div>
                      <div>nonce <span className="mono text-text">{tx.nonce}</span>  kind <span className="mono text-text">{tx.kind}</span></div>
                      <div>time <span className="mono text-text">{new Date(tx.timestamp).toISOString()}</span> <span className="text-faint">({timeAgo(tx.timestamp)})</span></div>
                      {tx.memo && <div>memo <span className="text-text">{tx.memo}</span></div>}
                      <div className="flex items-center gap-1">parents <span className="mono break-all text-text">{tx.parents?.length ? tx.parents.map((p) => shortHash(p)).join(", ") : "genesis or local root"}</span></div>
                      <div className="flex items-center gap-1">signature <span className="mono break-all text-text">{tx.sig ? tx.sig.slice(0, 32) + "..." : "(system minted)"}</span>{tx.sig && <CopyButton value={tx.sig} label="Signature copied" />}</div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {filtered.length > TX_PAGE_SIZE && (
        <div className="mt-3 flex items-center justify-between text-xs text-faint">
          <span className="mono">{safePage * TX_PAGE_SIZE + 1}–{Math.min(filtered.length, safePage * TX_PAGE_SIZE + TX_PAGE_SIZE)} of {filtered.length}</span>
          <div className="flex items-center gap-2">
            <Button variant="ghost" className="px-2 py-1" disabled={safePage <= 0} onClick={() => setPage(safePage - 1)}>Prev</Button>
            <span className="mono">{safePage + 1}/{pageCount}</span>
            <Button variant="ghost" className="px-2 py-1" disabled={safePage >= pageCount - 1} onClick={() => setPage(safePage + 1)}>Next</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// Look up any address: its confirmed balance and its history. The integration point for an explorer.
const ADDR_PAGE_SIZE = 10;
function AddressLookup() {
  const client = useZira((s) => s.client);
  const [q, setQ] = useState("");
  const [resolved, setResolved] = useState("");
  const [result, setResult] = useState<{ balance: number; history: SignedTx[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [histKind, setHistKind] = useState("all");
  const [histPage, setHistPage] = useState(0);
  async function lookup() {
    if (!client || !q.trim()) return;
    const target = q.trim();
    setBusy(true);
    setError("");
    setResult(null);
    setHistPage(0);
    setHistKind("all");
    try {
      // Reconcile against the shared network view (like the wallet does): pooled mining payouts and an older
      // address's history live in the gateway's fuller view, so a lookup against a lagging local node would
      // otherwise look short or empty even though the address earned for weeks.
      const [balance, history] = await Promise.all([
        client.getBalanceUZIR(target),
        loadReconciledHistory(client, target, 200, false),
      ]);
      setResolved(target);
      setResult({ balance, history });
    } catch (e) { setError(e instanceof Error ? e.message : "Could not look up that address."); } finally { setBusy(false); }
  }
  const histFiltered = (result?.history ?? []).filter((tx) => histKind === "all" || tx.kind === histKind);
  const histPageCount = Math.max(1, Math.ceil(histFiltered.length / ADDR_PAGE_SIZE));
  const histSafePage = Math.min(histPage, histPageCount - 1);
  const histRows = histFiltered.slice(histSafePage * ADDR_PAGE_SIZE, histSafePage * ADDR_PAGE_SIZE + ADDR_PAGE_SIZE);
  return (
    <Card>
      <h3 className="mb-2 text-sm font-semibold">Look up an address</h3>
      <div className="flex gap-2">
        <Input placeholder="zir1..." value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && lookup()} className="mono" />
        <Button variant="secondary" onClick={lookup} disabled={busy || !q.trim()}>{busy ? "Searching..." : "Search"}</Button>
      </div>
      {busy && <div className="mt-3"><LoadingState label="Resolving balance and history..." /></div>}
      {error && <div className="mt-2"><ErrorState message={error} onRetry={lookup} /></div>}
      {!busy && !error && !result && (
        <EmptyState title="Resolve any address" hint="Paste a zir1... address to see its confirmed balance and full signed history." />
      )}
      {result && (
        <div className="mt-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="mono text-lg text-[var(--teal)]">{formatZir(result.balance)} ZIR</div>
              <div className="mono mt-0.5 flex items-center gap-1 break-all text-[11px] text-faint">{shortAddress(resolved, 12, 8)}<CopyButton value={resolved} label="Address copied" /></div>
            </div>
            {result.history.length > 0 && (
              <Select className="w-36 text-xs" value={histKind} onChange={(e) => { setHistKind(e.target.value); setHistPage(0); }}>
                <option value="all">All kinds</option>
                <option value="transfer">Transfers</option>
                <option value="reward">Rewards</option>
                <option value="reserve_grant">Reserve</option>
                <option value="agent_spend">Resonator spend</option>
                <option value="bond_burn">Burns</option>
              </Select>
            )}
          </div>
          <div className="mt-2">
            {histFiltered.length === 0 ? <EmptyState title="No transactions match this view" hint={result.history.length === 0 ? "This address has no recorded history yet." : "Try a different kind filter."} /> : (
              <div className="divide-y divide-hairline">
                {histRows.map((tx) => {
                  const credit = String(tx.to ?? "").toLowerCase() === resolved.toLowerCase();
                  return (
                    <div key={tx.id} className="grid grid-cols-[1fr_auto] items-center gap-2 py-1.5 text-xs">
                      <span className="mono truncate text-faint"><Badge tone="neutral" className="mr-1 text-[10px]">{tx.kind}</Badge>{shortAddress(tx.from || "network")} to {shortAddress(tx.to)}</span>
                      <span className="flex items-center gap-2">
                        <span className={`mono ${credit ? "text-[var(--teal)]" : "text-muted"}`}>{credit ? "+" : "-"}{formatZir(tx.amountUZIR)} ZIR</span>
                        <span className="mono text-[10px] text-faint">{timeAgo(tx.timestamp)}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {histFiltered.length > ADDR_PAGE_SIZE && (
            <div className="mt-2 flex items-center justify-between text-xs text-faint">
              <span className="mono">{histSafePage * ADDR_PAGE_SIZE + 1}–{Math.min(histFiltered.length, histSafePage * ADDR_PAGE_SIZE + ADDR_PAGE_SIZE)} of {histFiltered.length}</span>
              <div className="flex items-center gap-2">
                <Button variant="ghost" className="px-2 py-1" disabled={histSafePage <= 0} onClick={() => setHistPage(histSafePage - 1)}>Prev</Button>
                <span className="mono">{histSafePage + 1}/{histPageCount}</span>
                <Button variant="ghost" className="px-2 py-1" disabled={histSafePage >= histPageCount - 1} onClick={() => setHistPage(histSafePage + 1)}>Next</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// Online model providers: the miners currently serving a model to the field, read live from /providers.
// These are the nodes that actually answer questions. Sorted by trust so the most credible lead.
function ProvidersPanel() {
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  const [error, setError] = useState("");
  const slow = useSlowHint(providers === null);

  const load = () => {
    NodeApi.networkProviders()
      .catch(() => NodeApi.providers())
      .then((next) => { setProviders(Array.isArray(next) ? next : []); setError(""); })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load providers."));
  };
  usePoll(load, 8000, []);

  // Dedupe by address (a node can heartbeat under more than one pubKey/session; keep its strongest entry)
  // then sort by zti with a stable address tiebreak so equal-zti providers do not reshuffle every poll.
  const deduped = Array.from(
    (providers ?? []).reduce((m, p) => {
      const prev = m.get(p.address);
      if (!prev || p.zti > prev.zti) m.set(p.address, p);
      return m;
    }, new Map<string, ProviderView>()).values(),
  );
  const rows = deduped
    .sort((a, b) => b.zti - a.zti || a.address.localeCompare(b.address))
    .slice(0, 8);

  return (
    <Card>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Serving providers</h3>
          <p className="text-[11px] text-faint">Nodes lending a model to answer the field right now.</p>
        </div>
        {providers !== null && <Badge tone={rows.length > 0 ? "teal" : "neutral"}>{deduped.length} online</Badge>}
      </div>
      {providers === null && !error ? <LoadingState slow={slow} /> : error && providers === null ? (
        <ErrorState message={error} onRetry={load} />
      ) : rows.length === 0 ? (
        <EmptyState title="No providers serving right now" hint="When a node turns on serving and loads a model, it appears here and starts answering questions for the field." />
      ) : (
        <div className="divide-y divide-hairline">
          {rows.map((p) => (
            <div key={p.pubKey} className="grid grid-cols-[1fr_auto] items-center gap-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{p.label || "Provider"}</span>
                  {p.supportsStreaming && <Badge tone="indigo" className="text-[10px]">streaming</Badge>}
                </div>
                <div className="mono truncate text-[11px] text-faint">{p.model || "model"} · {shortAddress(p.address)}</div>
              </div>
              <div className="flex items-center gap-3">
                {p.tokensPerSec > 0 && <span className="mono text-[11px] text-faint">{formatNum(p.tokensPerSec, 0)} tok/s</span>}
                <div className="w-16"><Meter value={p.zti} /></div>
                <span className="mono w-9 text-right text-[var(--teal)]">{formatNum(p.zti, 2)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// The 512 anchor seats: the network's foundational, well-routed core. Live seat assignment read from
// /anchors/seats. Earning on seats and user-owned Resonators activate in a later phase.
function AnchorsPanel() {
  const [summary, setSummary] = useState<AnchorSeatSummary | null>(null);
  const [error, setError] = useState("");
  const slow = useSlowHint(summary === null);

  const load = () => {
    NodeApi.networkAnchorSeats()
      .catch(() => NodeApi.anchorSeats())
      .then((next) => { setSummary(next); setError(""); })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load anchors."));
  };
  usePoll(load, 30000, []);

  const total = summary?.total ?? TOTAL_ANCHOR_SEATS;
  // Real seat state, matching the site + the Anchors page: every seat is owned at genesis (mostly by the
  // anchor reserve), so a raw "assigned = has an owner" reads as 512/512 and hides the truth. Instead show
  // seats HELD by a distinct owner vs those the steward has OPENED for a new early adopter to claim.
  const seats = summary?.seats ?? [];
  const held = seats.filter((a) => a.owner && a.owner !== MAINNET_ANCHOR_STEWARD).length;
  const open = seats.filter((a) => a.owner === MAINNET_ANCHOR_STEWARD && a.contributionsOpen).length;

  return (
    <Card>
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Anchor seats</h3>
          <p className="text-[11px] text-faint">{TOTAL_ANCHOR_SEATS} foundational seats form the network's trusted core.</p>
        </div>
        <Badge tone="indigo">coordination agents soon</Badge>
      </div>
      {summary === null && !error ? <LoadingState slow={slow} /> : error && summary === null ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <>
          <div className="mb-3 grid grid-cols-3 gap-2">
            <Metric label="Seats" value={String(total)} />
            <Metric label="Held" value={String(held)} tone="teal" sub="by an owner" />
            <Metric label="Open" value={String(open)} sub="to claim" />
          </div>
          <div className="space-y-1.5">
            {(summary?.classes ?? []).map((c) => (
              <div key={c.class} className="flex items-center gap-3 text-[11px]">
                <span className="w-24 shrink-0 truncate text-muted" title={c.name}>{c.name}</span>
                <div className="flex-1"><Meter value={c.total > 0 ? c.taken / c.total : 0} /></div>
                <span className="mono w-14 shrink-0 text-right text-faint">{c.taken}/{c.total}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-faint">Seats carry a class, a routing weight, and a ZIR allocation that vests over one year. Seat earning turns on in a later phase.</p>
        </>
      )}
    </Card>
  );
}


