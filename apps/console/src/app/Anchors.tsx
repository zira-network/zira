// apps/console/src/app/Anchors.tsx
import { useEffect, useRef, useState } from "react";
import { ANCHOR_CLASSES, TOTAL_ANCHOR_SEATS, PROTOCOL, MAINNET_ANCHOR_STEWARD, type Anchor, type AnchorClass } from "@zira/protocol";
import QRCode from "qrcode";
import { Card, Badge, Button, Modal, Input, useToast, useSlowHint } from "../components/ui";
import { useZira } from "../store/useZira";
import { useUnlock } from "../store/useUnlock";
import { formatNum, shortAddress } from "../lib/format";
import { cn } from "../lib/cn";
import { payUsdt } from "../lib/usdtPay";
import { makeSignedTx } from "../lib/tx";
import { NodeApi } from "../lib/nodeApi";

// A seat is still AVAILABLE to contribute for while the steward holds it (the steward assigns it to a
// contributor after their payment confirms). A seat counts as ASSIGNED only once it leaves the steward
// wallet for a real owner. At genesis the steward holds all 512, so availability must not read them as taken.
const isStewardHeld = (a: Anchor) => a.owner === MAINNET_ANCHOR_STEWARD;
const isAssigned = (a: Anchor) => !!a.owner && a.owner !== MAINNET_ANCHOR_STEWARD;

// Wallet-agnostic payment QR: encodes the receiving address so a contributor can scan it with ANY wallet
// (EVM or TRON) and send the shown amount, independent of WalletConnect. Renders nothing until ready.
function PayQr({ addr }: { addr: string }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    let alive = true;
    if (!addr) { setSrc(""); return; }
    QRCode.toDataURL(addr, { width: 168, margin: 1, color: { dark: "#0b0d24", light: "#ffffff" } })
      .then((d) => { if (alive) setSrc(d); })
      .catch(() => { if (alive) setSrc(""); });
    return () => { alive = false; };
  }, [addr]);
  if (!src) return null;
  return <img src={src} width={168} height={168} alt="Receiving address QR" className="rounded-lg border border-hairline bg-white p-1" />;
}

// Ink palette: a single teal hue fading to slate-grey encodes class rank (A highest -> F base) without a
// rainbow, so the seat map stays monochrome and on-brand. Readable on both the light and dark anchor stage.
const CLASS_COLOR: Record<string, string> = { A: "#0d9488", B: "#2b8c84", C: "#44827d", D: "#556070", E: "#6b7280", F: "#9aa3b2" };
const CLASS_CODES = Object.keys(ANCHOR_CLASSES) as AnchorClass[];
const CLASS_RAILS: Record<AnchorClass, number> = { A: 62, B: 86, C: 112, D: 140, E: 166, F: 190 };
// USDT contribution per class for the anchor event (the public class ladder). Receiving addresses are
// NOT hardcoded here; the app constructs the transfer to ZIRA's published address at the WalletConnect step.
const CLASS_USDT: Record<AnchorClass, number> = { A: 5000, B: 3750, C: 2500, D: 1250, E: 500, F: 150 };
const USDT_NETWORKS = ["Ethereum", "BSC", "TRON TRC-20", "Polygon"] as const;

