// apps/console/src/app/Resonators.tsx
// User-owned Resonators are a preview of what is coming. A Resonator will be your own AI agent on the
// network that works within limits you set and earns ZIR. Until that ships, creation is gated off and
// this page reads as a clear "coming soon". Today's resonators are the network's coordination agents,
// visible in Discover. The builder machinery below stays intact, reachable only when CREATION_LIVE is true.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Bot, Sparkles, Wallet, Activity, Coins, Search, Check, X } from "lucide-react";
import { DOMAINS, DOMAIN_META, generateKeypair, PROTOCOL, type Resonator, type Domain, type SpendLimits } from "@zira/protocol";
import { Card, Button, Input, Textarea, Badge, Meter, Modal, Field, Select, PageHeader, useToast, EmptyState, Spinner, LoadingState, ErrorState, useSlowHint } from "../components/ui";
import { ResonanceField } from "../components/ResonanceField";
import { useZira } from "../store/useZira";
import { useUnlock } from "../store/useUnlock";
import { makeSignedTx, zirToUzir } from "../lib/tx";
import { formatZir, ztiLabel } from "../lib/format";
import { featureEnabled } from "../lib/phase";
import { NodeApi } from "../lib/nodeApi";

const MIN_CREATE_FUND_ZIR = 10;
const MIN_RESONANCE_FUND_ZIR = 20;

// User-owned Resonators are not live yet. This single flag hard-gates every creation path (the New
// Resonator button, the starter cards, the empty-state CTA, and openBuilder) into a "coming soon"
// state, independent of the node's runtime creationOpen signal. Flip to true when the feature ships.
const CREATION_LIVE = false;

function clampNum(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
}

// A single, consistent status read derived from the same fields the detail page uses, so the badge text
// and tone never disagree and the out-of-funds case is surfaced rather than hidden behind "resonant".
function resonatorStatus(r: Resonator): { label: string; tone: "teal" | "warn" | "neutral" } {
  if (r.resonanceEnabled && r.balanceUZIR > 0) return { label: "Resonant", tone: "teal" };
  if (r.resonanceEnabled) return { label: "Needs funds", tone: "warn" };
  return { label: "Paused", tone: "neutral" };
}

// A compact, aligned stat tile so balance/earned/spent/tasks read as a scannable dashboard row rather
// than low-contrast inline label:value spans. Kept local per the shared-file edit constraint.
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-hairline bg-base p-2">
      <div className="text-[11px] uppercase tracking-wide text-faint">{label}</div>
      <div className="mono mt-0.5 text-sm text-text">{value}</div>
    </div>
  );
}

type ListSort = "zti" | "balance" | "earned" | "jobs" | "recent";

// Starter purposes. Picking one prefills the builder so a normal user can see, in one click, what a
// Resonator can actually do for them. They can edit anything afterward; nothing here is locked in.
interface Starter {
  key: string;
  name: string;
  purpose: string;
  prompt: string;
  domains: Domain[];
  blurb: string;
}
const STARTERS: Starter[] = [
  {
    key: "research",
    name: "Research analyst",
    purpose: "researches a topic and returns a sourced summary",
    prompt: "You are a careful research analyst. Gather what is known, weigh the evidence, and answer concisely with sources. Say plainly when something is uncertain.",
    domains: ["language", "reasoning"],
    blurb: "Digs into a question and comes back with a clear, sourced answer.",
  },
  {
    key: "code",
    name: "Code helper",
    purpose: "reviews code and explains fixes",
    prompt: "You are a precise code reviewer. Find bugs, explain the fix, and cite the exact lines. Prefer small, safe changes and clear reasoning.",
    domains: ["code", "reasoning"],
    blurb: "Reviews code, finds bugs, and explains the fix line by line.",
  },
  {
    key: "market",
    name: "Market watcher",
    purpose: "tracks markets and flags what changed",
    prompt: "You are a market watcher. Track prices and conditions, summarize what changed and why it matters, and avoid hype. Be specific with numbers.",
    domains: ["finance", "currency"],
    blurb: "Keeps an eye on markets and tells you what moved and why.",
  },
  {
    key: "writer",
    name: "Writing partner",
    purpose: "drafts and edits clear writing",
    prompt: "You are a sharp writing partner. Draft, tighten, and edit text for clarity and tone. Keep the voice human and never use an em dash.",
    domains: ["creative", "language"],
    blurb: "Drafts and edits writing so it reads clearly and sounds human.",
  },
  {
    key: "tutor",
    name: "Subject tutor",
    purpose: "explains hard topics step by step",
    prompt: "You are a patient tutor. Explain ideas step by step, check understanding, and give worked examples. Adapt to the learner's level.",
    domains: ["education", "reasoning"],
    blurb: "Breaks down hard topics with patient, step-by-step explanations.",
  },
  {
    key: "security",
    name: "Security reviewer",
    purpose: "reviews systems for risks",
    prompt: "You are a thorough security reviewer. Model threats, point out weak spots, and rank them by impact. Be concrete and cite where the risk lives.",
    domains: ["security", "code"],
    blurb: "Looks for weak spots and ranks the real risks by impact.",
  },
];

