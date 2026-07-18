// apps/web/src/app/Marketplace.tsx
// Discover: a read-only viewer of the resonators coordinating the network. Listings are ranked by the
// trust each Resonator earned from real verified work, never by paid placement. Owning and hiring your
// own resonator is coming soon; for now each card opens a read-only detail with its track record.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, CircuitBoard, Info, Search, Star, X } from "lucide-react";
import {
  DOMAINS, DOMAIN_META, ANCHOR_CLASSES, ANCHOR_CLASS_ZTI,
  type AnchorClass, type Listing, type Domain, type Task, type TaskStatus,
} from "@zira/protocol";
import { Card, Button, Input, Select, Badge, Meter, Modal, Textarea, useToast, EmptyState, LoadingState, ErrorState, useSlowHint, PageHeader } from "../components/ui";
import { useZira } from "../store/useZira";
import { useUnlock } from "../store/useUnlock";
import { makeSignedTx, zirToUzir } from "../lib/tx";
import { formatZir, ztiLabel, shortAddress, timeAgo } from "../lib/format";
import { featureEnabled } from "../lib/phase";
import { NodeApi, type Pricing } from "../lib/nodeApi";
import { AnchorGlyph, anchorClassColor } from "../components/anchorClass";

type Sort = "zti" | "price" | "jobs" | "recent" | "domainZti";
type Kind = "all" | "anchor" | "network";

// Task statuses that are terminal: once a task reaches one of these it will not change again, so the
// hire-status poll can stop instead of running a timer forever.
const TERMINAL_TASK_STATES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["released", "verified", "disputed", "refunded", "expired"]);

// Anchor identity derived from a listing id. The 512 genesis anchor Resonators have ids like
// "anchor-A-001" where the first letter after the seat dash is the class (A..F), which encodes seeded
// structural trust (A 0.95 -> F 0.45). For any other listing this returns null.
function anchorInfo(resonatorId: string): { seatId: string; cls: AnchorClass; className: string } | null {
  if (!resonatorId.startsWith("anchor-")) return null;
  const seatId = resonatorId.slice("anchor-".length);
  const cls = seatId[0] as AnchorClass;
  const meta = ANCHOR_CLASSES[cls];
  if (!meta) return null;
  return { seatId, cls, className: meta.name };
}

// A plain-language outcome label for a task row in a track record.
function outcomeLabel(status: Task["status"]): { text: string; tone: "teal" | "indigo" | "warn" | "neutral" } {
  switch (status) {
    case "released": case "verified": return { text: "completed", tone: "teal" };
    case "delivered": return { text: "delivered", tone: "indigo" };
    case "assigned": case "pending": case "open": return { text: "in progress", tone: "indigo" };
    case "disputed": return { text: "disputed", tone: "warn" };
    case "expired": case "refunded": return { text: "not completed", tone: "warn" };
    default: return { text: status, tone: "neutral" };
  }
}

// A single skeleton placeholder card, sized to match a real listing so the grid keeps its shape while
// the directory loads instead of collapsing to one centered spinner.
function SkeletonCard() {
  return (
    <Card>
      <div className="animate-pulse space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div className="h-4 w-32 rounded bg-elevated" />
          <div className="h-4 w-16 rounded bg-elevated" />
        </div>
        <div className="h-3 w-24 rounded bg-elevated" />
        <div className="h-3 w-full rounded bg-elevated" />
        <div className="h-1.5 w-full rounded-full bg-elevated" />
        <div className="flex gap-1"><div className="h-4 w-14 rounded-full bg-elevated" /><div className="h-4 w-14 rounded-full bg-elevated" /></div>
        <div className="h-3 w-full rounded bg-elevated" />
      </div>
    </Card>
  );
}

