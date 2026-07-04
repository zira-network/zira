// apps/console/src/app/Wallet.tsx
// Self custodial wallet. Keys are generated and held in the browser. The app signs locally and
// submits signed transactions to the node. Each card is its own top level component so background
// refreshes never interrupt what you are typing.
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowDownLeft, ArrowUpRight, Copy, Lock, Unlock, Download, AlertTriangle, RefreshCw, ShieldCheck, Crown } from "lucide-react";
import { PROTOCOL, DOMAIN_META, isValidAddress, keypairFromPrivate, type SignedTx, type Domain } from "@zira/protocol";
import { Card, Button, Input, Badge, Meter, Modal, Select, useToast, EmptyState, Textarea } from "../components/ui";
import { useZira } from "../store/useZira";
import { useUnlock } from "../store/useUnlock";
import { extractPrivateKeyInput, Wallet } from "../lib/keys";
import { NodeClient, PUBLIC_GATEWAYS } from "../client/NodeClient";
import { NodeApi, type ZtiSnapshot, type EventsStatus } from "../lib/nodeApi";
import { makeSignedTx, zirToUzir } from "../lib/tx";
import { formatZir, formatUZir, shortAddress, shortHash, timeAgo } from "../lib/format";
import { featureEnabled } from "../lib/phase";