export function Anchors() {
  const { client, address, network, mode, anchorEvent } = useZira();
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [owned, setOwned] = useState<Anchor[]>([]);
  const [picked, setPicked] = useState<Anchor | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loadedOnce, setLoadedOnce] = useState(false);
  const toast = useToast();
  const request = useUnlock((s) => s.request);
  const slow = useSlowHint(loading && !loadedOnce);
  const mounted = useRef(true);

  async function load() {
    if (!client) return;
    setLoading(true);
    setError("");
    try {
      const all = await client.listAnchors();
      if (!mounted.current) return;
      setAnchors(all);
      if (address) setOwned(all.filter((a) => a.owner === address));
      else setOwned([]);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : "Could not load anchor positions right now. Check the node connection and retry.");
    } finally {
      if (mounted.current) { setLoading(false); setLoadedOnce(true); }
    }
  }

  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; /* eslint-disable-next-line */ }, [client, address]);

  const totalStakeUZIR = CLASS_CODES.reduce((a, c) => a + ANCHOR_CLASSES[c].stakeZIR * ANCHOR_CLASSES[c].seats, 0) * PROTOCOL.UZIR_PER_ZIR;
  const claimed = anchors.filter(isAssigned).length;

  async function signAnchorTx(kind: "anchor_claim" | "anchor_transfer" | "anchor_position_transfer" | "anchor_activate", data: unknown, submit: (tx: ReturnType<typeof makeSignedTx>) => Promise<{ accepted: boolean; reason?: string }>) {
    if (!address) { toast.push("Create or unlock a wallet first.", "warn"); return; }
    if (mode === "node") { const ok = await request(); if (!ok) return; }
    setBusy(true);
    try {
      const nonce = await client!.getNonce(address);
      const tx = makeSignedTx({ network, to: address, amountUZIR: 0, nonce, kind, memo: JSON.stringify({ anchor: kind.replace("anchor_", ""), data }) });
      const result = await submit(tx);
      if (!result.accepted) throw new Error(result.reason ?? "anchor transaction rejected");
      toast.push("Anchor transaction submitted. It will settle at the next field epoch.");
      setTimeout(() => void load(), 7000);
    } catch (e) {
      toast.push(e instanceof Error ? e.message : "anchor transaction failed", "danger");
    } finally {
      setBusy(false);
    }
  }


  return (
    <div className="mx-auto max-w-5xl space-y-5 p-6">
      <Card className="field-hero">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <Badge tone="teal">ZRC-1 anchors live</Badge>
            <h2 className="title-glow mt-2 text-2xl font-semibold tracking-tight">512 Anchor positions. The network&apos;s foundation.</h2>
            <p className="mt-1 max-w-3xl text-sm text-muted">Only 512 Anchor positions exist on the network. They are foundational, high-trust positions you can hold and transfer, assigned by invitation and contribution, never sold. Each carries a class, a starting trust level, a routing weight, and a ZIR allocation that vests to its owner over one year. You can own and transfer them now. Earning from them turns on later, once every position is secured and the next phase opens.</p>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center text-xs">
            <div className="rounded-lg border border-hairline bg-base p-2"><div className="mono text-sm text-[var(--teal)]">{claimed}/{TOTAL_ANCHOR_SEATS}</div><div className="text-faint">assigned</div></div>
            <div className="rounded-lg border border-hairline bg-base p-2"><div className="mono text-sm text-[var(--teal)]">{TOTAL_ANCHOR_SEATS - claimed}</div><div className="text-faint">held by steward</div></div>
            <div className="rounded-lg border border-hairline bg-base p-2"><div className="mono text-sm text-[var(--teal)]">{owned.length}</div><div className="text-faint">yours</div></div>
          </div>
        </div>
      </Card>

      {/* Anchor event (spec §2.1): the USDT contribute section is shown ONLY here on the Anchors page, and
          ONLY while the steward has the event enabled. When the steward turns it off, it disappears with no
          trace for every user. */}
      {anchorEvent.enabled && <AnchorEventContribute anchors={anchors} address={address} />}

      {error && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] p-3 text-xs text-muted">
          <span>{error}</span>
          <Button variant="ghost" onClick={() => void load()} disabled={loading}>Retry</Button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <Card className="anchor-stage p-0">
          {loading && !loadedOnce
            ? <div className="flex flex-col items-center justify-center gap-1 py-24 text-xs text-faint"><span>Loading anchor topology...</span>{slow && <span className="text-faint">Taking longer than usual. The node may be busy or syncing.</span>}</div>
            : <Lattice anchors={anchors} onPick={setPicked} />}
        </Card>
        <div className="space-y-4">
          <ClassLegend anchors={anchors} totalStakeUZIR={totalStakeUZIR} />
        </div>
      </div>
      <OwnedSeats seats={owned} busy={busy} onRefresh={load} onTransfer={(seatId, to) => signAnchorTx("anchor_transfer", { seatId, to }, NodeApi.submitAnchorTransfer)}
        onBatchTransfer={(seatIds, to) => signAnchorTx("anchor_position_transfer", { seatIds, to }, NodeApi.submitAnchorPositionTransfer)}
        onActivate={(seatId) => signAnchorTx("anchor_activate", { seatId }, NodeApi.submitAnchorActivate)} />
      {picked && <SeatDetail anchor={picked} onClose={() => setPicked(null)} />}
    </div>
  );
}