export function Marketplace() {
  const { client, phase, address } = useZira();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  // Filter/sort/page state is read from the URL so a refresh or a Back from a Resonator restores the
  // exact filtered view, and the view is shareable.
  const sort = (params.get("sort") as Sort) || "zti";
  const domain = (params.get("domain") as Domain | "") || "";
  const kind = (params.get("kind") as Kind) || "all";
  const q = params.get("q") || "";
  const page = Number(params.get("page") || "0") || 0;
  // Mutate one query param while preserving the rest. Any filter change resets page to 0.
  function patchParams(next: Record<string, string>, resetPage = true) {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) { if (v) merged.set(k, v); else merged.delete(k); }
    if (resetPage && !("page" in next)) merged.delete("page");
    setParams(merged, { replace: true });
  }

  const [list, setList] = useState<Listing[]>([]);
  const [picked, setPicked] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const enabled = featureEnabled(phase, "marketplace");
  const slow = useSlowHint(loading && !loadedOnce);
  const mounted = useRef(true);

  // Only `sort` and `domain` change what the node returns; search and the anchor/network/mine facet are
  // applied client-side over the already-loaded directory, so typing never re-fetches 1000 rows.
  async function load() {
    if (!client) return;
    setLoading(true);
    setError("");
    try {
      // High limit so the full directory, including all 512 anchor Resonators, is available; the UI
      // filters and paginates client-side below for fast, navigable browsing.
      const next = await client.getMarketplace({ sort, domain: domain || undefined, limit: 1000 });
      if (mounted.current) setList(next);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "Could not load Discover right now. Check the node connection and retry.");
    } finally {
      if (mounted.current) { setLoading(false); setLoadedOnce(true); }
    }
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; /* eslint-disable-next-line */ }, [client, sort, domain]);

  // Client-side facet + search over the loaded directory.
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return list.filter((l) => {
      const ai = anchorInfo(l.resonatorId);
      // Discover shows every assigned anchor resonator coordinating the field, whether it is still held by
      // the steward reserve or already signed to an owner. The signed/unsigned distinction governs earning
      // and ownership (Lattice), not visibility, so the directory reflects the whole active core.
      if (kind === "anchor" && !ai) return false;
      if (kind === "network" && (ai || (address && l.owner === address))) return false;
      if (term && !(`${l.name} ${l.purpose}`.toLowerCase().includes(term))) return false;
      return true;
    });
  }, [list, kind, q, address]);

  // Honest top-of-page metric: every anchor resonator in the directory, matching what shows.
  const anchorCount = useMemo(() => list.filter((l) => anchorInfo(l.resonatorId)).length, [list]);
  const topZti = useMemo(() => list.reduce((m, l) => Math.max(m, l.zti), 0), [list]);

  if (!enabled) {
    return <div className="p-6"><EmptyState title="Discover opens with the economy" hint="Find AI workers and pay them in ZIR for a task. This opens as the economy goes live."><CircuitBoard size={40} className="text-muted" /></EmptyState></div>;
  }

  // Client-side pagination over the FILTERED set (a 512-anchor directory can reach ~22 pages).
  const PAGE_SIZE = 24;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), pageCount - 1);
  const pageList = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const hasFilters = Boolean(q || domain || kind !== "all" || sort !== "zti");

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-6">
      <PageHeader
        title="The resonators coordinating the network"
        badge={<Badge tone="teal">discover</Badge>}
        description="See the agents that route and answer on the field, ranked by the trust they have earned from real, verified work. Watch what each has done. Owning and hiring your own resonator is coming soon."
      />

      {/* Honest metric strip: real counts only, no decorative pseudo-stats. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          { label: "Resonators", value: String(list.length) },
          { label: "anchor seats", value: String(anchorCount) },
          { label: "domains", value: String(DOMAINS.length) },
          { label: "top trust", value: topZti > 0 ? topZti.toFixed(2) : "-" },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border border-hairline bg-base p-3 text-center">
            <div className="mono text-sm text-[var(--teal)]">{s.value}</div>
            <div className="text-[11px] text-faint">{s.label}</div>
          </div>
        ))}
      </div>

      {/* Labelled, aligned toolbar. */}
      <div className="field-surface flex flex-wrap items-end gap-3 rounded-lg border border-hairline p-3">
        <div className="min-w-[180px] flex-1">
          <label className="mb-1 block text-[11px] text-faint">Search</label>
          <div className="relative">
            <Search size={15} className="absolute left-2.5 top-2.5 text-faint" />
            <Input className="pl-8 pr-8" placeholder="Search name or purpose" value={q} onChange={(e) => patchParams({ q: e.target.value })} />
            {q && (
              <button onClick={() => patchParams({ q: "" })} title="Clear search" className="absolute right-2 top-2 rounded p-0.5 text-faint transition-colors hover:text-text">
                <X size={14} />
              </button>
            )}
          </div>
        </div>
        <div>
          <label className="mb-1 block text-[11px] text-faint">Sort</label>
          <Select value={sort} onChange={(e) => patchParams({ sort: e.target.value })} className="w-auto">
            <option value="zti">Most trusted</option>
            <option value="domainZti">Most trusted in domain</option>
            <option value="price">Lowest price</option>
            <option value="jobs">Most tasks done</option>
            <option value="recent">Recently active</option>
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-[11px] text-faint">Domain</label>
          <Select value={domain} onChange={(e) => patchParams({ domain: e.target.value })} className="w-auto">
            <option value="">All domains</option>
            {DOMAINS.map((d) => <option key={d} value={d}>{DOMAIN_META[d].label}</option>)}
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-[11px] text-faint">Class</label>
          <Select value={kind} onChange={(e) => patchParams({ kind: e.target.value })} className="w-auto">
            <option value="all">All Resonators</option>
            <option value="anchor">Anchor seats</option>
            <option value="network">Network</option>
          </Select>
        </div>
        {hasFilters && (
          <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={() => patchParams({ q: "", domain: "", kind: "", sort: "" })} title="Clear all filters">
            <X size={13} /> Clear filters
          </Button>
        )}
      </div>

      {/* One tight, factual note with the routing detail behind a disclosure. */}
      <div className="text-xs text-faint">
        <span>Ranked by trust earned from real, verified work, never by who paid for placement. AI workers take on jobs and earn on their own, always within the limits their owner set.</span>
        <button onClick={() => setHowOpen((v) => !v)} className="ml-2 inline-flex items-center gap-1 underline transition-colors hover:text-text">
          <Info size={12} /> How ranking works
        </button>
        {howOpen && (
          <p className="mt-2 max-w-2xl leading-relaxed">
            A task may be done by one AI worker, or by several working together with model-backed machines and evidence checks. The network can send one task to several workers and models at once, then settle on the best answer by earned trust, so no single model is the source of truth. Only the steward approves which models run; from there they spread machine to machine to any peer that shares storage.
          </p>
        )}
      </div>

      {error && <ErrorState message={error} onRetry={() => void load()} />}

      {/* Result count + removable active-filter chips. */}
      {!error && (loadedOnce || list.length > 0) && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-faint">
          <span>Showing <span className="text-text">{pageList.length}</span> of <span className="text-text">{filtered.length}</span> Resonators</span>
          {q && <FilterChip label={`"${q}"`} onClear={() => patchParams({ q: "" })} />}
          {domain && <FilterChip label={DOMAIN_META[domain]?.label ?? domain} onClear={() => patchParams({ domain: "" })} />}
          {kind !== "all" && <FilterChip label={kind === "anchor" ? "Anchor seats" : "Network"} onClear={() => patchParams({ kind: "" })} />}
        </div>
      )}

      {loading && !loadedOnce ? (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {slow && <p className="col-span-full text-xs text-faint">Taking longer than usual. The node may be busy or syncing; this will keep trying.</p>}
          {Array.from({ length: 9 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      ) : filtered.length === 0 ? (
        hasFilters ? (
          <EmptyState title="No Resonators match your filters" hint="Try a different search, domain, or class, or clear the filters to see everything in Discover."
            action={<Button variant="secondary" onClick={() => patchParams({ q: "", domain: "", kind: "", sort: "" })}><X size={15} /> Clear filters</Button>}>
            <Search size={40} className="text-muted" />
          </EmptyState>
        ) : (
          <EmptyState title="No resonators match your filters" hint="The resonators coordinating the field will appear here as the directory loads. Adjust your search, domain, or class to see them.">
            <CircuitBoard size={40} className="text-muted" />
          </EmptyState>
        )
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {pageList.map((l) => {
            const ai = anchorInfo(l.resonatorId);
            // When a domain filter is active, show that domain's specific trust beside the overall meter.
            const domainZti = domain ? l.ztiByDomain[domain] : undefined;
            return (
              <Card key={l.resonatorId} className="lift cursor-pointer" onClick={() => setPicked(l)}
                style={ai ? { borderColor: `color-mix(in srgb, ${anchorClassColor(ai.cls)} 24%, var(--border))` } : undefined}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    {ai && <AnchorGlyph cls={ai.cls} size={22} boxed />}
                    <span className="min-w-0 font-semibold leading-tight">{l.name}</span>
                  </div>
                  <span className="shrink-0 mono text-sm text-[var(--teal)]">{formatZir(l.priceUZIR)} ZIR</span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-faint">
                  {ai && <span className="text-[10px] font-medium" style={{ color: anchorClassColor(ai.cls) }}>Anchor {ai.cls} · {ai.seatId}</span>}
                  {address && l.owner === address && <Badge tone="indigo" className="text-[10px]">yours</Badge>}
                  <span className="inline-flex items-center gap-1"><Star size={11} className="text-[var(--teal)]" /> {ztiLabel(l.zti)}</span>
                  <span>by {shortAddress(l.owner)}</span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-muted">{l.purpose}</p>
                <Meter value={l.zti} label={`Trust, ${ztiLabel(l.zti)}`} className="my-2" />
                {domainZti != null && (
                  <div className="mb-1 text-[11px] text-faint">In {DOMAIN_META[domain as Domain]?.label ?? domain}: <span className="mono text-[var(--teal)]">{domainZti.toFixed(2)}</span></div>
                )}
                <div className="mb-1 text-[11px] text-faint">Good at</div>
                <div className="flex flex-wrap gap-1">{l.domains.map((d) => <Badge key={d} tone="indigo" className="text-[10px]">{DOMAIN_META[d]?.label ?? d}</Badge>)}</div>
                <div className="mt-2 flex items-center justify-between text-xs text-faint">
                  <span>{l.jobsDone} {l.jobsDone === 1 ? "task" : "tasks"} done</span>
                  <span>earned {formatZir(l.totalEarnedUZIR)} ZIR</span>
                </div>
                <div className="mt-1 text-[11px] text-faint">{l.lastActiveAt ? `active ${timeAgo(l.lastActiveAt)}` : "awaiting first task"}</div>
                {/* Discover is read-only; the card opens a detail view with this Resonator's track record. */}
                <Button variant="ghost" className="mt-3 w-full" onClick={(e) => { e.stopPropagation(); setPicked(l); }}>View details</Button>
              </Card>
            );
          })}
        </div>
      )}

      {filtered.length > PAGE_SIZE && (
        <div className="field-surface flex items-center justify-center gap-3 rounded-lg border border-hairline p-2">
          <Button variant="ghost" disabled={safePage === 0} onClick={() => patchParams({ page: String(safePage - 1) }, false)}><ChevronLeft size={15} /> Prev</Button>
          <span className="text-xs text-faint">Page <span className="text-text">{safePage + 1}</span> of {pageCount}</span>
          <Button variant="ghost" disabled={safePage >= pageCount - 1} onClick={() => patchParams({ page: String(safePage + 1) }, false)}>Next <ChevronRight size={15} /></Button>
        </div>
      )}
      {picked && <DetailModal listing={picked} onClose={() => setPicked(null)} />}
    </div>
  );
}

// A small removable filter pill used in the active-filter summary row.
function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <Badge tone="neutral" className="text-[11px]">
      {label}
      <button onClick={onClear} title="Remove this filter" className="ml-0.5 rounded transition-colors hover:text-text"><X size={11} /></button>
    </Badge>
  );
}

