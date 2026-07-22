// apps/web/src/app/ResonatorDetail.tsx
// A Resonator's profile: identity and character, trust by domain, balance and earnings, activity and
// task history, owner controls, and a chat tab. Everything a user needs to understand and run it.
import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { DOMAINS, DOMAIN_META, keypairFromPrivate, canonical, buildTxBody, hashHex, sign as edSign, type Resonator, type Domain, type SignedTx, type SpendLimits, type Task } from "@zira/protocol";
import { chat } from "../provider/inference";
import { Card, Button, Input, Textarea, Field, Badge, Meter, Tabs, PageHeader, EmptyState, ErrorState, useToast, Spinner } from "../components/ui";
import { useZira } from "../store/useZira";
import { useUnlock } from "../store/useUnlock";
import { formatZir, ztiLabel, shortAddress, timeAgo } from "../lib/format";
import { zirToUzir, makeSignedTx } from "../lib/tx";
import { NodeApi, type ResonatorStats } from "../lib/nodeApi";

const WITHDRAW_FEE_UZIR = 1000; // 0.001 ZIR network fee charged on a withdraw

// Owner management of a Resonator (edit settings, transfer ownership) is not live yet — it ships in a later
// phase alongside resonator creation. Funding and withdrawing stay available. Flip to true to enable.
const RESONATOR_MANAGEMENT_LIVE = false;

// A single, consistent status read shared by the header badge and the Autonomy tile so text and tone can
// never disagree, and the out-of-funds case is surfaced instead of hidden behind a stale status string.
function resonatorStatus(r: Resonator): { label: string; tone: "teal" | "warn" | "neutral" } {
  if (r.resonanceEnabled && r.balanceUZIR > 0) return { label: "Resonant", tone: "teal" };
  if (r.resonanceEnabled) return { label: "Needs funds", tone: "warn" };
  return { label: "Paused", tone: "neutral" };
}

// A compact, aligned stat tile so balance/price/earned/tasks read as a scannable dashboard row rather
// than low-contrast inline label:value spans. Kept local per the shared-file edit constraint.
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-hairline bg-base p-2">
      <div className="text-[11px] uppercase tracking-wide text-faint">{label}</div>
      <div className="mono mt-0.5 text-sm text-text">{value}</div>
    </div>
  );
}

// Plain-language label + balance-impact sign for a wallet event relative to this Resonator's address.
function activityKind(tx: SignedTx, selfAddr: string): { label: string; tone: "teal" | "indigo" | "neutral"; incoming: boolean } {
  const incoming = tx.to === selfAddr;
  if (tx.kind === "reward") return { label: "Earned", tone: "teal", incoming: true };
  if (tx.kind === "agent_spend") return { label: "Coordination fee", tone: "indigo", incoming: false };
  if (tx.kind === "transfer") return incoming ? { label: "Funded", tone: "teal", incoming: true } : { label: "Withdrawn", tone: "neutral", incoming: false };
  return { label: tx.kind, tone: "neutral", incoming };
}

// A plain-language read on what the Resonator is doing right now.
function statusLine(r: Resonator): string {
  if (!r.resonanceEnabled) return "Paused. It answers only when you call it from chat.";
  if (r.balanceUZIR <= 0) return "Resonance is on, but it is out of funds. Add ZIR so it can work.";
  if (r.jobsDone > 0) return `Working. It has completed ${r.jobsDone} ${r.jobsDone === 1 ? "task" : "tasks"} and is earning trust from verified results.`;
  return "On and ready. It is coordinating with the field and earning trust from verified work.";
}

function taskOutcome(status: Task["status"]): { text: string; tone: "teal" | "indigo" | "warn" | "neutral" } {
  switch (status) {
    case "released": case "verified": return { text: "completed", tone: "teal" };
    case "delivered": return { text: "delivered", tone: "indigo" };
    case "assigned": case "pending": case "open": return { text: "in progress", tone: "indigo" };
    case "disputed": return { text: "disputed", tone: "warn" };
    case "expired": case "refunded": return { text: "not completed", tone: "warn" };
    default: return { text: status, tone: "neutral" };
  }
}

