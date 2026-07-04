// apps/console/src/app/Explorer.tsx
// The public RPC surface: network health, supply audit, signed event history, address lookup,
// recent Locks, and field convergence, the explorer/exchange-integration view.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Copy, ChevronDown, ChevronRight } from "lucide-react";
import { PROTOCOL, type Lock, type SignedTx, type FieldNode } from "@zira/protocol";
import {
  Card, Badge, Meter, Select, Button, Input, PageHeader,
  EmptyState, LoadingState, ErrorState, useSlowHint, usePoll, useToast,
} from "../components/ui";
import { useZira } from "../store/useZira";
import { formatNum, formatZir, shortAddress, shortHash, timeAgo } from "../lib/format";
import { NodeApi, type ExtendedStats, type SupplyInfo } from "../lib/nodeApi";

// The field converges on multi-LLM coordination subjects, not hardware or commodity prices. These are
// the resonant values that matter for a distributed assistant: how strongly models agree, how confident
// the coordinated answer is, and how well the field performs per inference domain.
const SUBJECTS = ["ANSWER_QUALITY", "COORDINATION_CONFIDENCE", "MODEL_AGREEMENT", "REASONING_DOMAIN"];

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
  const { client, locks, events, mode } = useZira();
  const [values, setValues] = useState<Record<string, Lock | null>>({});

  useEffect(() => {
    if (!client) return;
    const load = async () => {
      try {
        const entries = await Promise.all(SUBJECTS.map(async (s) => [s, await client.getResonantValue(s).catch(() => null)] as const));
        setValues(Object.fromEntries(entries));
      } catch { /* ticker is best-effort */ }
    };
    void load();
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [client]);

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-6">
      <PageHeader
        title="Explorer"
        badge={<Badge tone="teal">live</Badge>}
        description="Trace the whole network, from day one to now. Every transfer, reward, answer, and agreement is a signed record. This is the same public data an exchange or indexer reads."
      />
      <NetworkAndSupply showHealth={mode === "node"} />
      <ValueTicker values={values} />
      <AddressLookup />
      <TxExplorer />
      <div className="grid gap-4 lg:grid-cols-2">
        <FieldConvergence />
        <EventWeb events={events} />
      </div>
      <LockFeed locks={locks} />
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
    Promise.all([NodeApi.stats(), NodeApi.supply()])
      .then(([nextStats, nextSupply]) => { setStats(nextStats); setSupply(nextSupply); setError(""); setUpdatedAt(Date.now()); })
      .catch((e) => setError(e instanceof Error ? e.message : "Could not reach the node RPC."))
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
          <p className="text-[11px] text-faint">ZIR exposes signed history, balances, supply audit, state roots, and peer health through the RPC an exchange or public indexer needs.</p>
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
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  // address filter: show only events touching this address (as sender or recipient).
  const [addr, setAddr] = useState("");
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
      const [balance, history] = await Promise.all([client.getBalanceUZIR(target), client.getTxHistory(target, 200)]);
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

function ValueTicker({ values }: { values: Record<string, Lock | null> }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {SUBJECTS.map((s) => {
        const v = values[s];
        return (
          <Card key={s} className="py-3">
            <div className="text-xs text-faint">{s}</div>
            <div className="mono text-lg text-text">{v ? formatNum(v.resonantValue, 4) : "."}</div>
            {v && <div className="text-[11px] text-faint">cv {formatNum(v.cv, 3)}, {v.domain}</div>}
          </Card>
        );
      })}
    </div>
  );
}