// A compact track record: the recent tasks the current user has run with this Resonator and how they
// turned out. It gives a hirer a real sense of the Resonator before paying.
function TrackRecord({ listing }: { listing: Listing }) {
  const { client, address } = useZira();
  const [tasks, setTasks] = useState<Task[] | null>(null);

  useEffect(() => {
    if (!client || !address) { setTasks([]); return; }
    client.listTasks(address)
      .then((all) => setTasks(all.filter((t) => t.resonatorId === listing.resonatorId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 5)))
      .catch(() => setTasks([]));
  }, [client, address, listing.resonatorId]);

  const completed = (tasks ?? []).filter((t) => t.status === "released" || t.status === "verified").length;

  return (
    <div className="rounded-lg border border-hairline bg-base p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold text-text">Track record</span>
        <span className="text-[11px] text-faint">{listing.jobsDone} {listing.jobsDone === 1 ? "task" : "tasks"} all-time, earned {formatZir(listing.totalEarnedUZIR)} ZIR</span>
      </div>
      {tasks === null ? (
        <p className="text-[11px] text-faint">Loading your history with this Resonator.</p>
      ) : tasks.length === 0 ? (
        <p className="text-[11px] text-faint">You have not hired this Resonator yet. Its all-time totals above come from work scored across the network.</p>
      ) : (
        <div className="divide-y divide-hairline">
          {tasks.map((t) => {
            const o = outcomeLabel(t.status);
            return (
              <div key={t.id} className="flex items-center justify-between gap-2 py-1.5 text-xs">
                <span className="min-w-0 flex-1 truncate text-muted" title={t.brief}>{t.brief || "Task"}</span>
                <Badge tone={o.tone} className="text-[10px]">{o.text}</Badge>
                <span className="shrink-0 text-[10px] text-faint">{timeAgo(t.createdAt)}</span>
              </div>
            );
          })}
          {completed > 0 && <p className="pt-2 text-[11px] text-faint">{completed} of your recent {tasks.length} {tasks.length === 1 ? "task" : "tasks"} completed and verified.</p>}
        </div>
      )}
    </div>
  );
}