export function ResonatorDetail() {
  const { id } = useParams();
  const { client, network, mode, address, balanceUZIR: walletBalanceUZIR } = useZira();
  const nav = useNavigate();
  const request = useUnlock((s) => s.request);
  const toast = useToast();
  const [r, setR] = useState<Resonator | null>(null);
  const [tab, setTab] = useState("activity");
  const [history, setHistory] = useState<SignedTx[]>([]);
  const [withdrawAmt, setWithdrawAmt] = useState("");
  const [fundAmt, setFundAmt] = useState("");
  const [transferTo, setTransferTo] = useState("");

  async function load() {
    if (!client || !id) return;
    const res = await client.getResonator(id);
    if (res) {
      // show the agent's real balance from the ledger, not the stale soft state copy
      try { res.balanceUZIR = await client.getBalanceUZIR(res.address); } catch { /* keep */ }
      client.getTxHistory(res.address, 30).then(setHistory).catch(() => {});
    }
    setR(res);
  }
  useEffect(() => { void load(); const t = setInterval(load, 6000); return () => clearInterval(t); /* eslint-disable-next-line */ }, [client, id]);

  if (!r) {
    return (
      <div className="mx-auto max-w-4xl space-y-4 p-6">
        <PageHeader breadcrumbs={[{ label: "Resonators", onClick: () => nav("/resonators") }, { label: "Loading..." }]} title="Loading this Resonator..." />
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
          <Spinner size={28} />
          <p className="text-sm text-muted">Loading this Resonator...</p>
        </div>
      </div>
    );
  }

  async function toggleResonance() {
    if (!client || !r) return;
    const updated = await client.setResonance(r.id, !r.resonanceEnabled);
    setR(updated);
    toast.push("Resonance " + (updated.resonanceEnabled ? "on" : "off"));
  }

  async function fund() {
    if (!client || !r) return;
    const owner = useZira.getState().address;
    if (!owner) { toast.push("Create a wallet first.", "warn"); return; }
    const amt = Number(fundAmt);
    if (!Number.isFinite(amt) || amt <= 0) { toast.push("Enter an amount greater than 0.", "warn"); return; }
    const amtUZIR = zirToUzir(amt);
    if (mode === "node" && amtUZIR > walletBalanceUZIR) { toast.push("Your wallet does not have that much ZIR.", "warn"); return; }
    if (mode === "node") { const ok = await request(); if (!ok) return; }
    try {
      const nonce = await client.getNonce(owner);
      const tx = makeSignedTx({ network, to: r.address, amountUZIR: amtUZIR, nonce, kind: "transfer", memo: "fund " + r.name });
      await client.fundResonator(r.id, tx);
      toast.push("Funded the Resonator.");
      setFundAmt("");
      await load();
    } catch (e) { toast.push(e instanceof Error ? e.message : "fund failed", "danger"); }
  }

  async function withdraw() {
    if (!client || !r) return;
    const amt = Number(withdrawAmt);
    if (!Number.isFinite(amt) || amt <= 0) { toast.push("Enter an amount greater than 0.", "warn"); return; }
    const amtUZIR = zirToUzir(amt);
    if (amtUZIR + WITHDRAW_FEE_UZIR > r.balanceUZIR) { toast.push("That is more than the Resonator can pay after the network fee.", "warn"); return; }
    const keys = JSON.parse(localStorage.getItem("zira.agentKeys") || "{}");
    const priv = keys[r.id];
    if (!priv) { toast.push("Resonator key not found in this browser.", "danger"); return; }
    if (mode === "node") { const ok = await request(); if (!ok) return; }
    try {
      const kp = keypairFromPrivate(priv);
      const owner = useZira.getState().address!;
      const nonce = await client.getNonce(r.address);
      const body = buildTxBody({ network, from: r.address, fromPubKey: kp.publicKey, to: owner, amountUZIR: amtUZIR, feeUZIR: WITHDRAW_FEE_UZIR, nonce, kind: "transfer", parents: [], timestamp: Date.now(), memo: "withdraw" });
      const c = canonical(body);
      const tx: SignedTx = { ...body, id: hashHex(c), sig: edSign(c, priv) };
      await client.withdrawResonator(r.id, tx);
      toast.push("Withdrawn to your wallet");
      setWithdrawAmt("");
      await load();
    } catch (e) { toast.push(e instanceof Error ? e.message : "withdraw failed", "danger"); }
  }

  // The largest amount the owner can pull out: balance minus the network fee, in whole-ish ZIR.
  function fillMaxWithdraw() {
    if (!r) return;
    const maxUZIR = Math.max(0, r.balanceUZIR - WITHDRAW_FEE_UZIR);
    setWithdrawAmt(String(maxUZIR / 1_000_000));
  }

  async function transfer() {
    if (!client || !r) return;
    if (!address || address !== r.owner) { toast.push("Only the current owner can transfer this Resonator.", "warn"); return; }
    const to = transferTo.trim();
    if (!to.startsWith("zir1") || to === r.owner) { toast.push("Enter a different valid ZIR address (zir1...).", "warn"); return; }
    if (mode === "node") { const ok = await request(); if (!ok) return; }
    try {
      await client.transferResonator(r.id, to);
      toast.push("Resonator transferred. The new owner now controls it.");
      setTransferTo("");
      await load();
    } catch (e) { toast.push(e instanceof Error ? e.message : "transfer failed", "danger"); }
  }

  const status = resonatorStatus(r);
  const fundNum = Number(fundAmt);
  const fundValid = Number.isFinite(fundNum) && fundNum > 0 && (mode !== "node" || zirToUzir(fundNum) <= walletBalanceUZIR);
  const withdrawNum = Number(withdrawAmt);
  const withdrawValid = Number.isFinite(withdrawNum) && withdrawNum > 0 && zirToUzir(withdrawNum) + WITHDRAW_FEE_UZIR <= r.balanceUZIR;

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6">
      <PageHeader
        breadcrumbs={[{ label: "Resonators", onClick: () => nav("/resonators") }, { label: r.name }]}
        title={r.name}
        description={r.purpose}
        badge={<Badge tone={status.tone}>{status.label}</Badge>}
        action={<Button variant="primary" onClick={() => nav(`/?resonator=${encodeURIComponent(r.id)}`)}>Ask in Console</Button>}
      />
      <Card>
        <div className="mono text-xs text-faint">{r.address}</div>
        <p className="mt-2 text-xs text-faint">{statusLine(r)}</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Meter value={r.zti} label={`Overall trust, ${ztiLabel(r.zti)}`} />
          <div className="grid grid-cols-2 gap-2">
            <Stat label="Balance" value={formatZir(r.balanceUZIR)} />
            <Stat label="Task price" value={formatZir(r.priceUZIR)} />
            <Stat label="Earned" value={formatZir(r.totalEarnedUZIR)} />
            <Stat label="Tasks done" value={String(r.jobsDone)} />
          </div>
        </div>
        {Object.keys(r.ztiByDomain ?? {}).length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-xs font-medium text-text">Trust by domain</div>
            <div className="grid gap-2 sm:grid-cols-2">
              {Object.entries(r.ztiByDomain).map(([d, z]) => <Meter key={d} value={z ?? 0} label={DOMAIN_META[d as keyof typeof DOMAIN_META]?.label ?? d} />)}
            </div>
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={toggleResonance}>{r.resonanceEnabled ? "Pause resonance" : "Enable resonance"}</Button>
        </div>
        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
          <div className="rounded-lg border border-hairline bg-base p-2"><div className="text-faint">Autonomy</div><div className="font-medium text-text">{r.resonanceEnabled && r.balanceUZIR > 0 ? "coordinating" : r.resonanceEnabled ? "needs funds" : "paused"}</div></div>
          <div className="rounded-lg border border-hairline bg-base p-2"><div className="text-faint">Trust growth</div><div className="font-medium text-text">{r.zti > 0 ? "earning ZTI" : "starts at 0"}</div></div>
          <div className="rounded-lg border border-hairline bg-base p-2"><div className="text-faint">Routing model</div><div className="font-medium text-text">ZIRA adaptive field</div></div>
        </div>
        <p className="mt-3 text-xs text-faint">Allocate more ZIR when this Resonator should coordinate more deeply: more miner queries, more peer critique, more evidence checks, more collaboration rounds, and more chances to earn ZTI from verified outcomes.</p>
      </Card>

      <Tabs tabs={[{ id: "activity", label: "Activity" }, { id: "tasks", label: "Task history" }, { id: "analytics", label: "Analytics" }, { id: "chat", label: "Chat" }, { id: "controls", label: "Controls" }]} active={tab} onChange={setTab} />

      {tab === "analytics" && <AnalyticsTab id={r.id} />}

      {tab === "tasks" && <TaskHistory resonatorId={r.id} />}

      {tab === "activity" && (
        <Card>
          <h3 className="mb-1 text-sm font-semibold">Activity</h3>
          <p className="mb-2 text-xs text-faint">Every move on this Resonator's wallet: funds you add, fees it spends to coordinate, and rewards it earns.</p>
          {history.length === 0 ? (
            <EmptyState title="No activity yet" hint="With resonance on and a balance, this Resonator is ready to coordinate with the adaptive field when tasks, miners, models, or other Resonators are available." />
          ) : (
            <div className="overflow-hidden rounded-lg border border-hairline">
              <div className="grid grid-cols-[8rem_1fr_auto] gap-2 border-b border-hairline bg-base px-3 py-2 text-[11px] uppercase tracking-wide text-faint">
                <span>Type</span><span>Counterparty</span><span className="text-right">Amount</span>
              </div>
              <div className="divide-y divide-hairline">
                {history.map((tx) => {
                  const k = activityKind(tx, r.address);
                  const other = k.incoming ? tx.from : tx.to;
                  return (
                    <div key={tx.id} className="grid grid-cols-[8rem_1fr_auto] items-center gap-2 px-3 py-2 text-sm">
                      <span><Badge tone={k.tone} className="text-[10px]">{k.label}</Badge></span>
                      <span className="mono truncate text-xs text-faint" title={other}>{shortAddress(other)}</span>
                      <span className="text-right">
                        <span className={`mono tabular-nums ${k.incoming ? "text-[var(--teal)]" : "text-muted"}`}>{k.incoming ? "+" : "-"}{formatZir(tx.amountUZIR)} ZIR</span>
                        <div className="text-[11px] text-faint">{timeAgo(tx.timestamp)}</div>
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </Card>
      )}

      {tab === "chat" && <AgentChat r={r} />}

      {tab === "controls" && (
        <div className="space-y-4">
          <Card>
            <h3 className="mb-1 text-sm font-semibold">Add funds</h3>
            <p className="mb-2 text-xs text-faint">Move ZIR from your wallet into this Resonator so it can coordinate, ask miners, compare independent answers, collaborate with other Resonators, sign agreements, and pay for sub results. Funding increases capacity; ZTI is still earned from verified outcomes.</p>
            <div className="flex gap-2">
              <Input placeholder="Amount in ZIR" value={fundAmt} onChange={(e) => setFundAmt(e.target.value)} className="mono" />
              <Button variant="primary" onClick={fund} disabled={!fundValid}>Fund Resonator</Button>
            </div>
            <p className="mt-2 text-xs text-faint">{mode === "node" ? <>Your wallet holds <span className="mono text-muted">{formatZir(walletBalanceUZIR)} ZIR</span>.</> : "Funds are moved from your wallet to this Resonator."}{fundAmt && !fundValid && <span className="text-[var(--warn)]"> Enter an amount up to your wallet balance.</span>}</p>
          </Card>
          <Card>
            <h3 className="mb-1 text-sm font-semibold">Withdraw earnings</h3>
            <p className="mb-2 text-xs text-faint">Move the Resonator's earnings back to your own wallet.</p>
            <div className="flex gap-2">
              <Input placeholder="Amount in ZIR" value={withdrawAmt} onChange={(e) => setWithdrawAmt(e.target.value)} className="mono" />
              <Button variant="secondary" onClick={fillMaxWithdraw} disabled={r.balanceUZIR <= WITHDRAW_FEE_UZIR}>Max</Button>
              <Button variant="primary" onClick={withdraw} disabled={!withdrawValid}>Withdraw</Button>
            </div>
            <p className="mt-2 text-xs text-faint">A <span className="mono">0.001 ZIR</span> network fee applies. Balance available: <span className="mono text-muted">{formatZir(r.balanceUZIR)} ZIR</span>. Signed locally with the Resonator key held in your browser, then sent to the network.{withdrawAmt && !withdrawValid && <span className="text-[var(--warn)]"> That is more than the Resonator can pay after the fee.</span>}</p>
          </Card>
          {RESONATOR_MANAGEMENT_LIVE && (!address || address === r.owner) && <ResonatorSettings r={r} onSaved={load} />}
          {RESONATOR_MANAGEMENT_LIVE && (!address || address === r.owner) && (
            <Card>
              <h3 className="mb-1 text-sm font-semibold">Transfer ownership</h3>
              <p className="mb-2 text-xs text-faint">Hand this Resonator to another ZIR address. It keeps its earned trust, history, balance, domains, and limits; the new owner controls it from then on. Signed by you as the current owner.</p>
              <div className="flex gap-2">
                <Input placeholder="New owner zir1..." value={transferTo} onChange={(e) => setTransferTo(e.target.value)} className="mono" />
                <Button variant="primary" onClick={transfer} disabled={!transferTo.startsWith("zir1")}>Transfer</Button>
              </div>
            </Card>
          )}
          {!RESONATOR_MANAGEMENT_LIVE && (!address || address === r.owner) && (
            <Card>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">Edit and transfer</h3>
                <Badge tone="neutral">coming soon</Badge>
              </div>
              <p className="mt-1 text-xs text-faint">Editing a Resonator's settings and transferring ownership open in a later phase, alongside creating your own Resonators. Funding and withdrawing are available now.</p>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

// Tasks this owner has run with the Resonator, newest first, with a plain-language outcome.
function TaskHistory({ resonatorId }: { resonatorId: string }) {
  const { client } = useZira();
  const [tasks, setTasks] = useState<Task[] | null>(null);

  useEffect(() => {
    if (!client) { setTasks([]); return; }
    const load = () => client.listResonatorTasks(resonatorId)
      .then((all) => setTasks(all.sort((a, b) => b.createdAt - a.createdAt)))
      .catch(() => setTasks([]));
    void load();
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [client, resonatorId]);

  if (tasks === null) return <Card><Spinner size={20} /></Card>;

  return (
    <Card>
      <h3 className="mb-1 text-sm font-semibold">Task history</h3>
      <p className="mb-2 text-xs text-faint">Tasks you have hired this Resonator for, and how they turned out.</p>
      {tasks.length === 0 ? (
        <p className="text-xs text-muted">No tasks yet. When this Resonator is hired through Discover, each task and its outcome shows up here.</p>
      ) : (
        <div className="divide-y divide-hairline">
          {tasks.map((t) => {
            const o = taskOutcome(t.status);
            return (
              <div key={t.id} className="flex items-start justify-between gap-2 py-2 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-text" title={t.brief}>{t.brief || "Task"}</div>
                  <div className="mt-0.5 text-[11px] text-faint">{DOMAIN_META[t.domain]?.label ?? t.domain} · {timeAgo(t.createdAt)}</div>
                </div>
                <div className="shrink-0 text-right">
                  <Badge tone={o.tone} className="text-[10px]">{o.text}</Badge>
                  <div className="mt-0.5 mono text-[11px] text-faint">{formatZir(t.budgetUZIR)} ZIR</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function AnalyticsTab({ id }: { id: string }) {
  const mode = useZira((s) => s.mode);
  const [stats, setStats] = useState<ResonatorStats | null>(null);
  const [fetchErr, setFetchErr] = useState(false);

  function loadStats() {
    if (mode !== "node") return;
    setFetchErr(false);
    setStats(null);
    NodeApi.resonatorStats(id, "7d").then(setStats).catch(() => setFetchErr(true));
  }
  useEffect(() => { loadStats(); /* eslint-disable-next-line */ }, [id, mode]);

  if (mode !== "node") return <Card><EmptyState title="Analytics need a node" hint="Connect to a node to see assigned, completed, expired, and disputed task counts for this Resonator." /></Card>;
  if (fetchErr) return <Card><ErrorState message="Could not load analytics for this Resonator." onRetry={loadStats} /></Card>;
  if (!stats) return <Card><Spinner size={20} /></Card>;

  const pct = (n: number) => stats.assigned ? `${((n / stats.assigned) * 100).toFixed(1)}%` : "n/a";
  const row = (label: string, value: string) => (
    <div className="flex items-center justify-between py-1.5 text-sm"><span className="text-muted">{label}</span><span className="mono">{value}</span></div>
  );
  return (
    <Card>
      <h3 className="mb-2 text-sm font-semibold">Analytics, last 7 days</h3>
      <div className="divide-y divide-hairline">
        {row("Tasks assigned", String(stats.assigned))}
        {row("Tasks completed", `${stats.completed} (${pct(stats.completed)})`)}
        {row("Tasks expired", `${stats.expired} (${pct(stats.expired)})`)}
        {row("Tasks disputed", `${stats.disputed} (${pct(stats.disputed)})`)}
        {row("Avg response time", stats.avgResponseMs ? `${(stats.avgResponseMs / 60000).toFixed(1)} min` : "n/a")}
        {row("Total earned", `${formatZir(stats.totalEarnedUZIR)} ZIR`)}
      </div>
    </Card>
  );
}

function AgentChat({ r }: { r: Resonator }) {
  const [msgs, setMsgs] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [input, setInput] = useState("");
  const endpoint = localStorage.getItem("zira.provider.endpoint") || "http://localhost:11434/v1";
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the newest tokens in view as the answer streams in.
  useEffect(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight; }, [msgs]);

  async function send() {
    if (busy || !input.trim()) return;
    const q = input.trim();
    setInput("");
    setMsgs((m) => [...m, { role: "user", content: q }, { role: "assistant", content: "" }]);
    setBusy(true);
    try {
      const answer = await chat({
        endpoint, model: r.modelPref || "qwen2.5-coder:14b",
        messages: [{ role: "system", content: r.systemPrompt || "You are a helpful ZIRA Resonator. Never use an em dash." }, ...msgs.map((m) => ({ role: m.role, content: m.content })), { role: "user", content: q }],
        onToken: (t) => setMsgs((m) => { const copy = [...m]; copy[copy.length - 1] = { role: "assistant", content: copy[copy.length - 1]!.content + t }; return copy; }),
      });
      setMsgs((m) => { const copy = [...m]; copy[copy.length - 1] = { role: "assistant", content: answer }; return copy; });
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "chat failed, is your configured endpoint reachable?", "danger");
      setMsgs((m) => m.slice(0, -1));
    } finally { setBusy(false); }
  }

  return (
    <Card>
      <div ref={scrollRef} className="mb-2 max-h-72 space-y-2 overflow-auto">
        {msgs.length === 0 ? (
          <div className="py-8"><EmptyState title="Ask this Resonator anything" hint={`Talk to ${r.name} directly, using its character. Replies come from your configured endpoint.`} /></div>
        ) : (
          msgs.map((m, i) => {
            const streaming = busy && i === msgs.length - 1 && m.role === "assistant";
            return (
              <div key={i} className={m.role === "user" ? "text-right" : ""}>
                <span className={`inline-flex max-w-[85%] items-center gap-2 rounded-xl px-3 py-2 text-sm ${m.role === "user" ? "bg-elevated" : "border border-hairline bg-base"}`}>
                  {m.content || (streaming ? <Spinner size={14} /> : "")}
                </span>
              </div>
            );
          })
        )}
      </div>
      <div className="flex gap-2">
        <Input value={input} disabled={busy} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !busy) send(); }} placeholder="Message this Resonator" />
        <Button variant="primary" onClick={send} disabled={busy || !input.trim()}>{busy ? <Spinner size={14} /> : "Send"}</Button>
      </div>
      <p className="mt-2 text-[11px] text-faint">Endpoint <span className="mono">{endpoint}</span></p>
    </Card>
  );
}

// Owner-only edit surface. Everything here is immutable post-create in the old UI even though the client
// API supports it: identity/price/listed go through updateResonator, caps through setSpendLimits.
function ResonatorSettings({ r, onSaved }: { r: Resonator; onSaved: () => void | Promise<void> }) {
  const client = useZira((s) => s.client);
  const mode = useZira((s) => s.mode);
  const request = useUnlock((s) => s.request);
  const toast = useToast();
  const [name, setName] = useState(r.name);
  const [purpose, setPurpose] = useState(r.purpose);
  const [systemPrompt, setSystemPrompt] = useState(r.systemPrompt);
  const [domains, setDomains] = useState<Domain[]>(r.domains);
  const [listed, setListed] = useState(r.listed);
  const [price, setPrice] = useState(String(r.priceUZIR / 1_000_000));
  const [perTx, setPerTx] = useState(String(r.spendLimits.perTxUZIR / 1_000_000));
  const [perDay, setPerDay] = useState(String(r.spendLimits.perDayUZIR / 1_000_000));
  const [minZti, setMinZti] = useState(String(r.spendLimits.minCounterpartyZti));
  const [busy, setBusy] = useState(false);

  function toggleDomain(d: Domain) {
    setDomains((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]);
  }

  async function save() {
    if (!client) return;
    const priceNum = Number(price);
    const perTxNum = Number(perTx);
    const perDayNum = Number(perDay);
    const minZtiNum = Number(minZti);
    if (!name.trim()) { toast.push("Give your Resonator a name.", "warn"); return; }
    if (domains.length === 0) { toast.push("Pick at least one domain.", "warn"); return; }
    if (![priceNum, perTxNum, perDayNum, minZtiNum].every(Number.isFinite) || priceNum < 0 || perTxNum < 0 || perDayNum < 0) {
      toast.push("Enter valid, non-negative amounts.", "warn"); return;
    }
    if (mode === "node") { const ok = await request(); if (!ok) return; }
    setBusy(true);
    try {
      const limits: SpendLimits = {
        perTxUZIR: zirToUzir(perTxNum),
        perDayUZIR: zirToUzir(perDayNum),
        minCounterpartyZti: Math.max(0, Math.min(1, minZtiNum)),
        allowedDomains: domains,
      };
      // Identity, price, listing, and domains in one signed update; caps in a second so each is validated.
      await client.updateResonator(r.id, {
        name: name.trim(), purpose: purpose.trim(), systemPrompt, domains,
        priceUZIR: zirToUzir(priceNum), listed,
      });
      await client.setSpendLimits(r.id, limits);
      toast.push("Settings saved.");
      await onSaved();
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "save failed", "danger");
    } finally { setBusy(false); }
  }

  return (
    <Card>
      <h3 className="mb-1 text-sm font-semibold">Edit settings</h3>
      <p className="mb-3 text-xs text-faint">Change this Resonator's character, what it charges, where it appears, and how much it can spend. Updates are signed by you as the owner. Earned trust and history are never affected.</p>
      <div className="space-y-3">
        <Field label="Name" hint="What people see when they find your Resonator.">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Purpose" hint="One line on what it does.">
          <Input value={purpose} onChange={(e) => setPurpose(e.target.value)} />
        </Field>
        <Field label="Personality and instructions" hint="Its system prompt: how it answers.">
          <Textarea value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={4} />
        </Field>
        <Field label="Skills" hint="The domains where it earns trust.">
          <div className="flex flex-wrap gap-1">
            {DOMAINS.map((d) => (
              <button key={d} type="button" onClick={() => toggleDomain(d)} title={DOMAIN_META[d].desc}
                className={`rounded-full border px-2 py-1 text-xs transition-colors ${domains.includes(d) ? "border-[var(--accent)] text-[var(--accent)]" : "border-hairline text-muted hover:border-hairline-strong hover:text-text"}`}>{DOMAIN_META[d].label}</button>
            ))}
          </div>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Task price (ZIR)" hint="What hirers pay per task.">
            <Input value={price} onChange={(e) => setPrice(e.target.value)} className="mono" />
          </Field>
          <Field label="Minimum counterparty trust" hint="0 to 1. It only deals above this ZTI.">
            <Input value={minZti} onChange={(e) => setMinZti(e.target.value)} className="mono" />
          </Field>
          <Field label="Per task cap (ZIR)" hint="Most it can spend on one coordination.">
            <Input value={perTx} onChange={(e) => setPerTx(e.target.value)} className="mono" />
          </Field>
          <Field label="Per day cap (ZIR)" hint="Most it can spend in a day.">
            <Input value={perDay} onChange={(e) => setPerDay(e.target.value)} className="mono" />
          </Field>
        </div>
        <Field label="Listing">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={listed} onChange={(e) => setListed(e.target.checked)} /> Show in Discover so others can find and hire it</label>
        </Field>
        <div className="flex justify-end">
          <Button variant="primary" onClick={save} disabled={busy}>{busy ? <Spinner size={14} /> : "Save settings"}</Button>
        </div>
      </div>
    </Card>
  );
}