export function WalletPage() {
  const hasWallet = useZira((s) => s.hasWallet);
  const nodeWallet = useZira((s) => s.nodeWallet);
  const address = useZira((s) => s.address);
  const unlocked = useZira((s) => s.unlocked);
  const client = useZira((s) => s.client);
  const balanceUZIR = useZira((s) => s.balanceUZIR);
  const setUnlocked = useZira((s) => s.setUnlocked);
  const request = useUnlock((s) => s.request);
  const toast = useToast();
  const [history, setHistory] = useState<SignedTx[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [showBackup, setShowBackup] = useState(false);

  async function loadHistory() {
    if (!client || !address) { setHistory([]); return; }
    setHistoryLoading(true);
    setHistoryError("");
    try {
      let txs = await client.getTxHistory(address, 80);
      // A freshly-synced local node only holds the recent tx window, so an imported (older) wallet can
      // look history-less here even though it earned for weeks. When the local answer is empty, read the
      // public gateway too, it serves the network's shared view of this address's recent activity.
      if (txs.length === 0) {
        for (const gateway of PUBLIC_GATEWAYS) {
          try {
            txs = await new NodeClient(gateway, false).getTxHistory(address, 80);
            if (txs.length > 0) break;
          } catch { /* gateway briefly unreachable: try the next */ }
        }
      }
      setHistory(txs);
    } catch (e) {
      setHistoryError(e instanceof Error ? e.message : "Could not load wallet history.");
    } finally {
      setHistoryLoading(false);
    }
  }

  useEffect(() => {
    void loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, address, balanceUZIR]);

  if (!hasWallet) {
    return (
      <div className="p-6">
        <EmptyState title="No wallet yet" hint="Create a wallet to hold ZIR. Your key is created and encrypted right here on your device, and never sent anywhere.">
          <Button variant="primary" onClick={() => { localStorage.removeItem("zira.onboarded"); location.reload(); }}>Set up a wallet</Button>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-5 p-6">
      <BalanceCard />
      <StewardWalletCard />
      <EventsClaimCard address={address} />
      <TrustCard />
      <div className="grid gap-4 md:grid-cols-2">
        <SendForm />
        {nodeWallet ? (
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Your node wallet</h3>
              <Badge tone="teal"><ShieldCheck size={11} /> on this machine</Badge>
            </div>
            <div className="text-xs text-faint">Address</div>
            <div className="mono mb-3 flex items-center gap-2 break-all text-sm">
              {address}
              <button onClick={() => { navigator.clipboard.writeText(address ?? ""); toast.push("Address copied"); }}><Copy size={13} className="text-muted hover:text-text" /></button>
            </div>
            <p className="text-xs text-muted">This is the wallet your node mines into. Its key stays on your machine and never enters the browser, so there is nothing to unlock here. Mining and coordination earnings arrive at this address directly.</p>
            <p className="mt-2 text-xs text-faint">To back it up, save the file <span className="mono">identity.json</span> in your ZIRA data folder. Anyone with that file controls this wallet.</p>
            <NodeWalletImport />
          </Card>
        ) : (
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Your key</h3>
              {unlocked ? <Badge tone="teal"><Unlock size={11} /> unlocked</Badge> : <Badge tone="neutral"><Lock size={11} /> locked</Badge>}
            </div>
            <div className="text-xs text-faint">Address</div>
            <div className="mono mb-3 flex items-center gap-2 break-all text-sm">
              {address}
              <button onClick={() => { navigator.clipboard.writeText(address ?? ""); toast.push("Address copied"); }}><Copy size={13} className="text-muted hover:text-text" /></button>
            </div>
            <div className="flex flex-wrap gap-2">
              {unlocked
                ? <Button variant="secondary" onClick={() => { Wallet.lock(); setUnlocked(false); toast.push("Wallet locked"); }}><Lock size={14} /> Lock</Button>
                : <Button variant="secondary" onClick={async () => { if (await request()) toast.push("Unlocked"); }}><Unlock size={14} /> Unlock</Button>}
              <Button variant="ghost" onClick={async () => { if (await request()) setShowBackup(true); }}><Download size={14} /> Back up</Button>
            </div>
          </Card>
        )}
      </div>

      {showBackup && !nodeWallet && <BackupPanel onClose={() => setShowBackup(false)} />}
      {!nodeWallet && <ImportWalletCard />}
      <TxHistory history={history} address={address} loading={historyLoading} error={historyError} onRefresh={loadHistory} />
    </div>
  );
}

function TrustCard() {
  const { zti, ztiByDomain, address, mode } = useZira();
  const [histDomain, setHistDomain] = useState<Domain | null>(null);
  const [hist, setHist] = useState<ZtiSnapshot[]>([]);

  const domains = useMemo(() => {
    const entries = Object.entries(ztiByDomain).filter(([, v]) => (v ?? 0) > 0) as [Domain, number][];
    return entries.sort((a, b) => b[1] - a[1]);
  }, [ztiByDomain]);

  useEffect(() => {
    if (histDomain && address && mode === "node") NodeApi.ztiHistory(address, histDomain, 50).then(setHist).catch(() => setHist([]));
  }, [histDomain, address, mode]);

  return (
    <Card>
      <div className="mb-3 flex items-center gap-2"><ShieldCheck size={16} className="text-[var(--teal)]" /><h3 className="text-sm font-semibold">ZIRA Trust Index</h3></div>
      <div className="mb-3"><Meter value={zti} label="Overall" /></div>
      {domains.length === 0 ? (
        <p className="text-xs text-muted">No domain trust yet. Participate (observe, provide, or build) to earn ZTI.</p>
      ) : (
        <div className="space-y-2">
          {domains.map(([d, v]) => (
            <div key={d} className="flex items-center gap-3">
              <span className="w-20 shrink-0 text-xs text-muted">{DOMAIN_META[d].label}</span>
              <div className="flex-1"><Meter value={v} /></div>
              <button className="text-[11px] text-[var(--teal)] hover:underline" onClick={() => setHistDomain(d)}>history</button>
            </div>
          ))}
        </div>
      )}
      <Modal open={histDomain !== null} onClose={() => setHistDomain(null)} title={histDomain ? `${DOMAIN_META[histDomain].label} ZTI history` : ""}>
        <Sparkline data={hist.map((h) => h.zti)} />
        {hist.length === 0 && <p className="mt-2 text-xs text-muted">No history recorded yet for this domain.</p>}
      </Modal>
    </Card>
  );
}

function Sparkline({ data }: { data: number[] }) {
  if (data.length < 2) return <div className="h-16 rounded-lg border border-hairline bg-base" />;
  const w = 320, h = 64, max = Math.max(...data, 1), min = Math.min(...data, 0);
  const span = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / span) * (h - 6) - 3}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full">
      <polyline points={pts} fill="none" stroke="var(--teal)" strokeWidth="2" />
    </svg>
  );
}

function BalanceCard() {
  const balanceUZIR = useZira((s) => s.balanceUZIR);
  const network = useZira((s) => s.network);
  const share = (balanceUZIR / PROTOCOL.MAX_SUPPLY_UZIR) * 100;
  return (
    <Card className="relative overflow-hidden">
      <div className="text-xs text-muted">Balance{network !== "mainnet" && <span className="ml-2 text-[var(--warn)]">test ZIR, no value</span>}</div>
      <div className="mono mt-1 text-4xl font-semibold gradient-text">{formatZir(balanceUZIR)} <span className="text-xl">ZIR</span></div>
      <div className="mono mt-1 text-xs text-faint">{formatUZir(balanceUZIR)} uZIR</div>
      <div className="mt-3 text-xs text-faint">{share.toFixed(9)}% of the total supply</div>
    </Card>
  );
}