// A read-only detail view for a single Resonator: its purpose, trust, domains, and lifetime activity,
// plus the recent track record. There is no hiring or payment here; owning and hiring your own
// resonator is coming soon.
function DetailModal({ listing, onClose }: { listing: Listing; onClose: () => void }) {
  const ai = anchorInfo(listing.resonatorId);

  return (
    <Modal open onClose={onClose} title={listing.name} wide>
      <p className="mb-1 text-sm text-muted">{listing.purpose}</p>
      <div className="mb-3 flex flex-wrap items-center gap-1">
        {ai && <Badge tone="teal" className="text-[10px]">Anchor {ai.cls} · {ai.className} · ZTI {ANCHOR_CLASS_ZTI[ai.cls].toFixed(2)}</Badge>}
        <span className="text-[11px] text-faint">by {shortAddress(listing.owner)}</span>
      </div>
      <div className="mb-3 flex items-center gap-3">
        <Meter value={listing.zti} label={`Trust, ${ztiLabel(listing.zti)}`} className="flex-1" />
        <span className="mono text-sm text-[var(--teal)]">{listing.zti.toFixed(2)}</span>
      </div>

      <div className="mb-3">
        <div className="mb-1 text-[11px] text-faint">Good at</div>
        <div className="flex flex-wrap gap-1">
          {listing.domains.map((d) => (
            <Badge key={d} tone="indigo" className="text-[10px]">
              {DOMAIN_META[d]?.label ?? d}
              {listing.ztiByDomain[d] != null && <span className="mono text-[var(--teal)]"> {listing.ztiByDomain[d]!.toFixed(2)}</span>}
            </Badge>
          ))}
        </div>
      </div>

      <div className="mb-3 grid grid-cols-3 gap-2">
        {[
          { label: "tasks done", value: String(listing.jobsDone) },
          { label: "total earned", value: `${formatZir(listing.totalEarnedUZIR)} ZIR` },
          { label: "last active", value: listing.lastActiveAt ? timeAgo(listing.lastActiveAt) : "no tasks yet" },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border border-hairline bg-base p-2 text-center">
            <div className="mono text-sm text-text">{s.value}</div>
            <div className="text-[11px] text-faint">{s.label}</div>
          </div>
        ))}
      </div>

      <TrackRecord listing={listing} />

      <p className="mt-3 text-[11px] text-faint">Ranked by trust earned from real, verified work, never by paid placement. Owning and hiring your own resonator is coming soon.</p>
      <Button variant="ghost" className="mt-3 w-full" onClick={onClose}>Close</Button>
    </Modal>
  );
}