// A one-line, plain-language read on what a Resonator is currently doing or needs.
function statusLine(r: Resonator): string {
  if (!r.resonanceEnabled) return "Paused. It answers only when you call it.";
  if (r.balanceUZIR <= 0) return "On, but out of funds. Add ZIR so it can work.";
  if (r.jobsDone > 0) return `Working. ${r.jobsDone} ${r.jobsDone === 1 ? "task" : "tasks"} done so far.`;
  return "On and ready. Earning trust from verified work.";
}

export function Resonators() {
  // read only what we need, so background polling does not re-render and disturb the builder
  const client = useZira((s) => s.client);
  const address = useZira((s) => s.address);
  const phase = useZira((s) => s.phase);
  const nav = useNavigate();
  const [list, setList] = useState<Resonator[]>([]);
  const [building, setBuilding] = useState(false);
  const [starter, setStarter] = useState<Starter | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [q, setQ] = useState("");
  const [domain, setDomain] = useState<Domain | "">("");
  const [sort, setSort] = useState<ListSort>("zti");
  // Case B: creating a new Resonator is frozen network-wide until all anchors are secured. Reflect the node's
  // canonical status so the create actions disable with a reason instead of failing on publish. Defaults open.
  const [creationOpen, setCreationOpen] = useState(true);
  const enabled = featureEnabled(phase, "resonators");
  const slow = useSlowHint(loading && !loadedOnce);
  const mounted = useRef(true);

  // Search, filter, and sort the owner's own Resonators client-side. The owner already has the full list
  // in hand, so this is instant and mirrors the affordances the Discover page offers for everyone else's.
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = list.filter((r) => {
      if (domain && !r.domains.includes(domain)) return false;
      if (needle && !(`${r.name} ${r.purpose}`.toLowerCase().includes(needle))) return false;
      return true;
    });
    const by: Record<ListSort, (a: Resonator, b: Resonator) => number> = {
      zti: (a, b) => b.zti - a.zti,
      balance: (a, b) => b.balanceUZIR - a.balanceUZIR,
      earned: (a, b) => b.totalEarnedUZIR - a.totalEarnedUZIR,
      jobs: (a, b) => b.jobsDone - a.jobsDone,
      recent: (a, b) => b.updatedAt - a.updatedAt,
    };
    return [...out].sort(by[sort]);
  }, [list, q, domain, sort]);
  const filtersActive = Boolean(q || domain || sort !== "zti");

  async function load() {
    if (!client || !address) { setList([]); return; }
    setLoading(true);
    setError("");
    try {
      const next = await client.listResonators(address);
      if (mounted.current) setList(next);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "Could not load your Resonators. Check the node connection and retry.");
    } finally {
      if (mounted.current) { setLoading(false); setLoadedOnce(true); }
    }
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; /* eslint-disable-next-line */ }, [client, address]);
  useEffect(() => {
    let live = true;
    NodeApi.pricing().then((p) => { if (live && p.resonatorCreationOpen !== undefined) setCreationOpen(p.resonatorCreationOpen); }).catch(() => { /* keep default open */ });
    return () => { live = false; };
  }, []);

  function openBuilder(s: Starter | null) { if (!CREATION_LIVE) return; setStarter(s); setBuilding(true); }

  if (!enabled) {
    return <div className="p-6"><EmptyState title="Resonators are almost here" hint="Resonators turn on with the economy. You can explore the field and your wallet now."><div className="flex flex-col items-center"><ResonanceField size={132} live={false} intensity={0.24} /><div className="mt-3 text-[11px] uppercase tracking-[0.16em] text-faint">coming soon</div></div></EmptyState></div>;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-6">
      <Card className="field-hero">
        <PageHeader
          badge={<Badge tone="indigo">coming soon</Badge>}
          title="Your own Resonator is coming soon."
          description="A Resonator will be your own AI agent on the network. It works within the limits you set and earns ZIR. This is coming soon. Today, resonators are the network's coordination agents, and you can see them in Discover."
          action={CREATION_LIVE
            ? <Button variant="primary" onClick={() => openBuilder(null)} disabled={!address || !creationOpen} title={!creationOpen ? "Creating new Resonators is paused until every anchor is secured. Your existing Resonators keep working." : undefined}><Plus size={15} /> New Resonator</Button>
            : <Button variant="primary" disabled title="Creating your own Resonator is coming soon."><Plus size={15} /> Coming soon</Button>}
        />
        {CREATION_LIVE && !creationOpen && (
          <p className="mt-2 rounded-lg border border-hairline bg-base px-3 py-2 text-xs text-muted">
            Creating new Resonators is paused until every anchor position is secured. Your existing Resonators keep coordinating and earning as usual, and you can still fund, pause, or manage them.
          </p>
        )}
        <Lifecycle />
      </Card>

      <div>
        <div className="mb-2 flex items-center gap-2">
          <Sparkles size={15} className="text-[var(--teal)]" />
          <h3 className="text-sm font-semibold">A preview of what yours could do</h3>
          <span className="text-xs text-faint">these purposes go live when Resonators arrive</span>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {STARTERS.map((s) => (
            <button key={s.key} onClick={() => openBuilder(s)} disabled={!CREATION_LIVE} title="Coming soon"
              className="group rounded-xl border border-hairline bg-base p-3 text-left transition-colors hover:border-[var(--teal)] disabled:cursor-not-allowed disabled:opacity-60">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-text">{s.name}</span>
                {CREATION_LIVE ? <Plus size={14} className="text-faint group-hover:text-[var(--teal)]" /> : <span className="text-[10px] uppercase tracking-wide text-faint">Soon</span>}
              </div>
              <p className="mt-1 text-xs text-muted">{s.blurb}</p>
              <div className="mt-2 flex flex-wrap gap-1">
                {s.domains.map((d) => <Badge key={d} tone="indigo" className="text-[10px]">{DOMAIN_META[d].label}</Badge>)}
              </div>
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Your Resonators</h3>
        <span className="flex items-center gap-2 text-xs text-faint">{loading && loadedOnce && <Spinner size={13} />}{filtersActive ? `${filtered.length} of ${list.length}` : `${list.length} ${list.length === 1 ? "Resonator" : "Resonators"}`}</span>
      </div>
      <p className="text-xs text-faint">Trust (ZTI) is <span className="text-text">earned, never bought</span>: it only grows from real, verified work. Adding ZIR gives a Resonator more room to work and coordinate, but it does not buy trust, and it can never spend beyond the limits you set.</p>
      {list.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1">
            <Search size={15} className="absolute left-2.5 top-2.5 text-faint" />
            <Input className="pl-8" placeholder="Search name or purpose" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Select value={sort} onChange={(e) => setSort(e.target.value as ListSort)} className="w-auto">
            <option value="zti">Most trusted</option>
            <option value="balance">Highest balance</option>
            <option value="earned">Most earned</option>
            <option value="jobs">Most tasks done</option>
            <option value="recent">Recently updated</option>
          </Select>
          <Select value={domain} onChange={(e) => setDomain(e.target.value as Domain | "")} className="w-auto">
            <option value="">All domains</option>
            {DOMAINS.map((d) => <option key={d} value={d}>{DOMAIN_META[d].label}</option>)}
          </Select>
          {filtersActive && (
            <Button variant="ghost" className="px-2.5 py-1.5 text-xs" onClick={() => { setQ(""); setDomain(""); setSort("zti"); }} title="Clear all filters">
              <X size={13} /> Clear filters
            </Button>
          )}
        </div>
      )}
      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {loading && !loadedOnce ? (
        <LoadingState label="Loading your Resonators..." slow={slow} />
      ) : list.length === 0 ? (
        CREATION_LIVE ? (
          <EmptyState title="No Resonators yet" hint="Pick a purpose above or start from scratch. Your worker gets its own key and wallet, created right here on your device."
            action={<Button variant="primary" onClick={() => openBuilder(null)} disabled={!address || !creationOpen} title={!creationOpen ? "Creating new Resonators is paused until every anchor is secured." : undefined}><Plus size={15} /> Create your first Resonator</Button>}>
            <Bot size={40} className="text-muted" />
          </EmptyState>
        ) : (
          <EmptyState title="Your own Resonator is coming soon" hint="Creating and funding your own Resonator is not live yet. Today, resonators are the network's coordination agents. You can explore them in Discover while this feature is on the way.">
            <div className="flex flex-col items-center">
              <ResonanceField size={140} live={false} intensity={0.24} />
              <div className="mt-3 text-[11px] uppercase tracking-[0.16em] text-faint">coming soon</div>
            </div>
          </EmptyState>
        )
      ) : filtered.length === 0 ? (
        <EmptyState title="No Resonators match" hint="No Resonator matches your search or filters. Clear them to see all of yours."
          action={<Button variant="secondary" onClick={() => { setQ(""); setDomain(""); setSort("zti"); }}><X size={14} /> Clear filters</Button>}>
          <Search size={36} className="text-muted" />
        </EmptyState>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {filtered.map((r) => {
            const st = resonatorStatus(r);
            return (
              <Card key={r.id} className="cursor-pointer hover:border-hairline-strong">
                <div onClick={() => nav(`/resonators/${r.id}`)}>
                  <div className="flex items-center justify-between">
                    <span className="font-semibold">{r.name}</span>
                    <Badge tone={st.tone}>{st.label}</Badge>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted">{r.purpose}</p>
                  <Meter value={r.zti} label={`Trust, ${ztiLabel(r.zti)}`} className="my-2" />
                  <div className="grid grid-cols-2 gap-2">
                    <Stat label="Balance" value={formatZir(r.balanceUZIR)} />
                    <Stat label="Earned" value={formatZir(r.totalEarnedUZIR)} />
                    <Stat label="Spent" value={formatZir(r.totalSpentUZIR)} />
                    <Stat label="Tasks" value={String(r.jobsDone)} />
                  </div>
                  <p className="mt-2 line-clamp-1 text-[11px] text-faint">{statusLine(r)}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {r.domains.map((d) => <Badge key={d} tone="indigo" className="text-[10px]">{DOMAIN_META[d]?.label ?? d}</Badge>)}
                    {r.listed && <Badge tone="teal" className="text-[10px]">in Discover</Badge>}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {building && <ResonatorBuilder starter={starter} onClose={() => setBuilding(false)} onCreated={() => { setBuilding(false); void load(); }} />}
    </div>
  );
}

// The four-step lifecycle, shown as a compact strip so the whole idea reads at a glance.
function Lifecycle() {
  const steps = [
    { icon: Plus, title: "Create", body: "Give it a character and a purpose. It gets its own wallet." },
    { icon: Wallet, title: "Fund", body: "Add ZIR and set spend limits. It never spends past them." },
    { icon: Activity, title: "It works, earns trust", body: "It coordinates with the field and earns ZTI from verified work." },
    { icon: Coins, title: "It earns ZIR", body: "Trusted Resonators get hired for tasks. You can withdraw earnings." },
  ];
  return (
    <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {steps.map((s, i) => (
        <div key={s.title} className="rounded-lg border border-hairline bg-base p-3">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full border border-hairline text-[11px] text-[var(--teal)]">{i + 1}</span>
            <s.icon size={14} className="text-[var(--teal)]" />
            <span className="text-xs font-semibold text-text">{s.title}</span>
          </div>
          <p className="mt-1.5 text-[11px] text-muted">{s.body}</p>
        </div>
      ))}
    </div>
  );
}

// Top level so it keeps its own state. Defining it inside the page would remount it (and wipe the
// form) on every background refresh, which is the bug this fixes.
function ResonatorBuilder({ starter, onClose, onCreated }: { starter: Starter | null; onClose: () => void; onCreated: () => void }) {
  const client = useZira((s) => s.client);
  const address = useZira((s) => s.address);
  const balanceUZIR = useZira((s) => s.balanceUZIR);
  const network = useZira((s) => s.network);
  const mode = useZira((s) => s.mode);
  const request = useUnlock((s) => s.request);
  const toast = useToast();
  const [step, setStep] = useState(0);
  // The currently selected template inside the builder. Picking one fills/changes the purpose and the
  // other identity/skill fields, so "Start from a purpose" updates live. Edits afterward are preserved
  // until another template is picked. Starting "from scratch" (no starter) leaves this null.
  const [activeStarter, setActiveStarter] = useState<Starter | null>(starter);
  const [name, setName] = useState(starter?.name ?? "");
  const [purpose, setPurpose] = useState(starter?.purpose ?? "");
  const [prompt, setPrompt] = useState(starter?.prompt ?? "");
  const [domains, setDomains] = useState<Domain[]>(starter?.domains ?? ["general"]);
  const [model, setModel] = useState("zira-adaptive-field");
  const [listed, setListed] = useState(true);
  const [funding, setFunding] = useState("75");
  const [perTx, setPerTx] = useState("10");
  const [perDay, setPerDay] = useState("60");
  const [minZti, setMinZti] = useState("0.2");
  const [coordinationDepth, setCoordinationDepth] = useState("2");
  const [learningSpeed, setLearningSpeed] = useState("2");
  const [evidenceDepth, setEvidenceDepth] = useState("2");
  const [resonance, setResonance] = useState(true);
  const [busy, setBusy] = useState(false);

  const coordinationN = clampNum(Number(coordinationDepth), 1, 5);
  const learningN = clampNum(Number(learningSpeed), 1, 5);
  const evidenceN = clampNum(Number(evidenceDepth), 1, 5);
  const minZtiN = clampNum(Number(minZti), 0, 1);
  const capabilityMultiplier = 1 + coordinationN * 0.35 + learningN * 0.25 + evidenceN * 0.22 + domains.length * 0.08 + minZtiN * 0.75;
  const dynamicTaskFloorZir = Math.ceil(3 * capabilityMultiplier);
  const recommendedFundingZir = Math.ceil(Math.max(
    MIN_CREATE_FUND_ZIR,
    dynamicTaskFloorZir * (resonance ? coordinationN + evidenceN : 1) + learningN * 6,
  ));
  const recommendedDailyZir = Math.ceil(dynamicTaskFloorZir * Math.max(2, coordinationN + learningN));

  // Live, per-field validation so the user fixes funding before reaching step 3 instead of only after submit.
  const fundingZirNum = Number(funding);
  const perTxZirNum = Number(perTx);
  const fundingBelowMin = !Number.isFinite(fundingZirNum) || fundingZirNum < (resonance ? MIN_RESONANCE_FUND_ZIR : MIN_CREATE_FUND_ZIR);
  const fundingBelowRecommended = Number.isFinite(fundingZirNum) && fundingZirNum >= MIN_CREATE_FUND_ZIR && fundingZirNum < recommendedFundingZir;
  const perTxBelowFloor = listed && Number.isFinite(perTxZirNum) && perTxZirNum < dynamicTaskFloorZir;

  function toggleDomain(d: Domain) {
    setDomains((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]);
  }

  // Apply a template: fill the purpose and the other identity/skill fields from it. Selecting the active
  // template again clears it back to "from scratch" and empties those fields, so the picker is a toggle.
  function applyStarter(s: Starter) {
    if (activeStarter?.key === s.key) {
      setActiveStarter(null);
      setName(""); setPurpose(""); setPrompt(""); setDomains(["general"]);
      return;
    }
    setActiveStarter(s);
    setName(s.name);
    setPurpose(s.purpose);
    setPrompt(s.prompt);
    setDomains(s.domains);
  }

  async function create() {
    if (!client || !address) return;
    const fundingZir = Number(funding);
    const perTxZir = Number(perTx);
    if (!Number.isFinite(fundingZir) || fundingZir < MIN_CREATE_FUND_ZIR) {
      toast.push(`A Resonator needs at least ${MIN_CREATE_FUND_ZIR} ZIR to start.`, "warn");
      setStep(2);
      return;
    }
    if (resonance && fundingZir < MIN_RESONANCE_FUND_ZIR) {
      toast.push(`Resonance needs at least ${MIN_RESONANCE_FUND_ZIR} ZIR so the Resonator can learn and coordinate.`, "warn");
      setStep(2);
      return;
    }
    if (resonance && fundingZir < perTxZir) {
      toast.push("Starting funding must cover at least one coordination spend.", "warn");
      setStep(2);
      return;
    }
    if (listed && perTxZir < dynamicTaskFloorZir) { toast.push("Per task cap must cover the dynamic task floor.", "warn"); setStep(2); return; }
    if (mode === "node" && zirToUzir(fundingZir) > balanceUZIR) {
      toast.push("Your wallet does not have enough ZIR for the starting balance.", "warn");
      setStep(2);
      return;
    }
    // No repeated templates: a listed Resonator needs its own name, not a verbatim template clone.
    if (listed) {
      try {
        const existing = await client.getMarketplace({ sort: "zti", limit: 200 });
        const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
        if (existing.some((l) => norm(l.name) === norm(name))) {
          toast.push("That name is already on the field. Give your Resonator its own name so it is not a duplicate of the template.", "warn");
          setStep(0);
          return;
        }
      } catch { /* the node still enforces name uniqueness if this pre-check cannot run */ }
    }
    const fundUZIR = zirToUzir(fundingZir);
    // A new Resonator must stand up with at least the creation cost as its operating float. The node gates
    // creation on the agent wallet's REAL ledger balance, so we must fund the agent wallet BEFORE publishing
    // the record, and the funding must cover the creation cost.
    if (mode === "node" && fundUZIR < PROTOCOL.RESONATOR_CREATION_COST_UZIR) {
      toast.push(`Fund the Resonator with at least ${formatZir(PROTOCOL.RESONATOR_CREATION_COST_UZIR)} ZIR to create it.`, "warn");
      setStep(2);
      return;
    }
    if (mode === "node") { const ok = await request(); if (!ok) return; }
    setBusy(true);
    try {
      const kp = generateKeypair(); // agent keypair, only address + pubkey leave the browser
      const limits: SpendLimits = { perTxUZIR: zirToUzir(perTxZir), perDayUZIR: zirToUzir(Number(perDay)), minCounterpartyZti: Number(minZti), allowedDomains: domains };

      // 1) Fund the agent wallet FIRST so its ledger balance is in place when the node checks the creation cost.
      if (fundUZIR > 0 && mode === "node") {
        const nonce = await client.getNonce(address);
        const tx = makeSignedTx({ network, to: kp.address, amountUZIR: fundUZIR, nonce, kind: "transfer", memo: "fund " + name });
        const res = await client.submitTx(tx);
        if (!res.accepted) { toast.push("Funding failed: " + (res.reason ?? "unknown"), "danger"); setBusy(false); return; }
      }

      // 2) Publish the signed record; the node reads the agent's funded balance from the ledger and accepts it.
      const created = await client.createResonator({
        owner: address, address: kp.address, name, purpose, systemPrompt: prompt, domains,
        modelPref: model, resonanceEnabled: resonance, spendLimits: limits,
        priceUZIR: zirToUzir(dynamicTaskFloorZir), listed,
        ...({ pubKey: kp.publicKey } as object),
      } as Parameters<typeof client.createResonator>[0]);

      const agentKeys = JSON.parse(localStorage.getItem("zira.agentKeys") || "{}");
      agentKeys[created.id] = kp.privateKey;
      localStorage.setItem("zira.agentKeys", JSON.stringify(agentKeys));

      toast.push("Resonator created" + (fundUZIR > 0 ? " and funded" : ""));
      onCreated();
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "create failed", "danger");
    } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title="Build a Resonator" wide>
      <div className="mb-4 flex items-center">
        {["Identity", "Skills", "Funding", "Resonance"].map((s, i) => {
          const done = i < step;
          const active = i === step;
          return (
            <div key={s} className="flex flex-1 items-center last:flex-none">
              <div className="flex items-center gap-1.5">
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] ${done ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)]" : active ? "border-[var(--accent)] text-[var(--accent)]" : "border-hairline text-faint"}`}>
                  {done ? <Check size={11} /> : i + 1}
                </span>
                <span className={`text-xs ${active ? "font-medium text-text" : done ? "text-muted" : "text-faint"}`}>{s}</span>
              </div>
              {i < 3 && <span className={`mx-2 h-px flex-1 ${done ? "bg-[var(--accent)]" : "bg-hairline"}`} />}
            </div>
          );
        })}
      </div>
      {step === 0 && (
        <div className="space-y-3">
          <div>
            <div className="mb-1.5 flex items-center gap-2 text-xs">
              <Sparkles size={13} className="text-[var(--teal)]" />
              <span className="font-medium text-text">Start from a purpose</span>
              <span className="text-faint">pick one to fill the fields, then edit anything</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {STARTERS.map((s) => (
                <button key={s.key} type="button" onClick={() => applyStarter(s)} title={s.blurb}
                  className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${activeStarter?.key === s.key ? "border-[var(--teal)] bg-[color-mix(in_srgb,var(--teal)_12%,transparent)] text-[var(--teal)]" : "border-hairline text-muted hover:border-hairline-strong hover:text-text"}`}>
                  {s.name}
                </button>
              ))}
            </div>
          </div>
          <p className="text-xs text-faint">Give your Resonator a name and a character. This is who it is and how it answers.</p>
          <Field label="Name" hint="What people see when they find your Resonator.">
            <Input placeholder="For example: Ada, the research analyst" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label="Purpose" hint="One line on what it does for you.">
            <Input placeholder="For example: reviews smart contracts for bugs" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
          </Field>
          <Field label="Personality and instructions" hint="This becomes how it answers, its system prompt.">
            <Textarea placeholder="For example: You are a careful security reviewer. Be concise and cite the exact lines." value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} />
          </Field>
        </div>
      )}
      {step === 1 && (
        <div className="space-y-3">
          <p className="text-xs text-muted">Choose what it is good at. Domains are capability tags for a universal AI field: language, code, vision, audio, video, planning, science, finance, security, and any future modality added to the model swarm.</p>
          <Field label="Skills" hint="Pick the domains where it earns trust.">
            <div className="flex flex-wrap gap-1">
              {DOMAINS.map((d) => (
                <button key={d} onClick={() => toggleDomain(d)} title={DOMAIN_META[d].desc} className={`rounded-full border px-2 py-1 text-xs ${domains.includes(d) ? "border-[var(--teal)] text-[var(--teal)]" : "border-hairline text-muted"}`}>{DOMAIN_META[d].label}</button>
              ))}
            </div>
          </Field>
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Coordination depth" hint="More peers and comparison rounds.">
              <Input type="number" min={1} max={5} value={coordinationDepth} onChange={(e) => setCoordinationDepth(e.target.value)} className="mono" />
            </Field>
            <Field label="Learning speed" hint="How aggressively it spends to improve.">
              <Input type="number" min={1} max={5} value={learningSpeed} onChange={(e) => setLearningSpeed(e.target.value)} className="mono" />
            </Field>
            <Field label="Evidence depth" hint="Independent checks before it trusts an answer.">
              <Input type="number" min={1} max={5} value={evidenceDepth} onChange={(e) => setEvidenceDepth(e.target.value)} className="mono" />
            </Field>
          </div>
          <div className="rounded-lg border border-hairline bg-base p-3 text-xs text-muted">
            <div className="font-medium text-text">Suggested task price</div>
            <p className="mt-1">This Resonator should charge at least <span className="mono text-[var(--teal)]">{dynamicTaskFloorZir} ZIR</span> per task. The price rises with coordination depth, learning speed, evidence depth, domains, and minimum trust.</p>
            <p className="mt-1 text-faint">More funding raises its operating budget, so it can run more checks per task, coordinate with more peers, and build trust faster.</p>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={listed} onChange={(e) => setListed(e.target.checked)} /> Show it in Discover so others can find your Resonator and pay it for tasks</label>
        </div>
      )}
      {step === 2 && (
        <div className="space-y-3">
          <p className="text-xs text-muted">A Resonator needs ZIR before it can coordinate on the field. That starting balance pays for asking miners, comparing answers, collaborating with other Resonators, collecting evidence, signing intelligent agreements, and learning from verified tasks. It can never spend more than the limits you set.</p>
          <Field label="Starting balance" hint={`Minimum ${MIN_CREATE_FUND_ZIR} ZIR. Recommended for these settings: ${recommendedFundingZir} ZIR.`}>
            <div className="flex gap-2">
              <Input placeholder="For example: 50" value={funding} onChange={(e) => setFunding(e.target.value)} className="mono" />
              <Button variant="secondary" type="button" onClick={() => setFunding(String(recommendedFundingZir))} title="Set to the recommended starting balance">Use {recommendedFundingZir}</Button>
            </div>
            {fundingBelowMin ? (
              <p className="mt-1.5 text-[11px] text-[var(--warn)]">Needs at least {resonance ? MIN_RESONANCE_FUND_ZIR : MIN_CREATE_FUND_ZIR} ZIR{resonance ? " so it can learn and coordinate" : ""}.</p>
            ) : fundingBelowRecommended ? (
              <p className="mt-1.5 text-[11px] text-[var(--warn)]">Below the {recommendedFundingZir} ZIR recommended for these settings. It will run, but with less room to coordinate.</p>
            ) : null}
          </Field>
          <div className="rounded-lg border border-hairline bg-base p-3 text-xs text-muted">
            <div className="font-medium text-text">How the balance is used</div>
            <p className="mt-1">With resonance on, the Resonator spends fees to ask the adaptive field, compare convergence and divergence, collect evidence, coordinate with other Resonators, and build ZTI. More funding lets it run more collaboration rounds and training loops, but verified behavior is still what earns standing.</p>
            <p className="mt-1 text-faint">ZTI still starts at 0. It rises only when mining nodes and users produce verifiable outcomes for the Resonator's domains.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Per task cap" hint={`Must cover the suggested price (${dynamicTaskFloorZir} ZIR).`}>
              <div className="flex gap-2">
                <Input placeholder="For example: 5" value={perTx} onChange={(e) => setPerTx(e.target.value)} className="mono" />
                <Button variant="secondary" type="button" onClick={() => setPerTx(String(dynamicTaskFloorZir))} title="Set to the suggested task price">Use {dynamicTaskFloorZir}</Button>
              </div>
              {perTxBelowFloor && <p className="mt-1.5 text-[11px] text-[var(--warn)]">Listed Resonators must charge at least {dynamicTaskFloorZir} ZIR per task.</p>}
            </Field>
            <Field label="Per day cap" hint={`Recommended for these settings: ${recommendedDailyZir} ZIR/day.`}>
              <div className="flex gap-2">
                <Input placeholder="For example: 50" value={perDay} onChange={(e) => setPerDay(e.target.value)} className="mono" />
                <Button variant="secondary" type="button" onClick={() => setPerDay(String(recommendedDailyZir))} title="Set to the recommended per-day cap">Use {recommendedDailyZir}</Button>
              </div>
            </Field>
          </div>
          <Field label="Minimum counterparty trust" hint="0 to 1. It only deals with Resonators above this ZTI.">
            <Input placeholder="For example: 0.2" value={minZti} onChange={(e) => setMinZti(e.target.value)} className="mono" />
          </Field>
        </div>
      )}
      {step === 3 && (
        <div className="space-y-3">
          <p className="text-xs text-muted">The last switch decides whether your Resonator can act on its own in the field.</p>
          <Field label="Resonance">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={resonance} onChange={(e) => setResonance(e.target.checked)} className="mt-1" />
              <span>Switch on resonance. When on, your Resonator can spend its own ZIR to coordinate with other Resonators and the field, inside the limits you set, without asking every time. Those fees are how it learns, gets scored, and becomes useful. When off, it only answers when you call it.</span>
            </label>
          </Field>
          <div className="rounded-lg border border-hairline bg-base p-3 text-xs text-muted">
            <div className="font-medium text-text">Ready to go</div>
            <p className="mt-1">You are creating <span className="text-text">{name || "a Resonator"}</span> with a starting balance of <span className="mono text-[var(--teal)]">{Number(funding) || 0} ZIR</span>, a per task cap of <span className="mono">{Number(perTx) || 0} ZIR</span>, and resonance <span className="text-text">{resonance ? "on" : "off"}</span>. You stay in control: you can pause it, refund it, or withdraw its earnings any time.</p>
          </div>
        </div>
      )}
      <div className="mt-4 flex justify-between">
        <Button variant="ghost" onClick={() => step > 0 ? setStep(step - 1) : onClose()}>{step > 0 ? "Back" : "Cancel"}</Button>
        {step < 3
          ? <Button variant="secondary" onClick={() => setStep(step + 1)} disabled={step === 0 && !name}>Next</Button>
          : <Button variant="primary" onClick={create} disabled={busy || !name}>Create{Number(funding) > 0 ? " and fund" : ""}</Button>}
      </div>
    </Modal>
  );
}