// Surfaces a clear Steward badge + section when the loaded wallet IS a well-known steward wallet
// (the 30% anchor-reserve wallet or the founder wallet), linking to the steward controls. When the
// node is not running with the steward key, an inline note explains that actions are read-only until
// the steward runs their node with the key.
function StewardWalletCard() {
  const isStewardWallet = useZira((s) => s.isStewardWallet);
  const stewardKind = useZira((s) => s.stewardKind);
  const stewardActionsGated = useZira((s) => s.stewardActionsGated);
  if (!isStewardWallet) return null;
  const label = stewardKind === "anchor-reserve"
    ? "Anchor-reserve steward wallet (owns all 512 anchor positions at genesis)"
    : "Founder steward wallet (owns the seeded network Resonators)";
  return (
    <Card className="border-[color-mix(in_srgb,var(--warn)_30%,var(--border))] bg-[color-mix(in_srgb,var(--warn)_6%,transparent)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Crown size={16} className="text-[var(--warn)]" />
          <h3 className="text-sm font-semibold">Steward wallet</h3>
          <Badge tone="warn">steward</Badge>
        </div>
        <Link to="/founder"><Button variant="primary"><Crown size={14} /> Open steward controls</Button></Link>
      </div>
      <p className="mt-2 text-xs text-muted">This wallet is the {label}. The steward controls let you assign each of the 512 anchor positions to an owner one by one, transfer positions and resonators (single and batch), seed resonators, manage and add models, and settle coordination.</p>
      {stewardActionsGated && (
        <p className="mt-2 rounded-lg border border-[color-mix(in_srgb,var(--warn)_28%,var(--border))] bg-[color-mix(in_srgb,var(--warn)_8%,transparent)] p-2 text-[11px] text-muted">
          Steward actions require the node to run with the steward key. The connected node does not hold it, so the controls are shown read-only and signed steward operations will be refused until you run your node with the steward key.
        </p>
      )}
    </Card>
  );
}

function SendForm() {
  const client = useZira((s) => s.client);
  const address = useZira((s) => s.address);
  const network = useZira((s) => s.network);
  const mode = useZira((s) => s.mode);
  const balanceUZIR = useZira((s) => s.balanceUZIR);
  const phase = useZira((s) => s.phase);
  const refresh = useZira((s) => s.refresh);
  const request = useUnlock((s) => s.request);
  const toast = useToast();
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const canSend = featureEnabled(phase, "settlement") || network !== "mainnet";
  const amountUZIR = zirToUzir(Number(amount) || 0);
  const burn = Math.floor(PROTOCOL.BASE_FEE_UZIR * PROTOCOL.FEE_BURN);
  const valid = isValidAddress(to) && amountUZIR > 0 && amountUZIR + PROTOCOL.BASE_FEE_UZIR <= balanceUZIR;

  async function submit() {
    if (!client || !address) return;
    if (!isValidAddress(to)) { toast.push("That is not a valid ZIR address.", "warn"); return; }
    // A node-custody wallet is already unlocked in memory, so request() short-circuits; a browser wallet
    // prompts for the passphrase. Either way the tx is signed locally with the active key.
    if (mode === "node") { const ok = await request(); if (!ok) return; }
    setBusy(true);
    try {
      const nonce = await client.getNonce(address);
      const tx = makeSignedTx({ network, to, amountUZIR, nonce, kind: "transfer", memo: memo || undefined });
      const res = await client.submitTx(tx);
      if (res.accepted) { toast.push("Sent. Transaction " + shortHash(tx.id)); setTo(""); setAmount(""); setMemo(""); await refresh(); }
      else toast.push("Rejected: " + (res.reason ?? "unknown"), "danger");
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "send failed", "danger");
    } finally { setBusy(false); }
  }

  return (
    <Card>
      <h3 className="mb-3 text-sm font-semibold">Send ZIR</h3>
      <div className="space-y-2">
        <Input placeholder="Recipient address (zir1...)" value={to} onChange={(e) => setTo(e.target.value)} className="mono" />
        <Input placeholder="Amount in ZIR" value={amount} onChange={(e) => setAmount(e.target.value)} className="mono" inputMode="decimal" />
        <Input placeholder="Note (optional)" value={memo} onChange={(e) => setMemo(e.target.value)} />
      </div>
      <div className="mt-2 space-y-0.5 text-xs text-faint">
        <div>Amount: <span className="mono">{formatZir(amountUZIR)} ZIR</span></div>
        <div>Fee: <span className="mono">{formatZir(PROTOCOL.BASE_FEE_UZIR)} ZIR</span>, half of it (<span className="mono">{formatZir(burn)}</span>) is burned forever</div>
      </div>
      <Button variant="primary" className="mt-3 w-full" onClick={submit} disabled={!valid || busy || !canSend}>Review and send</Button>
    </Card>
  );
}

