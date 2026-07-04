// apps/web/src/app/Founder.tsx
// The gated stewardship tool for public reserve allocations and launch-authority actions.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Anchor as AnchorIcon, Bot, CalendarClock, Crown, Download, Network as NetIcon, ShieldCheck, TrendingDown, XCircle, Gift, AlertTriangle, Sparkles, Coins, Search } from "lucide-react";
import {
  isValidAddress, EMISSION, epochReward, PROTOCOL, canonical,
  reserveDistributionSlots, dueReserveDistributionSlots,
  type SignedTx, type NetworkStats, type ReserveDistributionPlan,
  type ReserveDistributionSent, type ReserveDistributionCadence, type Anchor,
} from "@zira/protocol";
import type { StewardKind } from "../store/useZira";
import { Card, Button, Input, Badge, useToast, EmptyState, Field, Select, Textarea, Modal, LoadingState, ErrorState, useSlowHint, usePoll, PageHeader } from "../components/ui";
import { useZira } from "../store/useZira";
import { useUnlock } from "../store/useUnlock";
import { makeSignedTx, zirToUzir } from "../lib/tx";
import { Wallet } from "../lib/keys";
import { formatZir, shortAddress, timeAgo } from "../lib/format";
import { NodeApi, type BootstrapSeedCandidate, type EventsStatus, type Treasury } from "../lib/nodeApi";

// ---- Local presentation helpers (kept in this file per the section's edit scope) ----

// A consistent metric tile so every stat across the steward surface shares the same label/value rhythm.
function Stat({ label, value, hint, tone = "text" }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: "text" | "teal" | "warn" | "indigo" }) {
  const valueColor = tone === "teal" ? "text-[var(--teal)]" : tone === "warn" ? "text-[var(--warn)]" : tone === "indigo" ? "text-[var(--accent)]" : "text-text";
  return (
    <div className="rounded-lg border border-hairline bg-base p-2.5">
      <div className="text-[11px] uppercase tracking-wide text-faint">{label}</div>
      <div className={`mono mt-0.5 text-sm ${valueColor}`}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-faint">{hint}</div>}
    </div>
  );
}

// A subtle section divider so the 17 control cards group into scannable tiers under the PageHeader.
function SectionHead({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5 pt-1">
      <div className="flex items-center gap-2">
        {icon}
        <h2 className="text-xs font-semibold uppercase tracking-widest text-faint">{title}</h2>
      </div>
      {hint && <p className="text-[11px] text-faint">{hint}</p>}
    </div>
  );
}

// Render a code-like token in mono without leaking literal backticks into user-facing copy.
function Mono({ children }: { children: ReactNode }) {
  return <span className="mono text-text">{children}</span>;
}

// A short "in Nh / in Nd" forward-looking relative time for scheduled, not-yet-due events.
function relFuture(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return "now";
  const m = Math.floor(diff / 60000);
  if (m < 60) return `in ${Math.max(1, m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h`;
  return `in ${Math.floor(h / 24)}d`;
}

// A small confirmation gate for irreversible, signed, public actions. The body echoes the exact effect
// before the steward commits; Confirm runs the supplied action and closes on success.
function ConfirmModal({ open, onClose, onConfirm, title, confirmLabel = "Confirm", danger, busy, children }: {
  open: boolean; onClose: () => void; onConfirm: () => void | Promise<void>;
  title: string; confirmLabel?: string; danger?: boolean; busy?: boolean; children: ReactNode;
}) {
  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="space-y-3 text-sm text-muted">{children}</div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant={danger ? "danger" : "primary"} onClick={() => void onConfirm()} disabled={busy}>{confirmLabel}</Button>
      </div>
    </Modal>
  );
}