// The USDT anchor contribute flow (spec §2). Rendered only on the Anchors page and only while the steward
// has the anchor event enabled. Acquiring a seat is a contribution toward coordination infrastructure; the
// ZIR allocation is a vesting network parameter, not a token sale. The WalletConnect auto-transfer is wired
// in the next build step; this surface handles class/quantity/network selection and the exact USDT total.
function AnchorEventContribute({ anchors, address }: { anchors: Anchor[]; address: string | null }) {
  const toast = useToast();
  const { anchorEvent } = useZira();
  const [picked, setPicked] = useState<AnchorClass>("F");
  const [qty, setQty] = useState(1);
  const [net, setNet] = useState<(typeof USDT_NETWORKS)[number]>("Ethereum");
  // Available = seats the steward still holds in this class (assignable to a contributor). Until the anchors
  // list has loaded, fall back to the full class size so the contribute controls are not dead on first paint.
  const seatsLeft = (code: AnchorClass) => anchors.length === 0
    ? ANCHOR_CLASSES[code].seats
    : anchors.filter((a) => a.classCode === code && isStewardHeld(a)).length;
  const left = seatsLeft(picked);
  const [paying, setPaying] = useState(false);
  const total = CLASS_USDT[picked] * Math.max(1, qty);
  const addr = net === "TRON TRC-20" ? anchorEvent.tron : anchorEvent.evm;

  async function contribute() {
    if (!address) { toast.push("Create or unlock a ZIR wallet first, so your seat can be assigned to it.", "warn"); return; }
    if (left < qty) { toast.push("Not enough seats remaining in this class.", "warn"); return; }
    if (!addr) { toast.push(`The steward is finalizing the receiving address for ${net}.`, "warn"); return; }
    setPaying(true);
    try {
      // QR one-tap: a WalletConnect QR opens; the contributor scans it with their wallet and approves the
      // exact USDT transfer to the steward's receiving address. The steward confirms on-chain, then assigns
      // the seat. Works the same on desktop, web, and mobile.
      const { hash } = await payUsdt(net, addr, total, anchorEvent.wcProjectId);
      try { await NodeApi.recordAnchorContribution({ zirAddress: address, network: net, amountUsdt: total, txHash: hash, classCode: picked, quantity: qty }); } catch { /* steward-visible record is best-effort */ }
      toast.push(`Sent ${total.toLocaleString()} USDT on ${net} (tx ${hash.slice(0, 12)}…). The steward confirms it on-chain, then assigns your seat to ${shortAddress(address)}.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "wallet payment failed";
      // TRON or no project id yet: fall back to a manual send (copy the exact receiving address).
      if (/address shown|project id|manually|TRON/i.test(msg)) { void navigator.clipboard?.writeText(addr).catch(() => {}); toast.push(`${msg} Address copied. You can send ${total.toLocaleString()} USDT manually on ${net}.`, "warn"); }
      else toast.push(msg, "danger");
    } finally { setPaying(false); }
  }

  return (
    <Card className="border-[color-mix(in_srgb,var(--teal)_35%,transparent)]">
      <div className="mb-2 flex items-center gap-2"><Badge tone="teal">Anchor event live</Badge><h3 className="text-sm font-semibold">Contribute to secure an anchor position</h3></div>
      <p className="mb-3 text-xs text-muted">Acquiring an anchor seat is a contribution toward the network&apos;s coordination infrastructure. The reserve-backed ZIR allocation vests over one year to your ZIR address; it is a network parameter, not a token sale. Pick a class and quantity, choose a network, then connect a wallet. ZIRA constructs the exact USDT transfer and you confirm it in your wallet. The steward reviews each confirmed payment before assigning the seat.</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {CLASS_CODES.map((code) => {
          const c = ANCHOR_CLASSES[code];
          const cleft = seatsLeft(code);
          return (
            <button key={code} type="button" onClick={() => setPicked(code)} disabled={cleft === 0}
              className={cn("rounded-lg border p-2 text-left text-xs transition-colors", picked === code ? "border-[var(--teal)] bg-base" : "border-hairline hover:border-hairline-strong", cleft === 0 && "cursor-not-allowed opacity-40")}>
              <div className="flex items-center justify-between"><span className="font-medium text-text">{code} · {c.name}</span><span className="mono text-[var(--teal)]">{CLASS_USDT[code].toLocaleString()} USDT</span></div>
              <div className="mt-1 grid grid-cols-3 gap-1 text-[11px] text-faint"><span>W {c.weight}/6</span><span>Min ZTI {c.minZTI}</span><span>{cleft} left</span></div>
            </button>
          );
        })}
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <div className="mb-1 text-xs text-faint">Quantity</div>
          <Input className="mono" value={String(qty)} onChange={(e) => setQty(Math.max(1, Math.min(Math.max(1, left), Number(e.target.value) || 1)))} />
        </div>
        <div>
          <div className="mb-1 text-xs text-faint">USDT network</div>
          <div className="flex flex-wrap gap-1">
            {USDT_NETWORKS.map((n) => (
              <button key={n} type="button" onClick={() => setNet(n)} className={cn("rounded px-2 py-1 text-[11px] transition-colors", net === n ? "bg-[var(--teal)] text-white" : "border border-hairline text-muted hover:text-text")}>{n}</button>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-3 rounded-lg border border-hairline bg-base p-3">
        <div className="flex items-center justify-between gap-3">
          <div><div className="text-[11px] text-faint">Total contribution</div><div className="mono text-lg text-[var(--teal)]">{total.toLocaleString()} USDT</div></div>
          <Button variant="primary" onClick={contribute} disabled={!addr || left < qty || paying}>{paying ? "Opening QR…" : "Contribute"}</Button>
        </div>
        {addr
          ? <div className="mt-3 grid gap-3 sm:grid-cols-[auto_1fr] sm:items-center">
              <PayQr addr={addr} />
              <div className="text-[11px] text-faint">
                <div className="mb-1">Scan with any wallet to send <span className="mono text-text">{total.toLocaleString()} USDT</span> on <span className="text-text">{net}</span> to:</div>
                <button type="button" title="Copy address" onClick={() => { void navigator.clipboard?.writeText(addr).catch(() => {}); toast.push("Receiving address copied."); }} className="mono break-all text-left text-muted transition-colors hover:text-text">{addr}</button>
                <div className="mt-2">Or tap <span className="text-text">Contribute</span> for a one-tap WalletConnect transfer{net === "TRON TRC-20" ? " (EVM wallets only; for TRON, scan the QR above and enter the amount)" : " that pre-fills the exact amount"}.</div>
              </div>
            </div>
          : <div className="mt-2 text-[11px] text-faint">The steward is finalizing the receiving address for {net}.</div>}
      </div>
      <p className="mt-2 text-[11px] text-faint">Seat assignment is a reviewed steward step after your on-chain payment confirms. Anchors are infrastructure positions under uncertainty, not an investment; read the risk notes before contributing.</p>
    </Card>
  );
}

function Lattice({ anchors, onPick }: { anchors: Anchor[]; onPick: (a: Anchor) => void }) {
  const byClass = (code: AnchorClass) => anchors.filter((a) => a.classCode === code);
  const ringNode = (list: Anchor[], code: AnchorClass) =>
    list.map((a, i) => {
      const radius = CLASS_RAILS[code];
      const angle = (i / list.length) * Math.PI * 2;
      const x = 200 + Math.cos(angle) * radius;
      const y = 200 + Math.sin(angle) * radius;
      const r = 1.8 + a.routingWeight * 0.52;
      return <circle key={a.id} cx={x} cy={y} r={r} fill={CLASS_COLOR[a.classCode]} opacity={a.owner ? 0.98 : 0.32} stroke={a.owner ? "var(--text-faint)" : "transparent"} strokeWidth="1.35" className="anchor-seat cursor-pointer" onClick={() => onPick(a)}><title>{a.id} · weight {a.routingWeight}/6</title></circle>;
    });
  const label = (code: AnchorClass, angle: number) => {
    const radius = CLASS_RAILS[code] + 9;
    return <text key={code} x={200 + Math.cos(angle) * radius} y={200 + Math.sin(angle) * radius} textAnchor="middle" dominantBaseline="middle" fill={CLASS_COLOR[code]} fontSize="7" fontWeight="700" opacity="0.92">{code}{ANCHOR_CLASSES[code].weight}/6</text>;
  };
  return (
    <svg viewBox="0 0 400 400" className="relative z-[1] w-full" role="img" aria-label="ZIRA Anchor topology with six weighted seat classes">
      <defs>
        <radialGradient id="core"><stop offset="0" stopColor="var(--violet)" /><stop offset="0.5" stopColor="var(--accent)" /><stop offset="1" stopColor="var(--accent)" /></radialGradient>
        <filter id="anchorGlow"><feGaussianBlur stdDeviation="2" result="blur" /><feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
      <circle cx="200" cy="200" r="198" fill="none" stroke="var(--border)" strokeWidth="1.2" />
      {(CLASS_CODES).map((code) => <circle key={code} cx="200" cy="200" r={CLASS_RAILS[code]} fill="none" stroke={CLASS_COLOR[code]} strokeOpacity={0.08 + ANCHOR_CLASSES[code].weight * 0.035} strokeWidth={0.8 + ANCHOR_CLASSES[code].weight * 0.18} />)}
      {CLASS_CODES.map((code, i) => {
        const angle = (i / CLASS_CODES.length) * Math.PI * 2 - Math.PI / 2;
        return <line key={code} x1="200" y1="200" x2={200 + Math.cos(angle) * 190} y2={200 + Math.sin(angle) * 190} stroke={CLASS_COLOR[code]} strokeOpacity="0.16" strokeWidth="0.8" />;
      })}
      {CLASS_CODES.map((code, i) => label(code, (i / CLASS_CODES.length) * Math.PI * 2 - Math.PI / 2))}
      <circle cx="200" cy="200" r="24" fill="none" stroke="var(--border)" />
      <circle cx="200" cy="200" r="14" fill="url(#core)" filter="url(#anchorGlow)" />
      <text x="200" y="203" textAnchor="middle" fill="#ffffff" fontSize="8" fontWeight="800">512</text>
      {CLASS_CODES.flatMap((code) => ringNode(byClass(code), code))}
    </svg>
  );
}


function ClassLegend({ anchors, totalStakeUZIR }: { anchors: Anchor[]; totalStakeUZIR: number }) {
  return (
    <Card>
      <h3 className="title-glow mb-2 text-sm font-semibold">Six classes, fixed at {TOTAL_ANCHOR_SEATS} seats</h3>
      <div className="space-y-2">
        {CLASS_CODES.map((code) => {
          const c = ANCHOR_CLASSES[code];
          const taken = anchors.filter((a) => a.classCode === code && isAssigned(a)).length;
          return (
            <div key={code} className="rounded-lg border border-hairline bg-base/70 p-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 font-medium text-text"><span className="h-2.5 w-2.5 rounded-full" style={{ background: CLASS_COLOR[code], color: CLASS_COLOR[code] }} /> {code} · {c.name}</span>
                <span className="mono text-faint">{taken}/{c.seats}</span>
              </div>
              <div className="mt-1 grid grid-cols-2 gap-2 text-[11px]">
                <span className="text-faint">Weight <span className="mono text-[var(--teal)]">{c.weight}/6</span></span>
                <span className="text-faint">Min ZTI <span className="mono text-muted">{c.minZTI}</span></span>
              </div>
              <div className="mt-1 text-[11px] text-faint">{c.role}</div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 border-t border-hairline pt-2 text-xs text-faint">
        <div>Total reserve-backed allocation at full occupancy <span className="mono">{formatNum(totalStakeUZIR / PROTOCOL.UZIR_PER_ZIR / 1e9, 3)}B ZIR</span></div>
        <p className="mt-2">Class sets baseline topology load. Behavior, ZTI, uptime, and useful work decide future routing priority. The allocation is a network parameter that vests to each position's owner over one year, never a price.</p>
        <div className="mt-3 rounded-lg border border-hairline bg-base/70 p-2">
          <div className="font-medium text-muted">Anchor reserve · 30% = <span className="mono">8.61B ZIR</span></div>
          <p className="mt-1">The full anchor reserve sits in the steward-administered anchor-reserve wallet <span className="mono">zira-anchor-reserve</span>, held on behalf of the seat owners rather than as steward funds. It is released to seat owners as their seats are assigned, each release a signed public ledger entry. The per-seat <span className="text-muted">Reserve allocation</span> shown on each seat is that seat&apos;s structural stake, one slice of this 30%, not the whole reserve.</p>
        </div>
      </div>
    </Card>
  );
}

function OwnedSeats({ seats, busy, onRefresh, onTransfer, onBatchTransfer, onActivate }: {
  seats: Anchor[]; busy: boolean; onRefresh: () => Promise<void>;
  onTransfer: (seatId: string, to: string) => Promise<void>;
  onBatchTransfer: (seatIds: string[], to: string) => Promise<void>;
  onActivate: (seatId: string) => Promise<void>;
}) {
  const [transferTo, setTransferTo] = useState<Record<string, string>>({});
  // multi-select batch transfer: move several positions (resonators) to one address in a single signed op
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [batchTo, setBatchTo] = useState("");
  const selectedIds = seats.filter((a) => selected[a.id]).map((a) => a.id);
  const toggle = (id: string) => setSelected((s) => ({ ...s, [id]: !s[id] }));
  async function doBatch() {
    if (selectedIds.length === 0 || !batchTo.startsWith("zir1")) return;
    await onBatchTransfer(selectedIds, batchTo);
    setSelected({});
    setBatchTo("");
  }
  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Your anchor seats</h3>
        <Button variant="ghost" onClick={() => void onRefresh()}>Refresh</Button>
      </div>
      {seats.length === 0 ? <p className="text-sm text-muted">No positions in this wallet yet. Acquire one in the anchor event when it is open, or receive a transfer from the steward or another owner.</p> : (
        <>
          {/* Batch transfer: select multiple positions and move them all to one address at once. Each
              position carries its class/ZTI/weight and its ZIR allocation; vesting follows the new owner. */}
          <div className="mb-3 rounded-xl border border-hairline bg-base/70 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-muted">Batch transfer positions</span>
              <span className="mono text-[11px] text-faint">{selectedIds.length} selected</span>
            </div>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <Input placeholder="Transfer selected to zir1..." value={batchTo} onChange={(e) => setBatchTo(e.target.value)} className="mono" />
              <Button variant="primary" disabled={busy || selectedIds.length === 0 || !batchTo.startsWith("zir1")} onClick={() => void doBatch()}>Transfer {selectedIds.length || ""} position{selectedIds.length === 1 ? "" : "s"}</Button>
            </div>
            <p className="mt-1 text-[11px] text-faint">Tick the seats below, enter one destination, and move them all in a single signed operation. Each position&apos;s remaining one-year vesting follows the new owner.</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {seats.map((a) => (
              <div key={a.id} className="rounded-xl border border-hairline bg-base p-3 text-sm">
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 font-semibold">
                    <input type="checkbox" checked={Boolean(selected[a.id])} onChange={() => toggle(a.id)} className="accent-[var(--teal)]" />
                    {a.id} · {a.className ?? a.classCode}
                  </label>
                  <Badge tone="teal">held</Badge>
                </div>
                <div className="mt-1 text-xs text-faint">ZRC-1 position. Future routing is operated by a Resonator and multiplied by earned ZTI.</div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
                  <span className="text-faint">Allocation <span className="mono text-muted">{formatNum(a.zirReserveUZIR / PROTOCOL.UZIR_PER_ZIR, 0)} ZIR</span></span>
                  <span className="text-faint">Vested <span className="mono text-[var(--teal)]">{formatNum(a.vestedUZIR / PROTOCOL.UZIR_PER_ZIR, 0)} ZIR</span></span>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
                  <Input placeholder="Transfer to zir1..." value={transferTo[a.id] ?? ""} onChange={(e) => setTransferTo({ ...transferTo, [a.id]: e.target.value })} className="mono" />
                  <Button disabled={busy || !(transferTo[a.id] ?? "").startsWith("zir1")} onClick={() => onTransfer(a.id, transferTo[a.id] ?? "")}>Transfer</Button>
                </div>
                <p className="mt-1 text-[11px] text-faint">Transferring a position moves its class, ZTI, weight, and remaining one-year vesting to the new owner in one signed operation.</p>
                <Button variant="ghost" className="mt-2 w-full" disabled onClick={() => onActivate(a.id)}>Activation disabled until all 512 positions are secured</Button>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}

function SeatDetail({ anchor, onClose }: { anchor: Anchor; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title={`Seat ${anchor.id}`}>
      <div className="space-y-1 text-sm">
        <div className="flex justify-between"><span className="text-faint">Ring</span><span>{anchor.ring}</span></div>
        <div className="flex justify-between"><span className="text-faint">Class</span><Badge tone="indigo">{anchor.classCode} · {anchor.className ?? ANCHOR_CLASSES[anchor.classCode].name}</Badge></div>
        <div className="flex justify-between"><span className="text-faint">Seat index</span><span className="mono">{anchor.seatIndex}</span></div>
        <div className="flex justify-between"><span className="text-faint">Owner</span><span className="mono">{anchor.owner ? shortAddress(anchor.owner) : "available"}</span></div>
        <div className="flex justify-between"><span className="text-faint">Reserve allocation</span><span className="mono">{formatNum(anchor.zirReserveUZIR / PROTOCOL.UZIR_PER_ZIR, 0)} ZIR</span></div>
        <div className="flex justify-between"><span className="text-faint">Vested</span><span className="mono">{formatNum(anchor.vestedUZIR / PROTOCOL.UZIR_PER_ZIR, 0)} ZIR</span></div>
        <div className="flex justify-between"><span className="text-faint">Routing weight</span><span className="mono">{anchor.routingWeight}</span></div>
        <div className="flex justify-between"><span className="text-faint">Status</span><Badge tone="neutral">{anchor.owner ? "held" : "available"}</Badge></div>
      </div>
      <p className="mt-3 text-xs text-muted">A seat is the position. After future activation, a Resonator operates it and earns only through routed coordination work, ZTI, uptime, and bonds. The position alone is inert.</p>
    </Modal>
  );
}