// Import a different wallet as this node's mining identity. Writes the key to the node (loopback-only)
// and restarts the app so the node reloads it, after which the node mines into the imported wallet.
function NodeWalletImport() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  async function doImport() {
    setBusy(true);
    try {
      const raw = extractPrivateKeyInput(key);
      const r = await NodeApi.walletImport(raw);
      if (!r.ok) { toast.push(r.reason ?? "could not import", "danger"); return; }
      toast.push("Wallet imported. Restarting to mine into it…");
      const bridge = (window as unknown as { zira?: { relaunchApp?: () => void } }).zira;
      if (bridge?.relaunchApp) { setTimeout(() => bridge.relaunchApp!(), 800); }
      else toast.push("Imported. Restart ZIRA to load the new wallet.", "warn");
    } catch (e) { toast.push(e instanceof Error ? e.message : "invalid private key", "danger"); }
    finally { setBusy(false); }
  }
  return (
    <div className="mt-3 border-t border-hairline pt-3">
      <button onClick={() => setOpen((v) => !v)} className="text-[11px] text-muted hover:text-text">{open ? "Cancel" : "Use a different wallet (import a private key)"}</button>
      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-[11px] text-faint">Paste a private key. It becomes this node&apos;s wallet, so your node mines into it. The app restarts to load it. Your current wallet stays recoverable from its own key.</p>
          <Textarea rows={3} className="mono" placeholder="privateKey=... or a raw private key" value={key} onChange={(e) => setKey(e.target.value)} />
          <Button variant="secondary" onClick={doImport} disabled={busy || !key.trim()}>Import and restart</Button>
        </div>
      )}
    </div>
  );
}