export function Founder() {
  const { client, address, network, isFounder, isStewardWallet, stewardKind, stewardActionsGated, stats } = useZira();
  const toast = useToast();
  const [grants, setGrants] = useState<SignedTx[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [grantQuery, setGrantQuery] = useState("");
  const slow = useSlowHint(!loaded);

  async function load() {
    if (!client) { setLoaded(true); return; }
    try { setGrants(await client.getReserveGrants(100)); setErr(null); }
    catch (e) { setErr(e instanceof Error ? e.message : "Could not load reserve allocations from this node."); }
    finally { setLoaded(true); }
  }
  useEffect(() => { void load(); /* eslint-disable-next-line */ }, [client]);

  // The steward surface shows whenever the active wallet is an active founder OR a well-known steward
  // wallet (anchor-reserve / founder), even when the running node does not hold that steward key. In the
  // latter case actions would 403, so the panel is shown read-only with an inline note.
  if (!isFounder && !isStewardWallet) {
    return <div className="p-6"><EmptyState title="Steward tools" hint="These controls appear for the launch-authority and steward wallets. Load a steward wallet on the Wallet page, or delegate another ZIR address from a steward node."><Crown size={40} className="text-[var(--warn)]" /></EmptyState></div>;
  }

  const totalGranted = grants.reduce((a, g) => a + (g.amountUZIR ?? 0), 0);
  const reserveTotal = stats?.reserveUZIR ?? 0;
  const reserveRemaining = Math.max(0, reserveTotal - totalGranted);
  const filteredGrants = grants.filter((g) => {
    if (!grantQuery.trim()) return true;
    const q = grantQuery.trim().toLowerCase();
    const reason = (g as SignedTx & { reason?: string }).reason ?? g.memo ?? "";
    return g.to.toLowerCase().includes(q) || reason.toLowerCase().includes(q);
  });

  return (
    <div className="mx-auto max-w-6xl space-y-5 p-6">
      <PageHeader
        title="Steward"
        description="Launch-authority and reserve operations for the genesis network."
        badge={<Badge tone={stewardActionsGated ? "warn" : "teal"}>{stewardActionsGated ? "read-only" : "active"}</Badge>}
        action={<Button variant="secondary" onClick={() => void load()}>Refresh</Button>}
      />

      <StewardGatingNote gated={stewardActionsGated} kind={stewardKind} address={address} />

      <SectionHead icon={<AnchorIcon size={14} className="text-[var(--teal)]" />} title="Anchor event & contributions" />
      <AnchorEventControl />
      <AnchorContributionsCard />
      <EventsControl />

      <SectionHead icon={<Crown size={14} className="text-[var(--warn)]" />} title="Treasury & reserve" />
      <Card>
        <div className="flex items-center gap-2"><Crown size={18} className="text-[var(--warn)]" /><h2 className="text-lg font-semibold">Launch reserve</h2></div>
        <p className="mt-1 text-xs text-muted">The genesis reserve (41% of supply) is pre-allocated transparently and recorded on the public ledger from block 0: 30% to the anchor reserve, a steward-administered wallet released to anchor seat owners as their seats are assigned; 10% to the ecosystem and events reserve for airdrops and grants; and 1% to steward operations. Distribution from the steward operational slice runs through the scheduled reserve distribution below. The anchor reserve is held for the seat owners, and the events reserve is distributed through the events claim. Import an active stewardship wallet only when you need to sign.</p>
        <div className="mt-3 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          <Stat label="Network genesis reserve" value={`${formatZir(reserveTotal)} ZIR`} hint="anchors 30% · events 10% · steward ops 1%" tone="teal" />
          <Stat label="Allocated (latest 100 grants)" value={`${formatZir(totalGranted)} ZIR`} hint={`${grants.length} grant${grants.length === 1 ? "" : "s"} shown`} />
          <Stat label="Reserve remaining" value={`${formatZir(reserveRemaining)} ZIR`} hint="reserve − allocated (this view)" />
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <TreasuryCard />
        <FounderSecurityCard />
        <EmissionCard stats={stats} />
        <FounderResonatorReadiness />
      </div>

      <SectionHead icon={<AnchorIcon size={14} className="text-[var(--teal)]" />} title="Anchor positions" />
      <StewardPositionTransferCard />
      <StewardResonatorSeedCard gated={stewardActionsGated} />
      <StewardSettleCard gated={stewardActionsGated} />

      <SectionHead icon={<NetIcon size={14} className="text-[var(--teal)]" />} title="Network & field" />
      <div className="grid gap-5 lg:grid-cols-2">
        <FounderBackupCard />
        <FounderModelFieldCard />
      </div>
      <FounderBootstrapRegistryCard network={network} />

      <SectionHead icon={<CalendarClock size={14} className="text-[var(--teal)]" />} title="Scheduled distribution" />
      <ReserveScheduleCard onApplied={load} />

      <Card>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Past reserve allocations, public</h3>
          <Badge tone="neutral">{filteredGrants.length}{grantQuery.trim() ? ` / ${grants.length}` : ""}</Badge>
        </div>
        {grants.length > 0 && (
          <div className="relative mb-2">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
            <Input className="pl-8" placeholder="Filter by address or reason" value={grantQuery} onChange={(e) => setGrantQuery(e.target.value)} />
          </div>
        )}
        {!loaded ? <LoadingState label="Loading reserve allocations..." slow={slow} /> : err ? (
          <ErrorState message={err} onRetry={() => void load()} />
        ) : grants.length === 0 ? (
          <EmptyState title="No grants yet" hint="Reserve allocations appear here as they are signed onto the public ledger." />
        ) : filteredGrants.length === 0 ? (
          <p className="py-4 text-center text-xs text-faint">No grants match this filter.</p>
        ) : (
          <div className="divide-y divide-hairline">
            {filteredGrants.map((g, i) => {
              const reason = (g as SignedTx & { reason?: string }).reason ?? g.memo;
              return (
                <div key={g.id ?? i} className="flex items-center justify-between gap-3 rounded-md px-1 py-2 text-sm transition-colors hover:bg-elevated">
                  <div className="min-w-0">
                    <span className="mono text-xs text-text">{shortAddress(g.to)}</span>
                    <div className="truncate text-[11px] text-faint">{reason} {g.timestamp ? "· " + timeAgo(g.timestamp) : ""}</div>
                  </div>
                  <Badge tone="teal" className="mono shrink-0">{formatZir(g.amountUZIR)} ZIR</Badge>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

// Treasury: every steward-administered project wallet (anchor reserve, events/airdrop, network, resonator
// pool, steward ops) with its live on-ledger balance, plus the runtime USDT receiving addresses. Public
// ledger data; keys never leave the operator vault. Served by GET /treasury (network-aware).
function TreasuryCard() {
  const { anchorEvent } = useZira();
  const toast = useToast();
  const [t, setT] = useState<Treasury | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const slow = useSlowHint(!loaded);
  const load = () => {
    NodeApi.treasury()
      .then((r) => { setT(r); setErr(null); })
      .catch((e) => setErr(e instanceof Error ? e.message : "Treasury is unavailable from this node."))
      .finally(() => setLoaded(true));
  };
  usePoll(load, 15000, []);
  const copy = (s: string) => { void navigator.clipboard?.writeText(s).catch(() => {}); toast.push("Address copied."); };
  const usdt = [
    anchorEvent.evm ? { label: "USDT receiving · EVM (ETH / BSC / Polygon)", address: anchorEvent.evm, role: "Anchor-event contributions on EVM chains." } : null,
    anchorEvent.tron ? { label: "USDT receiving · TRON (TRC-20)", address: anchorEvent.tron, role: "Anchor-event contributions on TRON." } : null,
  ].filter(Boolean) as { label: string; address: string; role: string }[];
  const totalUZIR = (t?.wallets ?? []).reduce((a, w) => a + w.uZIR, 0);
  return (
    <Card>
      <div className="mb-2 flex items-center gap-2"><Coins size={16} className="text-[var(--teal)]" /><h3 className="text-sm font-semibold">Treasury &amp; project wallets</h3></div>
      <p className="text-xs text-muted">Every steward-administered wallet with its live on-ledger balance. All are public ZIR addresses; their private keys stay offline in your operator vault, never in the app or source. USDT receiving addresses are set in the Anchor event card above.</p>
      {!loaded && !err ? <LoadingState label="Reading project wallets..." slow={slow} /> : err ? (
        <div className="mt-3"><ErrorState message={err} onRetry={load} /></div>
      ) : (
      <div className="mt-3 space-y-2">
        {(t?.wallets ?? []).map((w) => (
          <div key={w.key} className="rounded-lg border border-hairline bg-base p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-text">{w.label}</span>
              <Badge tone="teal" className="mono">{formatZir(w.uZIR)} ZIR</Badge>
            </div>
            <div className="mt-1 text-[11px] text-faint">{w.role}</div>
            <button onClick={() => copy(w.address)} className="mono mt-1 text-[11px] text-muted hover:text-text" title="Copy full address">{shortAddress(w.address)}</button>
          </div>
        ))}
        {usdt.map((w) => (
          <div key={w.label} className="rounded-lg border border-hairline bg-base p-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-text">{w.label}</span>
              <Badge tone="neutral">USDT</Badge>
            </div>
            <div className="mt-1 text-[11px] text-faint">{w.role}</div>
            <button onClick={() => copy(w.address)} className="mono mt-1 block break-all text-left text-[11px] text-muted hover:text-text" title="Copy full address">{w.address}</button>
          </div>
        ))}
        {t && t.wallets.length > 0 && (
          <div className="flex items-center justify-between rounded-lg border border-hairline bg-base p-2.5">
            <span className="text-xs text-faint">Total on-ledger across project wallets</span>
            <span className="mono text-sm text-text">{formatZir(totalUZIR)} ZIR</span>
          </div>
        )}
      </div>
      )}
      <p className="mt-2 text-[11px] text-faint">Network: <span className="mono text-text">{t?.network ?? "…"}</span></p>
    </Card>
  );
}

// Steward Anchor Event ON/OFF switch (spec §2.1 / §6.2). ON makes the USDT contribute section live on the
// Anchors page for all users; OFF hides it everywhere with no trace. Steward-gated at the node RPC layer.
function AnchorEventControl() {
  const { anchorEvent, refreshStatus } = useZira();
  const request = useUnlock((s) => s.request);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [evm, setEvm] = useState(anchorEvent.evm);
  const [tron, setTron] = useState(anchorEvent.tron);
  const [wc, setWc] = useState(anchorEvent.wcProjectId);
  useEffect(() => { setEvm(anchorEvent.evm); setTron(anchorEvent.tron); setWc(anchorEvent.wcProjectId); }, [anchorEvent.evm, anchorEvent.tron, anchorEvent.wcProjectId]);
  async function save(enabled: boolean) {
    setBusy(true);
    try {
      const ok = await request();
      if (!ok) { setBusy(false); return; }
      await NodeApi.setAnchorEvent({ enabled, evm: evm.trim(), tron: tron.trim(), wcProjectId: wc.trim() });
      await refreshStatus();
      toast.push(enabled
        ? "Anchor event ON. The contribute section is now live on the Anchors page."
        : "Anchor event OFF. The contribute section is now hidden for everyone.");
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "could not update the anchor event", "danger");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold"><AnchorIcon size={16} className="text-[var(--teal)]" /> Anchor event</div>
          <div className="mt-1 text-xs text-muted">When ON, the USDT contribute section appears on the Anchors page for all users. When OFF, it disappears entirely, with no trace.</div>
        </div>
        <Badge tone={anchorEvent.enabled ? "teal" : "neutral"}>{anchorEvent.enabled ? "ON" : "OFF"}</Badge>
      </div>
      <div className="mt-3 space-y-2">
        <div>
          <div className="mb-1 text-xs text-faint">USDT receiving address · Ethereum / BSC / Polygon (EVM)</div>
          <Input className="mono" placeholder="0x..." value={evm} onChange={(e) => setEvm(e.target.value)} />
        </div>
        <div>
          <div className="mb-1 text-xs text-faint">USDT receiving address · TRON (TRC-20)</div>
          <Input className="mono" placeholder="T..." value={tron} onChange={(e) => setTron(e.target.value)} />
        </div>
        <div>
          <div className="mb-1 text-xs text-faint">WalletConnect project id (for the QR contribution flow)</div>
          <Input className="mono" placeholder="from cloud.walletconnect.com" value={wc} onChange={(e) => setWc(e.target.value)} />
        </div>
        <p className="text-[11px] text-faint">Set the receiving addresses from your local-private wallet file, or a hardware/multisig address (preferred before real funds). The WalletConnect project id (free from cloud.walletconnect.com) powers the QR contribution; without it, the EVM QR flow stays disabled. All are stored on the node and shown to contributors, never hardcoded in source.</p>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button variant="secondary" onClick={() => save(false)} disabled={busy || !anchorEvent.enabled}>Turn OFF</Button>
        <Button variant="primary" onClick={() => save(true)} disabled={busy || !(evm.trim() || tron.trim())} title={!(evm.trim() || tron.trim()) ? "Enter at least one receiving address (EVM or TRON) before turning the event on" : undefined}>{anchorEvent.enabled ? "Save / keep ON" : "Turn ON"}</Button>
      </div>
    </Card>
  );
}

// Steward queue of self-reported anchor contributions (spec §2.5/§2.7). On-chain detection is
// authoritative; this surfaces pending payments so the steward can confirm and then assign the seat
// via "Assign anchor positions" below.
type ContributionRow = { zirAddress: string; network: string; amountUsdt: number; txHash: string; classCode: string; quantity: number; ts: number; status: "pending" | "confirmed" | "failed"; confirmations: number; sender: string; reason?: string };

function AnchorContributionsCard() {
  const { isFounder, isStewardWallet } = useZira();
  const enabled = isFounder || isStewardWallet;
  const [rows, setRows] = useState<ContributionRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "confirmed" | "failed">("all");
  const [sort, setSort] = useState<"recent" | "amount">("recent");
  const slow = useSlowHint(enabled && !loaded);
  const load = () => {
    if (!enabled) { setLoaded(true); return; }
    NodeApi.getAnchorContributions().then((r) => setRows(r)).catch(() => { /* steward-only; ignore */ }).finally(() => setLoaded(true));
  };
  usePoll(load, 10000, [enabled]);
  const confirmed = rows.filter((c) => c.status === "confirmed").length;
  const view = useMemo(() => {
    const base = statusFilter === "all" ? rows : rows.filter((c) => c.status === statusFilter);
    return [...base].sort((a, b) => sort === "amount" ? b.amountUsdt - a.amountUsdt : b.ts - a.ts);
  }, [rows, statusFilter, sort]);

  // First load can show the empty placeholder once we know the node returned nothing; while still loading
  // for a keyed steward node, show a spinner so a blank slot doesn't look like a dead queue.
  if (!loaded && enabled) {
    return <Card><div className="mb-2 flex items-center gap-2"><AnchorIcon size={16} className="text-[var(--teal)]" /><h3 className="text-sm font-semibold">Anchor contributions queue</h3></div><LoadingState label="Reading contributions queue..." slow={slow} /></Card>;
  }
  if (rows.length === 0) return null;
  return (
    <Card>
      <div className="mb-2 flex items-center gap-2"><AnchorIcon size={16} className="text-[var(--teal)]" /><h3 className="text-sm font-semibold">Anchor contributions queue</h3><Badge tone={confirmed > 0 ? "teal" : "neutral"} className="ml-auto">{confirmed} confirmed / {rows.length}</Badge></div>
      <p className="mb-2 text-xs text-muted">The payment watcher verifies each contribution on-chain (exact amount to your receiving address, with confirmations). Assign the seat with &quot;Assign anchor positions&quot; below once it shows confirmed.</p>
      <div className="mb-2 grid grid-cols-2 gap-2">
        <Field label="Status">
          <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}>
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="confirmed">Confirmed</option>
            <option value="failed">Failed</option>
          </Select>
        </Field>
        <Field label="Sort">
          <Select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
            <option value="recent">Most recent</option>
            <option value="amount">Largest amount</option>
          </Select>
        </Field>
      </div>
      {view.length === 0 ? <p className="py-3 text-center text-xs text-faint">No contributions match this filter.</p> : (
      <div className="divide-y divide-hairline">
        {view.map((c, i) => (
          <div key={c.txHash + i} className="rounded-md px-1 py-2 text-xs transition-colors hover:bg-elevated">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-text">{c.classCode} × {c.quantity}</span>
              <span className="flex items-center gap-1">
                <Badge tone={c.status === "confirmed" ? "teal" : c.status === "failed" ? "danger" : "warn"}>{c.status === "confirmed" ? "confirmed" : c.status === "failed" ? "failed" : `pending${c.confirmations ? ` ${c.confirmations}` : ""}`}</Badge>
                <Badge tone="neutral" className="mono">{c.amountUsdt.toLocaleString()} USDT · {c.network}</Badge>
              </span>
            </div>
            <div className="mt-1 text-faint">to <span className="mono">{shortAddress(c.zirAddress)}</span>{c.sender ? <> · from <span className="mono">{shortAddress(c.sender)}</span></> : null} · tx <span className="mono break-all">{c.txHash.slice(0, 18)}…</span> · {timeAgo(c.ts)}</div>
            {c.status !== "confirmed" && c.reason ? <div className="mt-0.5 text-[11px] text-faint">{c.reason}</div> : null}
          </div>
        ))}
      </div>
      )}
    </Card>
  );
}

function FounderResonatorReadiness() {
  const [models, setModels] = useState(0);
  useEffect(() => {
    NodeApi.models().then((m) => setModels(m.length)).catch(() => setModels(0));
  }, []);
  return (
    <Card>
      <div className="mb-2 flex items-center gap-2"><Bot size={16} className="text-[var(--indigo)]" /><h3 className="text-sm font-semibold">Steward Resonator readiness</h3></div>
      <p className="text-xs text-muted">The default steward-owned ZIRA Resonator is published automatically only when the node itself runs with an active steward key. Extra steward Resonators should be created from the unlocked steward wallet, funded with ZIR, and left in resonance only after at least one authorized model is distributed to storage peers or operator-enabled miners.</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <Stat label="Field models" value={models} tone={models > 0 ? "teal" : "warn"} />
        <Stat label="Learning state" value={models > 0 ? "ready to fund" : "wait for model"} />
        <Stat label="Funding rule" value="allocate gradually" />
      </div>
      {models === 0 && <p className="mt-2 text-[11px] text-faint">Do not announce model learning yet. Add a raw GGUF, wait for peer distribution, then fund steward Resonators from this wallet.</p>}
    </Card>
  );
}

function FounderSecurityCard() {
  const { address, stats } = useZira();
  const active = stats?.founderAddresses ?? [];
  const genesis = stats?.founderAddress;
  const isGenesis = Boolean(address && genesis === address);
  return (
    <Card>
      <div className="mb-2 flex items-center gap-2"><ShieldCheck size={16} className="text-[var(--warn)]" /><h3 className="text-sm font-semibold">Steward security and permissions</h3></div>
      <p className="text-xs text-muted">Steward actions are not server permissions. They are signed ledger actions from an active steward wallet: reserve allocations, stewardship delegation/revocation, GGUF authorization, bootstrap registry signing, and launch policy updates. Keep the wallet locked until a specific action needs a signature.</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-4">
        <Stat label="This wallet" value={<span className="block truncate">{address ? shortAddress(address) : "none"}</span>} />
        <Stat label="Role" value={isGenesis ? "genesis steward" : "delegated steward"} tone={isGenesis ? "teal" : "indigo"} />
        <Stat label="Active stewards" value={active.length || 1} />
        <Stat label="Connection" value="local node" />
      </div>
      <div className="mt-3 rounded-lg border border-[color-mix(in_srgb,var(--warn)_28%,var(--border))] bg-[color-mix(in_srgb,var(--warn)_7%,transparent)] p-3 text-xs text-muted">
        Security rule: never paste steward private keys into public docs or web forms. Delegate operational steward wallets for daily work, revoke them when no longer needed, and keep the genesis steward offline whenever possible.
      </div>
    </Card>
  );
}

function FounderModelFieldCard() {
  const toast = useToast();
  const [sourceType, setSourceType] = useState<"url" | "path">("url");
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const [arch, setArch] = useState("");
  const [quant, setQuant] = useState("");
  const [assign, setAssign] = useState(true); // distribute this model to every storage node by default
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const cleanSource = source.trim();
  const cleanName = name.trim() || cleanSource.split(/[\\/]/).pop()?.replace(/\.gguf$/i, "").replace(/[-_]+/g, " ") || "GGUF model";

  function requestAdd() {
    if (!cleanSource) { toast.push("Add a GGUF URL or local node path first.", "warn"); return; }
    if (!/\.gguf($|[?#])/i.test(cleanSource)) { toast.push("Use a raw .gguf model source.", "warn"); return; }
    setConfirm(true);
  }

  async function addModel() {
    setBusy(true);
    try {
      const localFile = cleanSource.split(/[\\/]/).pop() || "local-model.gguf";
      const meta = await NodeApi.provideModelLink({
        url: sourceType === "url" ? cleanSource : `local://${localFile}`,
        path: sourceType === "path" ? cleanSource : undefined,
        name: cleanName,
        arch: arch.trim() || undefined,
        quant: quant.trim() || undefined,
        domains: ["general"],
        version: 1,
        assigned: assign,
      });
      toast.push(`Authorized model on the network: ${meta.name}`);
      setSource(""); setName(""); setArch(""); setQuant(""); setConfirm(false);
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "Could not add model.", "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <ConfirmModal open={confirm} onClose={() => setConfirm(false)} onConfirm={addModel} busy={busy} title="Authorize GGUF on the network" confirmLabel="Authorize and announce">
        <p>You are about to sign and announce a model to every peer on the network. This is a public, signed steward action.</p>
        <div className="rounded-lg border border-hairline bg-base p-2.5 text-xs">
          <div><span className="text-faint">Name</span> <span className="text-text">{cleanName}</span></div>
          <div className="mt-1 break-all"><span className="text-faint">Source</span> <Mono>{cleanSource}</Mono></div>
          {(arch.trim() || quant.trim()) && <div className="mt-1"><span className="text-faint">Build</span> <span className="text-text">{[arch.trim(), quant.trim()].filter(Boolean).join(" · ")}</span></div>}
        </div>
      </ConfirmModal>
      <div className="mb-2 flex items-center gap-2"><ShieldCheck size={16} className="text-[var(--indigo)]" /><h3 className="text-sm font-semibold">Add GGUF models to the network</h3></div>
      <p className="text-xs text-muted">Active stewards can add more GGUF models later. The node hashes the model, signs the metadata, announces it to peers, and storage-enabled nodes replicate the bytes. Use a public raw GGUF URL, or a local path only when the node runs on this same machine and can read that file.</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <Field label="Source type">
          <Select value={sourceType} onChange={(e) => setSourceType(e.target.value as "url" | "path")}>
            <option value="url">Raw GGUF URL</option>
            <option value="path">Local node path</option>
          </Select>
        </Field>
        <Field label="Model source" hint={sourceType === "path" ? "Example: C:\\models\\model.gguf. The node must be able to read it." : "Use a direct downloadable .gguf URL."}>
          <Input className="mono" value={source} onChange={(e) => setSource(e.target.value)} placeholder={sourceType === "path" ? "C:\\models\\new-model.gguf" : "https://.../model.gguf"} />
        </Field>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Model display name" /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Architecture"><Input value={arch} onChange={(e) => setArch(e.target.value)} placeholder="qwen, llama, gemma..." /></Field>
          <Field label="Quant"><Input value={quant} onChange={(e) => setQuant(e.target.value)} placeholder="Q8_0, Q4_K_M, BF16..." /></Field>
        </div>
      </div>
      <label className="mt-3 flex items-start gap-2 text-xs text-muted">
        <input type="checkbox" checked={assign} onChange={(e) => setAssign(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" />
        <span>Distribute to the whole storage network. Every node with storage on fetches this model automatically, so it is widely served across the field. Leave off to only fill replication gaps.</span>
      </label>
      <p className="mt-3 text-[11px] text-faint">Routing is automatic: the network matches each question to the best available model by architecture and capability. Subject domains are a per-Resonator attribute set by their owners, not a model tag.</p>
      <Button variant="primary" className="mt-3 w-full" onClick={requestAdd} disabled={busy || !source.trim()}>
        <ShieldCheck size={15} /> Authorize and announce GGUF
      </Button>
    </Card>
  );
}

function FounderBootstrapRegistryCard({ network }: { network: string }) {
  const request = useUnlock((s) => s.request);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<BootstrapSeedCandidate[]>([]);
  const [detectedHost, setDetectedHost] = useState("");
  const readySeeds = candidates.filter((seed) => seed.eligible && seed.status === "ready");
  const publicCount = candidates.filter((seed) => seed.shareable).length;
  const blockedCount = candidates.filter((seed) => seed.shareable && !seed.eligible).length;

  async function loadCandidates() {
    setBusy(true);
    try {
      const res = await NodeApi.bootstrapCandidates({
        inferPublicHost: true,
        checkReachability: true,
        scanLocalMesh: true,
      });
      setCandidates(res.candidates);
      setDetectedHost(res.publicHost ?? "");
      const ready = res.candidates.filter((seed) => seed.eligible && seed.status === "ready").length;
      toast.push(ready > 0
        ? `Found ${ready} ready public bootstrap seed${ready === 1 ? "" : "s"}.`
        : res.publicHostError || "No reachable public bootstrap seeds yet. Open/forward TCP ports, then reload.", ready > 0 ? "teal" : "warn");
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "Could not load bootstrap candidates", "danger");
    } finally {
      setBusy(false);
    }
  }

  async function downloadRegistry() {
    if (readySeeds.length === 0) {
      toast.push("No reachable public seed candidates. Reload after opening/forwarding TCP ports.", "warn");
      return;
    }
    const ok = await request();
    if (!ok) return;
    const pubKey = Wallet.publicKey();
    if (!pubKey) { toast.push("Unlock the steward wallet first.", "warn"); return; }
    const generatedAt = Date.now();
    const selected = readySeeds.slice(0, 16);
    const body = {
      version: 1,
      network,
      generatedAt,
      seeds: selected.map((seed, index) => ({
        multiaddr: seed.multiaddr,
        label: seed.label,
        roles: index === 0 ? ["master", "bootstrap", "community-seed"] : ["master-candidate", "bootstrap", "community-seed"],
        priority: index + 1,
      })),
      pubKey,
      sig: undefined,
    };
    const registry = { ...body, sig: Wallet.sign(canonical(body)) };
    const blob = new Blob([`${JSON.stringify(registry, null, 2)}\n`], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "bootstrap-seeds.json";
    a.click();
    URL.revokeObjectURL(a.href);
    toast.push(`Signed bootstrap-seeds.json downloaded with ${selected.length} reachable public seed${selected.length === 1 ? "" : "s"}.`);
  }

  const toneFor = (seed: BootstrapSeedCandidate) => seed.status === "ready" ? "teal" : seed.status === "unreachable" ? "warn" : "neutral";
  return (
    <Card>
      <div className="mb-2 flex items-center gap-2"><NetIcon size={16} className="text-[var(--teal)]" /><h3 className="text-sm font-semibold">WordPress bootstrap registry</h3></div>
      <p className="text-xs text-muted">
        One click builds the public phone book for new users. The steward detects this machine's public
        address, scans active mesh nodes and field peers, excludes local/LAN addresses, checks public TCP
        reachability, ranks the strongest live seeds first, then downloads a steward-signed{" "}
        <Mono>bootstrap-seeds.json</Mono> for <Mono>https://zira.network/bootstrap-seeds.json</Mono>.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={loadCandidates} disabled={busy}><NetIcon size={14} /> Detect public seeds</Button>
        <Button variant="primary" onClick={downloadRegistry} disabled={busy || readySeeds.length === 0}><Download size={14} /> Download ready JSON</Button>
        <Badge tone={readySeeds.length > 0 ? "teal" : "neutral"}>{readySeeds.length} ready</Badge>
        <Badge tone={publicCount > 0 ? "indigo" : "neutral"}>{publicCount} public</Badge>
        {blockedCount > 0 && <Badge tone="warn">{blockedCount} blocked</Badge>}
      </div>
      {detectedHost && <p className="mt-2 text-[11px] text-faint">Detected public host: <span className="mono">{detectedHost}</span>. Local and LAN addresses are never included in the download.</p>}
      {candidates.length > 0 && (
        <div className="mt-3 max-h-48 overflow-auto rounded-lg border border-hairline bg-base/60">
          {candidates.slice(0, 12).map((seed) => (
            <div key={seed.multiaddr} className="border-b border-hairline px-2 py-1.5 last:border-b-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-text">{seed.label}</span>
                <Badge tone={toneFor(seed)} className="text-[10px]">{seed.status}</Badge>
              </div>
              <div className="mono truncate text-[10px] text-faint">{seed.multiaddr}</div>
              <div className="text-[10px] text-faint">score {seed.score} · {seed.roles.join(", ")}</div>
              <div className="text-[10px] text-faint">{seed.reason}</div>
            </div>
          ))}
        </div>
      )}
      <p className="mt-2 text-[11px] text-faint">The download is signed by the unlocked steward wallet. Do not edit the JSON by hand after download or the signature will fail. If no seed is ready, open Windows Firewall and router/NAT TCP forwarding first, then detect again.</p>
    </Card>
  );
}

type Cadence = ReserveDistributionCadence;
type ReservePlanSent = ReserveDistributionSent;
type ReservePlan = ReserveDistributionPlan;

const RESERVE_PLANS_STORE = "zira.reserveDistributionPlans";

function readReservePlans(): ReservePlan[] {
  try { return JSON.parse(localStorage.getItem(RESERVE_PLANS_STORE) || "[]") as ReservePlan[]; } catch { return []; }
}
function writeReservePlans(plans: ReservePlan[]): void {
  localStorage.setItem(RESERVE_PLANS_STORE, JSON.stringify(plans));
}
function toLocalDateTime(ts: number): string {
  const d = new Date(ts - new Date().getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}
function fromLocalDateTime(value: string): number {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : Date.now();
}
const reservePlanSlots = reserveDistributionSlots;

function ReserveScheduleCard({ onApplied }: { onApplied: () => Promise<void> }) {
  const { client, address, network } = useZira();
  const request = useUnlock((s) => s.request);
  const toast = useToast();
  const [plans, setPlans] = useState<ReservePlan[]>(readReservePlans);
  const [targets, setTargets] = useState("");
  const [amount, setAmount] = useState("");
  const [startAt, setStartAt] = useState(() => toLocalDateTime(Date.now() + 60_000));
  const [periodDays, setPeriodDays] = useState("365");
  const [cadence, setCadence] = useState<Cadence>("monthly");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(Wallet.isUnlocked());

  useEffect(() => { writeReservePlans(plans); }, [plans]);
  useEffect(() => {
    const timer = setInterval(() => {
      setArmed(Wallet.isUnlocked());
      if (Wallet.isUnlocked()) void processDue(false);
    }, 20_000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plans, client, address, network]);

  const parsedTargets = targets.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
  const validTargets = parsedTargets.filter(isValidAddress);
  const previewStart = fromLocalDateTime(startAt);
  const previewEnd = previewStart + Math.max(1, Number(periodDays) || 1) * 24 * 60 * 60 * 1000;
  const previewPlan: ReservePlan = {
    id: "preview", targets: validTargets.length ? validTargets : ["zir1preview"],
    amountPerTargetUZIR: zirToUzir(Number(amount) || 0), startAt: previewStart, endAt: previewEnd,
    cadence, reason: reason.trim(), createdAt: Date.now(), sent: [],
  };
  const previewSlots = reservePlanSlots(previewPlan);
  const activePlans = plans.filter((p) => !p.cancelledAt);
  const dueCount = activePlans.reduce((sum, p) => {
    return sum + dueReserveDistributionSlots(p, Date.now()).length;
  }, 0);
  // The earliest not-yet-sent, not-yet-due slot across all active plans, for the "next installment" line.
  const nextSlotAt = (() => {
    const now = Date.now();
    let next = Infinity;
    for (const p of activePlans) {
      const sent = new Set(p.sent.map((s) => s.key));
      for (const slot of reservePlanSlots(p)) {
        if (!sent.has(slot.key) && slot.dueAt > now && slot.dueAt < next) next = slot.dueAt;
      }
    }
    return Number.isFinite(next) ? next : null;
  })();

  function createPlan() {
    if (validTargets.length === 0 || validTargets.length !== parsedTargets.length) { toast.push("Every target must be a valid ZIR address.", "warn"); return; }
    if (!Number(amount) || Number(amount) <= 0) { toast.push("Enter a positive amount per target.", "warn"); return; }
    if (!reason.trim()) { toast.push("Add a public reason for the allocation.", "warn"); return; }
    const start = fromLocalDateTime(startAt);
    const end = start + Math.max(1, Number(periodDays) || 1) * 24 * 60 * 60 * 1000;
    const plan: ReservePlan = {
      id: `reserve-plan-${Date.now()}`,
      targets: validTargets,
      amountPerTargetUZIR: zirToUzir(Number(amount)),
      startAt: start,
      endAt: end,
      cadence,
      reason: reason.trim(),
      createdAt: Date.now(),
      sent: [],
    };
    setPlans([plan, ...plans]);
    setTargets(""); setAmount(""); setReason("");
    toast.push("Reserve distribution plan created. Due installments will submit while this steward wallet is unlocked.");
  }

  function cancelPlan(id: string) {
    setPlans(plans.map((p) => p.id === id ? { ...p, cancelledAt: Date.now() } : p));
    toast.push("Future installments cancelled. Already-signed grants remain public on the ledger.");
  }

  async function processDue(promptUnlock = true) {
    if (!client || !address) return;
    const duePlans = plans.filter((p) => !p.cancelledAt);
    const due = duePlans.flatMap((p) => {
      return dueReserveDistributionSlots(p, Date.now()).map((s) => ({ plan: p, slot: s }));
    });
    if (due.length === 0) {
      if (promptUnlock) toast.push("No reserve installments are due yet.", "neutral");
      return;
    }
    if (promptUnlock) {
      const ok = await request();
      if (!ok) return;
    } else if (!Wallet.isUnlocked()) {
      return;
    }
    setBusy(true);
    try {
      const challenge = `zira-reserve-schedule:${Date.now()}`;
      const challengeSig = Wallet.sign(challenge);
      let nonce = await client.getNonce(address);
      const nextPlans = [...plans];
      for (const { plan, slot } of due) {
        const tx = makeSignedTx({
          network, to: slot.to, amountUZIR: slot.amountUZIR, nonce, kind: "reserve_grant",
          memo: `[scheduled:${plan.id}] ${plan.reason}`,
        });
        const res = await client.grantReserve(tx, plan.reason, challenge, challengeSig);
        if (!res.accepted) throw new Error(res.reason ?? "scheduled allocation rejected");
        nonce += 1;
        const idx = nextPlans.findIndex((p) => p.id === plan.id);
        if (idx >= 0) nextPlans[idx] = { ...nextPlans[idx]!, sent: [...nextPlans[idx]!.sent, { key: slot.key, txId: tx.id, timestamp: Date.now(), amountUZIR: slot.amountUZIR, to: slot.to }] };
      }
      setPlans(nextPlans);
      await onApplied();
      // Only announce when the steward explicitly ran this. The 20s auto-tick stays silent so it never
      // surfaces an unrelated toast (e.g. while the wallet is unlocked to toggle the Anchor event); the
      // result is still recorded to the plan history.
      if (promptUnlock) toast.push(`Submitted ${due.length} scheduled reserve installment${due.length === 1 ? "" : "s"}.`);
    } catch (e) {
      if (promptUnlock) toast.push(e instanceof Error ? e.message : "scheduled allocation failed", "danger");
    } finally { setBusy(false); }
  }

  return (
    <Card>
      <div className="mb-2 flex items-center gap-2"><CalendarClock size={16} className="text-[var(--teal)]" /><h3 className="text-sm font-semibold">Scheduled reserve distribution</h3></div>
      <p className="mb-3 text-xs text-muted">Create a cancelable distribution plan. The amount is split progressively across the selected period and submitted as public <Mono>reserve_grant</Mono> transactions when installments become due. The steward wallet must be open and unlocked for automatic signing.</p>
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-hairline bg-base p-2.5 text-[11px] text-faint">
        <Badge tone={armed ? "teal" : "neutral"}>{armed ? "Auto-sign armed" : "Auto-sign paused"}</Badge>
        <span>{armed ? "Due installments submit automatically every 20s while the wallet stays unlocked." : "Unlock the steward wallet to arm automatic signing."}</span>
        <span className="ml-auto flex items-center gap-3">
          <span>{activePlans.length} active plan{activePlans.length === 1 ? "" : "s"}</span>
          <span>{dueCount} due now</span>
          {nextSlotAt && <span>next installment <span className="mono text-text">{relFuture(nextSlotAt)}</span></span>}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Target addresses" hint="One or many ZIR addresses, separated by spaces, commas, or new lines.">
          <Textarea className="mono" rows={3} value={targets} onChange={(e) => setTargets(e.target.value)} placeholder="zir1...&#10;zir1..." />
        </Field>
        <div className="space-y-2">
          <Field label="Amount per target" hint="Total ZIR each address receives across the full period.">
            <Input className="mono" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="1000" />
          </Field>
          <Field label="Public reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="ecosystem allocation, contributor, anchor candidate..." /></Field>
        </div>
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        <Field label="Start date/time"><Input type="datetime-local" value={startAt} onChange={(e) => setStartAt(e.target.value)} /></Field>
        <Field label="Period days"><Input className="mono" value={periodDays} onChange={(e) => setPeriodDays(e.target.value)} /></Field>
        <Field label="Cadence"><Select value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)}><option value="hourly">Hourly</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></Select></Field>
      </div>
      <div className="mt-3 rounded-lg border border-hairline bg-base p-3 text-xs text-muted">
        Preview: <span className="mono text-text">{previewSlots.length}</span> installments total, about <span className="mono text-[var(--teal)]">{formatZir(previewSlots[0]?.amountUZIR ?? 0)} ZIR</span> per installment per target.
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" onClick={createPlan} disabled={busy || !targets.trim() || !amount || !reason.trim()}>Create distribution plan</Button>
        <Button variant="secondary" onClick={() => processDue(true)} disabled={busy || dueCount === 0}>Process due installments {dueCount ? `(${dueCount})` : ""}</Button>
      </div>
      {plans.length > 0 && (
        <div className="mt-4 divide-y divide-hairline border-t border-hairline">
          {plans.map((p) => {
            const slots = reservePlanSlots(p);
            const sent = p.sent.length;
            const pct = slots.length ? Math.round((sent / slots.length) * 100) : 0;
            return (
              <div key={p.id} className="py-3 text-xs">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium text-text">{p.targets.length} target{p.targets.length === 1 ? "" : "s"} · {formatZir(p.amountPerTargetUZIR)} ZIR each</div>
                    <div className="mt-1 text-faint">{p.reason}</div>
                    <div className="mono mt-1 text-faint">{new Date(p.startAt).toLocaleString()} to {new Date(p.endAt).toLocaleString()} · {p.cadence}</div>
                  </div>
                  {p.cancelledAt ? <Badge tone="neutral">cancelled</Badge> : <Button variant="ghost" onClick={() => cancelPlan(p.id)}><XCircle size={14} /> Cancel</Button>}
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-elevated"><div className="h-full rounded-full gradient-bg" style={{ width: `${pct}%` }} /></div>
                <div className="mt-1 text-faint">{sent}/{slots.length} installments sent</div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function FounderBackupCard() {
  const toast = useToast();
  const { client, address, network, stats } = useZira();
  const request = useUnlock((s) => s.request);
  const [addresses, setAddresses] = useState<string[]>([]);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ kind: "assign" | "revoke"; addr: string } | null>(null);

  async function load() {
    try {
      const r = await NodeApi.founderBackups();
      const active = stats?.founderAddresses ?? [];
      setAddresses([...new Set([...active, ...r.addresses])]);
    } catch {
      setAddresses(stats?.founderAddresses ?? []);
    }
  }
  useEffect(() => { void load(); }, [stats?.founderAddresses?.join("|")]);
  function add() {
    const a = value.trim();
    if (!isValidAddress(a)) { toast.push("Enter a valid ZIR address.", "warn"); return; }
    setPending({ kind: "assign", addr: a });
  }
  async function confirmPending() {
    if (!pending) return;
    const { kind, addr } = pending;
    if (kind === "assign") { await assignFounder(addr); setValue(""); }
    else await revokeFounder(addr);
    setPending(null);
  }
  async function assignFounder(a: string) {
    if (!client || !address) return;
    const ok = await request();
    if (!ok) return;
    setBusy(true);
    try {
      const nonce = await client.getNonce(address);
      const tx = makeSignedTx({ network, to: a, amountUZIR: 0, feeUZIR: 0, nonce, kind: "founder_delegate", memo: "steward delegation" });
      const res = await client.submitTx(tx);
      if (res.accepted) {
        toast.push("Steward delegation signed. It becomes active after the next ledger round.");
        setAddresses([...new Set([...addresses, a])]);
      } else {
        toast.push("Rejected: " + (res.reason ?? "delegation failed"), "danger");
      }
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "could not assign steward", "danger");
    } finally { setBusy(false); }
  }
  async function revokeFounder(a: string) {
    if (!client || !address) return;
    if (a === stats?.founderAddress) { toast.push("The genesis steward cannot be removed.", "warn"); return; }
    const ok = await request();
    if (!ok) return;
    setBusy(true);
    try {
      const nonce = await client.getNonce(address);
      const tx = makeSignedTx({ network, to: a, amountUZIR: 0, feeUZIR: 0, nonce, kind: "founder_revoke", memo: "steward revocation" });
      const res = await client.submitTx(tx);
      if (res.accepted) {
        toast.push("Steward revocation signed. It becomes inactive after the next ledger round.");
        setAddresses(addresses.filter((x) => x !== a));
      } else {
        toast.push("Rejected: " + (res.reason ?? "revocation failed"), "danger");
      }
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "could not revoke steward", "danger");
    } finally { setBusy(false); }
  }

  return (
    <Card>
      <ConfirmModal
        open={!!pending}
        onClose={() => setPending(null)}
        onConfirm={confirmPending}
        busy={busy}
        danger={pending?.kind === "revoke"}
        title={pending?.kind === "revoke" ? "Revoke stewardship" : "Delegate stewardship"}
        confirmLabel={pending?.kind === "revoke" ? "Sign revocation" : "Sign delegation"}
      >
        {pending?.kind === "revoke" ? (
          <p>Revoke launch authority from <Mono>{shortAddress(pending.addr)}</Mono>. After the next ledger round this wallet can no longer sign any steward action. This is a signed, public transaction.</p>
        ) : (
          <p>Grant full launch authority to <Mono>{shortAddress(pending?.addr ?? "")}</Mono>. It will be able to sign every steward action (reserve, treasury, anchor event, seat assignment, model authorization) after the next ledger round. This is a signed, public transaction.</p>
        )}
      </ConfirmModal>
      <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><ShieldCheck size={16} className="text-[var(--teal)]" /> Active stewardship addresses</h3>
      <p className="mb-3 text-xs text-muted">These ZIR addresses hold launch authority: they gate every steward action (model authorization, reserve and treasury administration, the anchor event, seat assignment) and are enforced on-ledger, not in the app. The genesis steward is permanent; any active steward can delegate or revoke another with a signed transaction that takes effect after the next ledger round. Keep each address&apos;s private key offline in your operator vault.</p>
      <div className="flex gap-2">
        <Input className="mono flex-1" placeholder="Steward address (zir1...)" value={value} onChange={(e) => setValue(e.target.value)} />
        <Button variant="primary" onClick={add} disabled={busy || !value.trim()}>Assign</Button>
      </div>
      {addresses.length > 0 ? (
        <div className="mt-3 divide-y divide-hairline border-t border-hairline">
          {addresses.map((a) => (
            <div key={a} className="flex items-center justify-between gap-2 py-2 text-xs">
              <span className="mono truncate text-muted">{a}</span>
              <div className="flex items-center gap-2">
                <Badge tone="teal">{a === stats?.founderAddress ? "genesis" : "active"}</Badge>
                {a !== stats?.founderAddress && (
                  <Button variant="danger" className="px-2 py-1 text-[11px]" onClick={() => setPending({ kind: "revoke", addr: a })} disabled={busy}>
                    Remove
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : <p className="mt-2 text-[11px] text-faint">No delegated stewardship addresses recorded yet. The genesis steward remains active.</p>}
    </Card>
  );
}

function EmissionCard({ stats }: { stats: (NetworkStats & { currentEpoch?: number; finalizedEpoch?: number }) | null }) {
  const epoch = stats?.currentEpoch ?? stats?.finalizedEpoch ?? 0;
  const rewardUZIR = epochReward(epoch);
  const rewardZir = Number(rewardUZIR) / PROTOCOL.UZIR_PER_ZIR;
  const halvings = Math.floor(epoch / EMISSION.HALVING_EPOCHS);
  const nextHalving = EMISSION.HALVING_EPOCHS - (epoch % EMISSION.HALVING_EPOCHS);
  const emitted = stats?.emittedUZIR ?? 0;
  const circulating = stats?.circulatingUZIR ?? 0;
  const pct = (circulating / PROTOCOL.MAX_SUPPLY_UZIR) * 100;
  const consensus = rewardZir * EMISSION.CONSENSUS_SHARE;
  const inference = rewardZir * EMISSION.INFERENCE_SHARE;
  const agent = rewardZir * EMISSION.AGENT_SHARE;
  const fmt = (z: number) => z.toLocaleString(undefined, { maximumFractionDigits: 0 });

  return (
    <Card>
      <div className="mb-2 flex items-center gap-2"><TrendingDown size={16} className="text-[var(--teal)]" /><h3 className="text-sm font-semibold">Emission schedule</h3></div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label="Current epoch" value={epoch.toLocaleString()} />
        <Stat label="Epoch reward" value={`${fmt(rewardZir)} ZIR`} />
        <Stat label="Halvings elapsed" value={halvings} hint={`next ~${nextHalving.toLocaleString()}`} />
        <Stat label="Circulating" value={`${pct.toFixed(2)}%`} tone="teal" />
      </div>
      <div className="mt-3 border-t border-hairline pt-2">
        <div className="mb-1 text-xs font-medium text-text">Split this epoch</div>
        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          <div><div className="text-faint">Consensus 25%</div><div className="mono">{fmt(consensus)} ZIR</div><div className="text-[10px] text-faint">nodes × uptime ZTI</div></div>
          <div><div className="text-faint">Inference 50%</div><div className="mono">{fmt(inference)} ZIR</div><div className="text-[10px] text-faint">providers × ZTI × queries</div></div>
          <div><div className="text-faint">Resonator 25%</div><div className="mono">{fmt(agent)} ZIR</div><div className="text-[10px] text-faint">resonators × tasks</div></div>
        </div>
      </div>
      <p className="mt-2 text-[11px] text-faint">Emitted to date: {formatZir(emitted)} ZIR · cap 28.7B · geometric halving every {EMISSION.HALVING_EPOCHS.toLocaleString()} epochs.</p>
    </Card>
  );
}

// Founder control for transparent community events. Activate/deactivate airdrops funded by the
// events/ecosystem reserve wallet. Giving ZIR away only; never a sale. The user-facing "+" appears
// while active and the reserve holds at least 1000 ZIR.
function EventsControl() {
  const [s, setS] = useState<EventsStatus | null>(null);
  const [claimZir, setClaimZir] = useState("10");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const load = () => { NodeApi.eventsStatus().then(setS).catch(() => { /* node may not expose events */ }); };
  usePoll(load, 10000, []);
  if (!s) return null;
  async function set(patch: { active?: boolean; claimZir?: number }) {
    setBusy(true);
    try { setS(await NodeApi.eventsConfig(patch)); toast.push("Events updated."); }
    catch (e) { toast.push(e instanceof Error ? e.message : "Could not update events.", "danger"); }
    finally { setBusy(false); }
  }
  return (
    <Card>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2"><Gift size={16} className="text-[var(--teal)]" /><h3 className="text-sm font-semibold">Community events (airdrops)</h3></div>
        <Badge tone={s.active ? "teal" : "neutral"}>{s.active ? "active" : "off"}</Badge>
      </div>
      {!s.configured ? (
        <p className="mt-1 text-xs text-muted">The events wallet is not loaded on this node. Set <span className="mono">ZIRA_EVENTS_KEY</span> on the steward node to enable transparent airdrops.</p>
      ) : (
        <>
          <p className="mt-1 text-xs text-muted">Give ZIR away from the events reserve. Users see a "+" to claim while this is active and the reserve holds at least 1000 ZIR. This is never a sale.</p>
          <div className="mt-2 grid grid-cols-2 gap-2.5">
            <Stat label="Events reserve" value={`${formatZir(s.walletUZIR)} ZIR`} tone="teal" />
            <Stat label="Per claim" value={`${formatZir(s.claimUZIR)} ZIR`} />
          </div>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <Field label="ZIR per claim"><Input value={claimZir} onChange={(e) => setClaimZir(e.target.value)} className="w-28" /></Field>
            <Button variant="secondary" disabled={busy} onClick={() => set({ claimZir: Number(claimZir) })}>Set amount</Button>
            {s.active
              ? <Button variant="secondary" disabled={busy} onClick={() => set({ active: false })}>Deactivate</Button>
              : <Button variant="primary" disabled={busy} onClick={() => set({ active: true })}>Activate</Button>}
          </div>
        </>
      )}
    </Card>
  );
}


// Steward direct position assignment. At genesis the steward anchor-reserve wallet owns all 512 positions
// and their backing ZIR. The steward can transfer one position (single) or many (batch) to a chosen
// address in a single signed operation. On transfer a fresh one-year linear vesting of each position's
// allocation opens to the new owner, funded by the reserve wallet; the position also earns ongoing ZIR
// as a Resonator, separately. This is the direct-assignment path (no code redemption required).
function StewardPositionTransferCard() {
  const toast = useToast();
  const [seatIds, setSeatIds] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const ids = seatIds.split(/[\s,]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
  const toClean = to.trim();
  const toValid = isValidAddress(toClean);
  const canSubmit = ids.length > 0 && toValid;

  function requestTransfer() {
    if (ids.length === 0) { toast.push("Enter one or more seat ids, e.g. A-009 or A-009, B-017", "warn"); return; }
    if (!toValid) { toast.push("Enter a valid destination ZIR address", "warn"); return; }
    setConfirm(true);
  }

  async function transfer() {
    setBusy(true);
    try {
      const res = await NodeApi.anchorTransferPositions(ids, toClean);
      if (!res.ok) throw new Error(res.reason ?? "position transfer rejected");
      toast.push(`${(res.seatIds ?? ids).length} position(s) transferred. ${formatZir(res.vestingUZIR ?? 0)} ZIR now vests to the new owner over one year.`);
      setSeatIds(""); setTo(""); setConfirm(false);
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "could not transfer positions", "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <ConfirmModal open={confirm} onClose={() => setConfirm(false)} onConfirm={transfer} busy={busy} title="Transfer anchor positions" confirmLabel="Sign transfer">
        <p>Transfer {ids.length} position{ids.length === 1 ? "" : "s"} (<Mono>{ids.join(", ")}</Mono>) to <Mono>{shortAddress(toClean)}</Mono>.</p>
        <p>Each position carries its class, ZTI standing, weight, and ZIR allocation. A one-year linear vesting of the allocation opens to the new owner from the anchor-reserve wallet. This is a signed, public action and cannot be undone.</p>
      </ConfirmModal>
      <div className="mb-2 flex items-center gap-2"><AnchorIcon size={16} className="text-[var(--teal)]" /><h3 className="text-sm font-semibold">Assign anchor positions</h3></div>
      <p className="text-xs text-muted">The steward holds all 512 anchor positions at genesis. Transfer one (single) or several (batch) to a chosen wallet in one signed operation. Each position carries its class, ZTI standing, weight, and ZIR allocation; on transfer a one-year linear vesting of the allocation opens to the new owner, released gradually from the anchor-reserve wallet. Use this to assign a seat to a confirmed contributor from the contributions queue above.</p>
      <div className="mt-3 grid gap-2">
        <Input className="mono" placeholder="Seat ids, e.g. A-009 or A-009, B-017, C-040" value={seatIds} onChange={(e) => setSeatIds(e.target.value)} />
        <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
          <Input className="mono" placeholder="Destination zir1..." value={to} onChange={(e) => setTo(e.target.value)} />
          <Button variant="primary" disabled={busy || !canSubmit} onClick={requestTransfer}>Transfer positions</Button>
        </div>
        {toClean && !toValid && <p className="text-[11px] text-[var(--warn)]">That is not a valid ZIR address.</p>}
        {ids.length > 0 && <p className="text-[11px] text-faint">{ids.length} position{ids.length === 1 ? "" : "s"} ready: <span className="mono">{ids.join(", ")}</span></p>}
      </div>
    </Card>
  );
}

// Inline note shown at the top of the steward panel when the active wallet is a steward wallet but the
// node is not running with that steward key. Steward ACTIONS are loopback/founder-gated by the node, so
// signed routes (assign, transfer-positions, seed-resonators, models, settle) would return 403 until the
// node itself runs with the steward key. The panel stays visible (read-only) so the steward can see the
// full surface and understand what to do.
function StewardGatingNote({ gated, kind, address }: { gated: boolean; kind: StewardKind; address: string | null }) {
  const walletLabel = kind === "anchor-reserve" ? "anchor-reserve steward wallet" : kind === "founder" ? "founder steward wallet" : "steward wallet";
  if (!gated) {
    return (
      <Card className="border-[color-mix(in_srgb,var(--teal)_30%,var(--border))] bg-[color-mix(in_srgb,var(--teal)_6%,transparent)]">
        <div className="flex items-center gap-2 text-[var(--teal)]"><ShieldCheck size={16} /><h3 className="text-sm font-semibold">Steward wallet active</h3></div>
        <p className="mt-1 text-xs text-muted">This is the {walletLabel}{address ? <> (<span className="mono">{shortAddress(address)}</span>)</> : null}, and the node accepts steward actions. Assignment, position transfer, model distribution, resonator seeding, and coordination settlement are live below.</p>
      </Card>
    );
  }
  return (
    <Card className="border-[color-mix(in_srgb,var(--warn)_32%,var(--border))] bg-[color-mix(in_srgb,var(--warn)_7%,transparent)]">
      <div className="flex items-center gap-2 text-[var(--warn)]"><AlertTriangle size={16} /><h3 className="text-sm font-semibold">Read-only: run your node with the steward key</h3></div>
      <p className="mt-1 text-xs text-muted">
        This browser holds the {walletLabel}{address ? <> (<span className="mono">{shortAddress(address)}</span>)</> : null}, so the full steward surface is shown. Steward ACTIONS are gated by the node itself, not the browser: the node must be running with the steward key for it to sign and accept these operations. Right now the connected node does not hold that key, so assign, transfer-positions, seed-resonators, model, and settle calls will be refused (403).
      </p>
      <p className="mt-2 text-xs text-muted">
        To act, start the ZIRA node with the steward key set in its environment, for example the anchor-reserve key as <span className="mono">ZIRA_ANCHOR_RESERVE_KEY</span> (for anchor position assignment and transfer), or run the node under the founder identity, then point this Console at that node. The controls below stay visible so you can review the positions and the exact action you will take once the node is keyed.
      </p>
    </Card>
  );
}

// Steward: (re)seed the network + 512 anchor Resonators and re-key any whose anchor position changed
// owner. Drives POST /founder/seed-resonators (gated to the steward/founder identity on the node).
function StewardResonatorSeedCard({ gated }: { gated: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<string>("");

  async function seed() {
    setBusy(true);
    try {
      const res = await NodeApi.seedStewardResonators();
      if (res.error) throw new Error(res.error);
      const parts = `${res.networkResonators} network · ${res.anchorResonators} anchor`;
      setLast(parts);
      toast.push(`Steward resonators seeded: ${parts}.`);
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "could not seed resonators", "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="mb-2 flex items-center gap-2"><Sparkles size={16} className="text-[var(--indigo)]" /><h3 className="text-sm font-semibold">Seed steward resonators</h3></div>
      <p className="text-xs text-muted">(Re)publish the steward/founder network Resonators and the 512 anchor Resonators, and re-key any whose anchor position changed owner. Deterministic and idempotent, so it is safe to run after assigning positions. Resonator records are soft state, so this does not change consensus or the genesis hash.</p>
      {gated && <p className="mt-2 rounded-lg border border-[color-mix(in_srgb,var(--warn)_28%,var(--border))] bg-[color-mix(in_srgb,var(--warn)_7%,transparent)] p-2 text-[11px] text-muted">Read-only: the connected node is not running with the steward key, so seeding will be refused (403). Run the node with the steward key, then seed.</p>}
      <Button variant="primary" className="mt-3" onClick={() => void seed()} disabled={busy}><Sparkles size={14} /> Seed / re-key resonators</Button>
      {last && <p className="mt-2 text-[11px] text-faint">Last run: {last}.</p>}
    </Card>
  );
}

// Steward: settle a funded query's multi-LLM coordination payout. Splits a funded budget across the
// models/Resonators that answered, weighted by domain ZTI x confidence, with the small steward-ops
// share. Drives POST /query/settle (founder-gated; the funding wallet is the node identity).
function StewardSettleCard({ gated }: { gated: boolean }) {
  const toast = useToast();
  const [queryId, setQueryId] = useState("");
  const [budget, setBudget] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);

  const id = queryId.trim();
  const b = Number(budget);
  const budgetValid = Number.isFinite(b) && b > 0;
  // The protocol coordination split (PROTOCOL.COORD_SPLIT) always sums to 1, so we can preview each slice
  // of the entered budget before signing, mirroring the reserve schedule's installment preview.
  const split = PROTOCOL.COORD_SPLIT;
  const slices = budgetValid ? [
    { label: "Contributors", share: split.CONTRIBUTORS },
    { label: "Network", share: split.NETWORK },
    { label: "Resonator pool", share: split.RESONATOR_POOL },
    { label: "Burn", share: split.BURN },
  ].map((s) => ({ ...s, zir: b * s.share })) : [];

  function requestSettle() {
    if (!id) { toast.push("Enter the query id to settle.", "warn"); return; }
    if (!budgetValid) { toast.push("Enter a positive ZIR budget to split.", "warn"); return; }
    setConfirm(true);
  }

  async function settle() {
    setBusy(true);
    try {
      const res = await NodeApi.settleQueryCoordination(id, b);
      if (!res.ok) throw new Error(res.reason ?? "settlement rejected");
      const paid = (res.payouts ?? []).reduce((sum, p) => sum + (p.amountUZIR ?? 0), 0);
      toast.push(`Settled ${formatZir(paid)} ZIR across ${(res.payouts ?? []).length} coordinating contributor(s) (models + Resonators).`);
      setQueryId(""); setBudget(""); setConfirm(false);
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "could not settle coordination", "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <ConfirmModal open={confirm} onClose={() => setConfirm(false)} onConfirm={settle} busy={busy} title="Settle coordination payout" confirmLabel="Sign settlement">
        <p>Split <Mono>{budget} ZIR</Mono> for query <Mono>{id}</Mono> across the contributors that served it. The funding wallet is the node identity. This is a signed, public action.</p>
        <div className="rounded-lg border border-hairline bg-base p-2.5">
          {slices.map((s) => (
            <div key={s.label} className="flex items-center justify-between py-0.5 text-xs">
              <span className="text-faint">{s.label} <span className="text-faint">{Math.round(s.share * 100)}%</span></span>
              <span className="mono text-text">{s.zir.toLocaleString(undefined, { maximumFractionDigits: 2 })} ZIR</span>
            </div>
          ))}
        </div>
      </ConfirmModal>
      <div className="mb-2 flex items-center gap-2"><Coins size={16} className="text-[var(--teal)]" /><h3 className="text-sm font-semibold">Settle coordination</h3></div>
      <p className="text-xs text-muted">The field answers by having many models and autonomous Resonators coordinate. Each Resonator holds its own ZIR, spends it to coordinate on a query or task, and earns ZTI and learning from verified results; miners run and verify that coordination. This settles a specific funded budget, splitting it across the contributors that served the query by domain ZTI &times; confidence, the protocol split (contributors, network, resonator pool, ecosystem, and burn). The funding wallet is the node identity, which must hold the budget.</p>
      {gated && <p className="mt-2 rounded-lg border border-[color-mix(in_srgb,var(--warn)_28%,var(--border))] bg-[color-mix(in_srgb,var(--warn)_7%,transparent)] p-2 text-[11px] text-muted">Read-only: the connected node is not a founder node, so settlement will be refused (403). Run the node under the steward/founder identity to settle.</p>}
      <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
        <Input className="mono" placeholder="Query id" value={queryId} onChange={(e) => setQueryId(e.target.value)} />
        <Input className="mono w-40" placeholder="Budget ZIR" value={budget} onChange={(e) => setBudget(e.target.value)} />
      </div>
      {budget.trim() && !budgetValid && <p className="mt-1 text-[11px] text-[var(--warn)]">Enter a positive ZIR budget.</p>}
      <Button variant="primary" className="mt-2" onClick={requestSettle} disabled={busy || !id || !budgetValid}><Coins size={14} /> Settle payout</Button>
    </Card>
  );
}