function LockFeed({ locks }: { locks: Lock[] }) {
  return (
    <Card>
      <h3 className="mb-2 text-sm font-semibold">Recent Locks</h3>
      {locks.length === 0 ? (
        <EmptyState title="No Locks yet" hint="As signed observations arrive, the field seals trust-weighted agreements here." />
      ) : (
        <div className="divide-y divide-hairline">
          {locks.map((l) => (
            <div key={l.id} className="flex items-center justify-between py-2 text-sm">
              <div>
                <span className="font-medium">{l.subject}</span> <Badge tone="indigo" className="ml-1 text-[10px]">{l.domain}</Badge>
                <div className="text-[11px] text-faint">cv {formatNum(l.cv, 3)}, {l.observationCount} obs, {timeAgo(l.sealedAt)}</div>
              </div>
              <div className="flex items-center gap-3">
                <div className="w-20"><Meter value={l.supportingTrust} /></div>
                <span className="mono text-[var(--teal)]">{formatNum(l.resonantValue, 4)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function EventWeb({ events }: { events: SignedTx[] }) {
  const recent = events.slice(0, 60);
  return (
    <Card>
      <h3 className="mb-2 text-sm font-semibold">The Living Web</h3>
      <svg viewBox="0 0 400 200" className="w-full" style={{ minHeight: 160 }}>
        {recent.map((e, i) => {
          const x = 20 + (i % 20) * 19;
          const y = 30 + Math.floor(i / 20) * 55 + (i % 2) * 12;
          return (
            <g key={e.id}>
              {i > 0 && <line x1={x} y1={y} x2={20 + ((i - 1) % 20) * 19} y2={30 + Math.floor((i - 1) / 20) * 55 + ((i - 1) % 2) * 12} stroke="var(--border)" strokeWidth="0.5" />}
              <circle cx={x} cy={y} r={4} fill="var(--accent)" opacity={1 - i / 80}>
                <title>{shortHash(e.id)}</title>
              </circle>
            </g>
          );
        })}
      </svg>
      <p className="text-[11px] text-faint">{recent.length} recent signed events, each pointing back into the web. No blocks, no block race.</p>
    </Card>
  );
}

function FieldConvergence() {
  const { client } = useZira();
  const [subject, setSubject] = useState(SUBJECTS[0]!);
  const [nodes, setNodes] = useState<FieldNode[]>([]);
  const [lock, setLock] = useState<Lock | null>(null);
  const [paused, setPaused] = useState(false);
  const estimatesRef = useRef<Record<string, number>>({});
  const [, force] = useState(0);

  useEffect(() => {
    if (!client) return;
    const load = async () => {
      if (paused) return;
      const [ns, lk] = await Promise.all([client.getFieldNodes(subject), client.getResonantValue(subject)]);
      setNodes(ns); setLock(lk);
    };
    void load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [client, subject, paused]);

  // Only nodes with a REAL signed estimate are plotted, no fabricated values. This is an explorer:
  // synthetic readings would undermine the verifiable-event-web claim.
  const readings = nodes.filter((n) => n.estimate != null);

  // animate the real estimates smoothly toward the resonant value (no random seeding).
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const target = lock?.resonantValue ?? 1;
      readings.forEach((n) => {
        const key = n.pubKey;
        const cur = estimatesRef.current[key] ?? (n.estimate as number);
        estimatesRef.current[key] = cur + (target - cur) * 0.05 * (1 - 0.7 * n.zti);
      });
      force((x) => x + 1);
      raf = requestAnimationFrame(tick);
    };
    if (!paused && readings.length > 0) raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [readings, lock, paused]);

  const target = lock?.resonantValue ?? 1;
  const vals = readings.map((n) => estimatesRef.current[n.pubKey] ?? (n.estimate as number));
  const min = Math.min(target * 0.9, ...vals, target);
  const max = Math.max(target * 1.1, ...vals, target);
  const scale = (v: number) => max === min ? 100 : 20 + ((v - min) / (max - min)) * 360;
  // how many readings have pulled within the convergence band around the locked value
  const band = Math.abs(target) * 0.02 || 0.02;
  const withinBand = readings.filter((n) => Math.abs((estimatesRef.current[n.pubKey] ?? (n.estimate as number)) - target) <= band).length;

  return (
    <Card>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Field convergence</h3>
        <div className="flex items-center gap-2">
          <Select value={subject} onChange={(e) => setSubject(e.target.value)} className="w-auto text-xs">
            {SUBJECTS.map((s) => <option key={s} value={s}>{s}</option>)}
          </Select>
          <Button variant="ghost" onClick={() => setPaused((p) => !p)}>{paused ? "Play" : "Pause"}</Button>
        </div>
      </div>
      {readings.length === 0 ? (
        <EmptyState title="No live readings yet" hint="No node has published a signed estimate for this subject. Readings appear here as the field reports them." />
      ) : (
        <>
          <svg viewBox="0 0 400 140" className="w-full" style={{ minHeight: 130 }}>
            <line x1={scale(target)} y1="10" x2={scale(target)} y2="130" stroke="var(--teal)" strokeWidth="1.5" opacity="0.8" />
            {readings.map((n, i) => {
              const v = estimatesRef.current[n.pubKey] ?? (n.estimate as number);
              return <circle key={n.pubKey} cx={scale(v)} cy={25 + (i % 8) * 13} r={3 + n.zti * 5} fill="url(#hf-cell)" opacity={0.5 + n.zti * 0.5}><title>{shortAddress(n.pubKey)} ZTI {formatNum(n.zti, 2)}</title></circle>;
            })}
            <defs>
              <linearGradient id="hf-cell" x1="0" y1="0" x2="400" y2="140" gradientUnits="userSpaceOnUse">
                <stop offset="0" stopColor="var(--accent)" /><stop offset="0.5" stopColor="var(--accent)" /><stop offset="1" stopColor="var(--violet)" />
              </linearGradient>
            </defs>
          </svg>
          <p className="text-[11px] text-faint">{readings.length} live reading{readings.length === 1 ? "" : "s"}, {withinBand} within the convergence band. {lock && `Locked at ${formatNum(lock.resonantValue, 4)}, cv ${formatNum(lock.cv, 3)}.`}</p>
        </>
      )}
    </Card>
  );
}