function BackupPanel({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  let priv = "";
  try { priv = Wallet.exportPrivateKey(); } catch { priv = "unlock the wallet first"; }
  return (
    <Card className="border-[color-mix(in_srgb,var(--warn)_30%,transparent)]">
      <div className="mb-2 flex items-center gap-2 text-[var(--warn)]"><AlertTriangle size={16} /><h3 className="text-sm font-semibold">Back up your key, carefully</h3></div>
      <p className="mb-2 text-xs text-muted">Anyone with this key controls your funds. If you lose it, no one can recover it. Never paste it into a website or share it. Write it down and keep it somewhere safe.</p>
      <div className="mono break-all rounded-lg border border-hairline bg-base p-2 text-xs">{priv}</div>
      <div className="mt-2 flex gap-2">
        <Button variant="secondary" onClick={() => { navigator.clipboard.writeText(priv); toast.push("Key copied. Store it somewhere safe."); }}>Copy</Button>
        <Button variant="ghost" onClick={onClose}>Close</Button>
      </div>
    </Card>
  );
}

function ImportWalletCard() {
  const currentAddress = useZira((s) => s.address);
  const refreshIdentity = useZira((s) => s.refreshIdentity);
  const setUnlocked = useZira((s) => s.setUnlocked);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState("");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const preview = useMemo(() => {
    if (!raw.trim()) return null;
    try {
      const priv = extractPrivateKeyInput(raw);
      return { address: keypairFromPrivate(priv).address, error: "" };
    } catch (e) {
      return { address: "", error: e instanceof Error ? e.message : "could not read private key" };
    }
  }, [raw]);

  async function restore() {
    if (!preview?.address || pass.length < 6) return;
    if (!confirm(`Replace the wallet stored in this browser with ${preview.address}? This does not change the ledger; it only changes which private key this browser uses.`)) return;
    setBusy(true);
    try {
      await Wallet.importPrivateKey(raw, pass);
      await refreshIdentity();
      setUnlocked(true);
      setRaw("");
      setPass("");
      setOpen(false);
      toast.push("Wallet restored: " + shortAddress(preview.address));
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "wallet restore failed", "danger");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Restore or replace wallet</h3>
          <p className="mt-1 text-xs text-muted">Paste a ZIRA backup section, a privateKey= line, or a raw private key. The importer ignores public keys so the launch reserve wallet cannot accidentally restore as another address.</p>
        </div>
        <Button variant="secondary" onClick={() => setOpen((v) => !v)}>{open ? "Close" : "Import"}</Button>
      </div>
      {open && (
        <div className="mt-3 space-y-2 rounded-lg border border-hairline bg-base p-3">
          <Textarea rows={5} className="mono" value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="Paste privateKey=... or the Launch reserve wallet section" />
          <Input type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="New local passphrase for this device" />
          {preview?.error && <p className="text-xs text-[var(--danger)]">{preview.error}</p>}
          {preview?.address && (
            <div className="rounded-lg border border-[color-mix(in_srgb,var(--teal)_28%,var(--border))] bg-[color-mix(in_srgb,var(--teal)_7%,transparent)] p-2 text-xs">
              <div className="text-faint">Will import address</div>
              <div className="mono break-all text-text">{preview.address}</div>
              {currentAddress && currentAddress !== preview.address && <div className="mt-1 text-faint">Current browser wallet {shortAddress(currentAddress)} will be replaced locally.</div>}
            </div>
          )}
          <Button variant="primary" onClick={restore} disabled={busy || !preview?.address || pass.length < 6}>Restore this wallet</Button>
        </div>
      )}
    </Card>
  );
}

function TxHistory({ history, address, loading, error, onRefresh }: { history: SignedTx[]; address: string | null; loading: boolean; error: string; onRefresh: () => void }) {
  const directionFor = (tx: SignedTx) => {
    if (tx.to === address || tx.kind === "reward" || tx.kind === "reserve_grant") return "in";
    if (tx.from === address && tx.to !== address) return "out";
    return "neutral";
  };
  const toneFor = (tx: SignedTx) => {
    if (tx.kind === "bond_burn") return "danger";
    if (tx.kind === "agent_spend" || tx.kind === "bond_post" || tx.kind === "bond_return") return "indigo";
    if (tx.to === address || tx.kind === "reward" || tx.kind === "reserve_grant") return "teal";
    return "neutral";
  };
  const [filter, setFilter] = useState<"all" | "incoming" | "outgoing" | "rewards" | "tasks">("all");
  const rows = useMemo(() => history.filter((tx) => {
    if (filter === "all") return true;
    if (filter === "incoming") return tx.to === address || tx.kind === "reward" || tx.kind === "reserve_grant";
    if (filter === "outgoing") return tx.from === address && tx.to !== address;
    if (filter === "rewards") return tx.kind === "reward" || tx.kind === "reserve_grant";
    if (filter === "tasks") return tx.kind === "agent_spend";
    return true;
  }), [address, history, filter]);
  const totals = useMemo(() => history.reduce((acc, tx) => {
    if (tx.to === address || tx.kind === "reward" || tx.kind === "reserve_grant") acc.in += tx.amountUZIR ?? 0;
    if (tx.from === address && tx.to !== address) acc.out += (tx.amountUZIR ?? 0) + (tx.feeUZIR ?? 0);
    return acc;
  }, { in: 0, out: 0 }), [address, history]);
  return (
    <Card>
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h3 className="text-sm font-semibold">Wallet history</h3>
          <p className="mt-1 text-xs text-muted">Signed activity for this address, ordered by the node's ledger view.</p>
        </div>
        <div className="flex gap-2">
          <Select className="w-36" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
            <option value="all">All activity</option>
            <option value="incoming">Incoming</option>
            <option value="outgoing">Outgoing</option>
            <option value="rewards">Rewards</option>
            <option value="tasks">Tasks</option>
          </Select>
          <Button variant="ghost" onClick={onRefresh} disabled={loading}><RefreshCw size={14} /> Refresh</Button>
        </div>
      </div>
      <div className="mb-3 grid grid-cols-2 gap-2 text-xs">
        <div className="rounded-lg border border-hairline bg-base p-2"><div className="text-faint">Received</div><div className="mono text-[var(--teal)]">{formatZir(totals.in)} ZIR</div></div>
        <div className="rounded-lg border border-hairline bg-base p-2"><div className="text-faint">Sent + fees</div><div className="mono">{formatZir(totals.out)} ZIR</div></div>
      </div>
      {error && <p className="mb-2 rounded-lg border border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] p-2 text-xs text-muted">{error}</p>}
      {loading && rows.length === 0 ? <p className="text-xs text-muted">Loading wallet history...</p> : rows.length === 0 ? <p className="text-xs text-muted">No matching transactions yet.</p> : (
        <div className="grid gap-2">
          {rows.map((tx) => {
            const direction = directionFor(tx);
            const incoming = direction === "in";
            const outgoing = direction === "out";
            const net = outgoing ? (tx.amountUZIR ?? 0) + (tx.feeUZIR ?? 0) : (tx.amountUZIR ?? 0);
            return (
            <div key={tx.id} className="rounded-xl border border-hairline bg-base/70 p-3 text-sm shadow-[var(--shadow-1)]">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex items-start gap-2">
                  <span className={`mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-full border ${incoming ? "border-[color-mix(in_srgb,var(--teal)_42%,var(--border))] bg-[color-mix(in_srgb,var(--teal)_10%,transparent)] text-[var(--teal)]" : outgoing ? "border-[color-mix(in_srgb,var(--warn)_35%,var(--border))] bg-[color-mix(in_srgb,var(--warn)_8%,transparent)] text-[var(--warn)]" : "border-hairline text-muted"}`}>
                    {incoming ? <ArrowDownLeft size={16} /> : <ArrowUpRight size={16} />}
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={toneFor(tx) as "teal" | "indigo" | "danger" | "neutral"}>{tx.kind.replace(/_/g, " ")}</Badge>
                      <span className="text-xs text-muted">{incoming ? "Received" : outgoing ? "Sent" : "Activity"}</span>
                    </div>
                    <div className="mono mt-1 break-all text-[11px] text-faint">{shortHash(tx.id)}</div>
                    <div className="mt-1 text-xs text-faint"><span className="mono">{shortAddress(tx.from || "network")}</span> to <span className="mono">{shortAddress(tx.to)}</span></div>
                    {tx.memo && <div className="mt-1 rounded-md border border-hairline bg-surface/60 px-2 py-1 text-xs text-muted">{tx.memo}</div>}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className={`mono text-base ${incoming ? "text-[var(--teal)]" : outgoing ? "text-[var(--warn)]" : ""}`}>{incoming ? "+" : outgoing ? "-" : ""}{formatZir(net)} ZIR</div>
                  <div className="text-[11px] text-faint">{timeAgo(tx.timestamp)}</div>
                  {tx.feeUZIR ? <div className="text-[11px] text-faint">fee {formatZir(tx.feeUZIR)} ZIR</div> : null}
                </div>
              </div>
            </div>
          );})}
        </div>
      )}
    </Card>
  );
}

// The "+" near your balance. Transparent community airdrop: claim free ZIR from the events reserve
// while the founder has events active and the reserve holds enough. Never a purchase.
function EventsClaimCard({ address }: { address: string | null }) {
  const [status, setStatus] = useState<EventsStatus | null>(null);
  const [claiming, setClaiming] = useState(false);
  const toast = useToast();
  async function load() { try { setStatus(await NodeApi.eventsStatus()); } catch { /* node may not expose events */ } }
  useEffect(() => { void load(); const iv = setInterval(load, 15000); return () => clearInterval(iv); }, []);
  if (!status?.visible || !address) return null;
  async function claim() {
    if (!address) return;
    setClaiming(true);
    try {
      const r = await NodeApi.eventsClaim(address);
      if (r.ok) { toast.push(`Claimed ${formatZir(r.amountUZIR ?? 0)} ZIR to your wallet.`, "teal"); void load(); }
      else toast.push(r.reason || "Could not claim right now.", "warn");
    } catch (e) { toast.push(e instanceof Error ? e.message : "Claim failed.", "danger"); }
    finally { setClaiming(false); }
  }
  return (
    <Card className="border-l-2 border-l-[var(--teal)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-text"><ArrowDownLeft size={15} className="text-[var(--teal)]" /> Get ZIR</div>
          <p className="mt-1 text-xs text-muted">A community airdrop is open. Claim <span className="mono text-text">{formatZir(status.claimUZIR)} ZIR</span> to your wallet, free.</p>
        </div>
        <Button variant="primary" onClick={claim} disabled={claiming}>{claiming ? "Claiming..." : "+ Claim ZIR"}</Button>
      </div>
    </Card>
  );
}
