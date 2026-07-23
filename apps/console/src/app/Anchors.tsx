// apps/console/src/app/Anchors.tsx
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ANCHOR_CLASSES, TOTAL_ANCHOR_SEATS, PROTOCOL, MAINNET_ANCHOR_STEWARD, type Anchor, type AnchorClass } from "@zira/protocol";
import QRCode from "qrcode";
import { Card, Badge, Button, Input, useToast, useSlowHint } from "../components/ui";
import { useZira } from "../store/useZira";
import { useUnlock } from "../store/useUnlock";
import { formatNum, shortAddress } from "../lib/format";
import { cn } from "../lib/cn";
import { payUsdt } from "../lib/usdtPay";
import { makeSignedTx } from "../lib/tx";
import { NodeApi } from "../lib/nodeApi";
import { AnchorGlyph, ANCHOR_CLASS_VISUAL } from "../components/anchorClass";
import { AnchorLattice } from "../components/AnchorLattice";

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

// Class palette, matched to the anchors web page (zira-field/anchors.html) so the app and site read as one
// system: Genesis gold, Meridian amber, Nexus teal, Lattice green, Sentinel blue, Foundation slate.
const CLASS_COLOR: Record<string, string> = { A: "#D4A820", B: "#F08030", C: "#3ECFC0", D: "#18C080", E: "#4D94F7", F: "#8296B5" };
const CLASS_CODES = Object.keys(ANCHOR_CLASSES) as AnchorClass[];
// Semantic colors for the three seat states, kept consistent across every class so a reader learns them once:
// ASSIGNED = owned by a contributor (teal, filled), OPEN = steward-held and opened for contribution (amber,
// available now), RESERVE = steward-held and not yet opened (muted). Class identity is carried by the glyph.
const STATE_COLOR = { assigned: "var(--teal)", open: "var(--warn)", reserve: "var(--violet)" } as const;
const classColor = (code: AnchorClass) => CLASS_COLOR[code] ?? "var(--violet)";
// USDT contribution per class for the anchor event (the public class ladder). Receiving addresses are
// NOT hardcoded here; the app constructs the transfer to ZIRA's published address at the WalletConnect step.
const CLASS_USDT: Record<AnchorClass, number> = { A: 5000, B: 3750, C: 2500, D: 1250, E: 500, F: 150 };
const USDT_NETWORKS = ["Ethereum", "BSC", "TRON TRC-20", "Polygon"] as const;

export function Anchors() {
  const { client, address, network, mode, anchorEvent } = useZira();
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [owned, setOwned] = useState<Anchor[]>([]);
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
  // Three seat states across the whole lattice: assigned (owned by contributors), open (steward-held and
  // opened for contribution), reserve (steward-held, not yet opened). At genesis the steward holds all 512.
  const claimed = anchors.filter(isAssigned).length;
  const openCount = anchors.filter((a) => isStewardHeld(a) && !!a.contributionsOpen).length;
  const reserveCount = anchors.filter((a) => isStewardHeld(a) && !a.contributionsOpen).length;

  async function signAnchorTx(kind: "anchor_claim" | "anchor_transfer" | "anchor_position_transfer" | "anchor_activate" | "anchor_set_contributions", data: unknown, submit: (tx: ReturnType<typeof makeSignedTx>) => Promise<{ accepted: boolean; reason?: string }>) {
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
      {/* Hero: the 512-seat lattice as a luminous structure (the six anchor classes as concentric rings). */}
      <Card className="overflow-hidden !p-0">
        <div className="brand-rule" />
        <div className="grid items-center gap-4 p-5 md:grid-cols-[minmax(0,1fr)_300px]">
          <div className="order-2 min-w-0 md:order-1">
            <div className="text-[11px] uppercase tracking-[0.16em] text-faint">Anchor lattice</div>
            <div className="mt-1.5 flex flex-wrap items-center gap-2.5">
              <h2 className="text-2xl font-semibold tracking-tight text-text">The lattice</h2>
              <Badge tone="teal">ZRC-1 anchors live</Badge>
            </div>
            <p className="mt-1.5 max-w-2xl text-sm text-muted">512 permanent seats form the network&apos;s trusted, well-routed core, in six classes from Genesis to Foundation. Each carries a starting trust level, a routing weight, and a ZIR allocation that vests over one year. Own and transfer one today; earning turns on in a later phase.</p>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <div className="min-w-0 rounded-xl border border-hairline bg-[var(--bg-panel)] p-3"><div className="mono text-xl font-semibold" style={{ color: STATE_COLOR.assigned }}>{claimed}</div><div className="mt-0.5 text-[10px] uppercase tracking-[0.14em] text-faint">assigned</div></div>
              <div className="min-w-0 rounded-xl border border-hairline bg-[var(--bg-panel)] p-3"><div className="mono text-xl font-semibold" style={{ color: STATE_COLOR.open }}>{openCount}</div><div className="mt-0.5 text-[10px] uppercase tracking-[0.14em] text-faint">open</div></div>
              <div className="min-w-0 rounded-xl border border-hairline bg-[var(--bg-panel)] p-3"><div className="mono text-xl font-semibold" style={{ color: STATE_COLOR.reserve }}>{reserveCount}</div><div className="mt-0.5 text-[10px] uppercase tracking-[0.14em] text-faint">in reserve</div></div>
            </div>
            <div className="mt-3"><TriBar assigned={claimed} open={openCount} reserve={reserveCount} total={TOTAL_ANCHOR_SEATS} height={10} /></div>
          </div>
          <div className="order-1 flex justify-center md:order-2"><AnchorLattice anchors={anchors} size={300} /></div>
        </div>
      </Card>

      {/* Compact class ladder, directly under the hero: the six classes with their color, seat counts, and a
          per-class ASSIGNED / OPEN / RESERVE tri-state, plus the same split overall. */}
      {loading && !loadedOnce
        ? <Card className="anchor-stage"><div className="flex flex-col items-center justify-center gap-1 py-16 text-xs text-faint"><span>Loading anchor topology...</span>{slow && <span className="text-faint">Taking longer than usual. The node may be busy or syncing.</span>}</div></Card>
        : <ClassLadder anchors={anchors} totalStakeUZIR={totalStakeUZIR} />}

      {/* Anchor event (spec §2.1): the USDT contribute section is shown ONLY here on the Anchors page, and
          ONLY while the steward has the event enabled. When the steward turns it off, it disappears with no
          trace for every user. */}
      {anchorEvent.enabled && (anchorEvent.evm || anchorEvent.tron) && <AnchorEventContribute anchors={anchors} address={address} />}

      {error && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] p-3 text-xs text-muted">
          <span>{error}</span>
          <Button variant="ghost" onClick={() => void load()} disabled={loading}>Retry</Button>
        </div>
      )}

      {owned.length > 0 && (
        <Link to="/lattice" className="flex items-center justify-between gap-3 rounded-xl border border-[color-mix(in_srgb,var(--teal)_35%,transparent)] bg-[color-mix(in_srgb,var(--teal)_6%,transparent)] p-4 transition-colors hover:border-[var(--teal)]">
          <div>
            <div className="text-sm font-semibold text-text">You hold {owned.length} seat{owned.length === 1 ? "" : "s"} in the lattice.</div>
            <div className="text-xs text-muted">Open Your Lattice to manage your seats, vesting, standing, and transfers.</div>
          </div>
          <span className="shrink-0 text-sm text-[var(--teal)]">Open Your Lattice &rarr;</span>
        </Link>
      )}
    </div>
  );
}

// A compact tri-state bar: one stacked track showing ASSIGNED (teal), OPEN (amber), RESERVE (muted) segments
// sized against the class or lattice total. No pie charts; the segment order and colors are stable everywhere.
function TriBar({ assigned, open, reserve, total, height = 8 }: { assigned: number; open: number; reserve: number; total: number; height?: number }) {
  const w = (n: number) => (total > 0 ? (n / total) * 100 : 0);
  return (
    <div className="flex overflow-hidden rounded-full" style={{ height, background: "color-mix(in srgb, var(--text-faint) 16%, transparent)" }}>
      <div style={{ width: `${w(assigned)}%`, background: STATE_COLOR.assigned }} title={`Assigned ${assigned}`} />
      <div style={{ width: `${w(open)}%`, background: STATE_COLOR.open }} title={`Open ${open}`} />
      <div style={{ width: `${w(reserve)}%`, background: STATE_COLOR.reserve }} title={`Reserve ${reserve}`} />
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
  // Availability = seats the steward has UNLOCKED for contribution (steward-held AND contributionsOpen). By
  // default every unsigned seat is LOCKED; the steward opens specific seats in batches, and only those are
  // offered here. Signed (assigned) seats never appear. Nothing is available until a batch is opened.
  const seatsLeft = (code: AnchorClass) => anchors.filter((a) => a.classCode === code && isStewardHeld(a) && a.contributionsOpen).length;
  const left = seatsLeft(picked);
  const totalAvailable = CLASS_CODES.reduce((s, c) => s + seatsLeft(c), 0);
  const [paying, setPaying] = useState(false);
  const total = CLASS_USDT[picked] * Math.max(1, qty);
  const addr = net === "TRON TRC-20" ? anchorEvent.tron : anchorEvent.evm;

  // Keep the picked class on one that actually has open seats, so the contribute controls are never stuck on
  // a locked class while another class has an open batch.
  useEffect(() => {
    if (seatsLeft(picked) === 0) { const first = CLASS_CODES.find((c) => seatsLeft(c) > 0); if (first) setPicked(first); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchors]);

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
      {totalAvailable === 0 && <div className="mb-3 rounded-lg border border-hairline bg-base p-3 text-center text-xs text-muted">No anchor seats are open for contribution right now. The steward opens seats in batches; please check back soon.</div>}
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

// The compact class ladder: six tight rows (class chip + color + seat counts), each showing the three seat
// states as a stacked bar and three labeled numbers, plus the same split overall. No pie charts, no second
// large rings visual: the hero AnchorLattice is the only large lattice on the page.
function ClassLadder({ anchors, totalStakeUZIR }: { anchors: Anchor[]; totalStakeUZIR: number }) {
  const stateOf = (code: AnchorClass) => {
    const inClass = anchors.filter((a) => a.classCode === code);
    return {
      assigned: inClass.filter(isAssigned).length,
      open: inClass.filter((a) => isStewardHeld(a) && !!a.contributionsOpen).length,
      reserve: inClass.filter((a) => isStewardHeld(a) && !a.contributionsOpen).length,
      total: ANCHOR_CLASSES[code].seats,
    };
  };
  const overall = CLASS_CODES.reduce((acc, code) => {
    const s = stateOf(code);
    return { assigned: acc.assigned + s.assigned, open: acc.open + s.open, reserve: acc.reserve + s.reserve };
  }, { assigned: 0, open: 0, reserve: 0 });
  const legend = [
    { key: "assigned", label: "Assigned", n: overall.assigned, color: STATE_COLOR.assigned },
    { key: "open", label: "Open", n: overall.open, color: STATE_COLOR.open },
    { key: "reserve", label: "Reserve", n: overall.reserve, color: STATE_COLOR.reserve },
  ] as const;
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-[0.16em] text-faint">Class ladder</div>
          <h3 className="title-glow mt-0.5 text-sm font-semibold">Six classes, {TOTAL_ANCHOR_SEATS} seats</h3>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          {legend.map((l) => (
            <span key={l.key} className="flex items-center gap-1.5 text-faint">
              <span className="h-2 w-2 rounded-full" style={{ background: l.color }} /><span className="mono text-text">{l.n}</span> {l.label}
            </span>
          ))}
        </div>
      </div>
      <p className="mt-1 text-[11px] text-faint">Higher classes carry more routing weight and a higher starting trust floor. Assigned seats are owned by contributors, open seats can be contributed for now, reserve seats are steward-held and not yet opened.</p>
      <div className="mt-2.5"><TriBar assigned={overall.assigned} open={overall.open} reserve={overall.reserve} total={TOTAL_ANCHOR_SEATS} height={10} /></div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {CLASS_CODES.map((code) => {
          const c = ANCHOR_CLASSES[code];
          const color = classColor(code);
          const s = stateOf(code);
          return (
            <div key={code} className="rounded-lg border bg-base/70 p-2.5 text-xs" style={{ borderColor: `color-mix(in srgb, ${color} 22%, var(--border))` }}>
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2 font-medium text-text"><AnchorGlyph cls={code} size={18} /> <span className="truncate">{code} · {c.name}</span></span>
                <span className="mono shrink-0 text-[11px] text-faint">{s.assigned}/{c.seats}</span>
              </div>
              <div className="mt-2"><TriBar assigned={s.assigned} open={s.open} reserve={s.reserve} total={c.seats} /></div>
              <div className="mt-1.5 flex items-center justify-between gap-1 text-[10px] text-faint">
                <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: STATE_COLOR.assigned }} /><span className="mono text-muted">{s.assigned}</span> assigned</span>
                <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: STATE_COLOR.open }} /><span className="mono text-muted">{s.open}</span> open</span>
                <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full" style={{ background: STATE_COLOR.reserve }} /><span className="mono text-muted">{s.reserve}</span> reserve</span>
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-faint">
                <span className="flex items-center gap-1.5">Weight
                  <span className="inline-flex gap-0.5">{Array.from({ length: 6 }).map((_, i) => <span key={i} className="h-1.5 w-1.5 rounded-full" style={{ background: i < c.weight ? color : "color-mix(in srgb, var(--text-faint) 22%, transparent)" }} />)}</span>
                </span>
                <span>Min ZTI <span className="mono text-muted">{c.minZTI}</span></span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-3 border-t border-hairline pt-2 text-[11px] text-faint">
        <div>Reserve-backed allocation at full occupancy <span className="mono text-muted">{formatNum(totalStakeUZIR / PROTOCOL.UZIR_PER_ZIR / 1e9, 3)}B ZIR</span>, a network parameter that vests to each position&apos;s owner over one year, not a price.</div>
        <p className="mt-1.5">The 30% anchor reserve (<span className="mono">8.61B ZIR</span>) sits in the steward-administered <span className="mono">zira-anchor-reserve</span> wallet, held on behalf of the seat owners rather than as steward funds, and is released as each seat is assigned, one signed public ledger entry per release. Each seat&apos;s Reserve allocation is its structural stake, one slice of this 30%, not the whole reserve.</p>
      </div>
    </Card>
  );
}

// "Your lattice": the premium owner summary, shown only when the wallet holds seats. Leads with what the
// owner actually holds (aggregate allocation, vested-so-far, top standing, class spread), a vesting bar,
// and an honest active-now vs coming-soon split, so ownership reads as a place in the network, not a table.
export function YourLattice({ seats }: { seats: Anchor[] }) {
  const alloc = seats.reduce((s, a) => s + a.zirReserveUZIR, 0);
  const vested = seats.reduce((s, a) => s + a.vestedUZIR, 0);
  const pct = alloc > 0 ? Math.min(100, Math.round((vested / alloc) * 100)) : 0;
  const standing = seats.reduce((m, a) => Math.max(m, a.zti ?? 0), 0);
  const classes = CLASS_CODES.filter((c) => seats.some((a) => a.classCode === c));
  const zir = (u: number) => formatNum(u / PROTOCOL.UZIR_PER_ZIR, 0);
  return (
    <Card className="field-hero">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <Badge tone="teal">Your lattice</Badge>
          <h3 className="title-glow mt-2 text-xl font-semibold tracking-tight">You hold {seats.length} seat{seats.length === 1 ? "" : "s"} in the lattice.</h3>
          <p className="mt-1 max-w-xl text-sm text-muted">A permanent place in the network&apos;s core. Your allocation vests to you over the year, and more of what a seat does turns on as the network activates it.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {classes.map((c) => (
              <span key={c} className="flex items-center gap-2 rounded-full border px-2.5 py-1 text-[11px] text-muted"
                style={{ borderColor: `color-mix(in srgb, ${CLASS_COLOR[c]} 34%, var(--border))`, background: `color-mix(in srgb, ${CLASS_COLOR[c]} 8%, transparent)` }}>
                <AnchorGlyph cls={c} size={18} />
                <span><b className="font-semibold text-text">{ANCHOR_CLASSES[c].name}</b> · {seats.filter((a) => a.classCode === c).length}</span>
              </span>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center text-xs">
          <div className="rounded-lg border border-hairline bg-base p-2"><div className="mono text-sm text-[var(--teal)]">{zir(alloc)}</div><div className="text-faint">ZIR allocation</div></div>
          <div className="rounded-lg border border-hairline bg-base p-2"><div className="mono text-sm text-[var(--teal)]">{zir(vested)}</div><div className="text-faint">vested so far</div></div>
          <div className="rounded-lg border border-hairline bg-base p-2"><div className="mono text-sm text-[var(--teal)]">{standing.toFixed(2)}</div><div className="text-faint">top standing</div></div>
        </div>
      </div>
      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between text-[11px] text-faint"><span>Vesting across your seats, over one year</span><span className="mono text-muted">{pct}%</span></div>
        <div className="h-2 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--text-faint)_18%,transparent)]"><div className="h-full rounded-full bg-[var(--teal)] transition-[width] duration-700" style={{ width: pct + "%" }} /></div>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-hairline bg-base/70 p-3">
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-[var(--teal)]">Active now</div>
          <div className="flex flex-wrap gap-1.5">
            {["Ownership", "One-year vesting", "Standing", "Transferable"].map((t) => <span key={t} className="rounded-full border border-[color-mix(in_srgb,var(--teal)_30%,var(--border))] bg-[color-mix(in_srgb,var(--teal)_6%,transparent)] px-2 py-0.5 text-[11px] text-muted">{t}</span>)}
          </div>
        </div>
        <div className="rounded-lg border border-hairline bg-base/70 p-3">
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-faint">Coming soon</div>
          <div className="flex flex-wrap gap-1.5">
            {["Routing revenue", "Resonator-pool share", "Governance"].map((t) => <span key={t} className="rounded-full border border-hairline bg-base px-2 py-0.5 text-[11px] text-faint">{t}</span>)}
          </div>
        </div>
      </div>
    </Card>
  );
}

export function OwnedSeats({ seats, busy, onRefresh, onTransfer, onBatchTransfer, onSetContributions, onActivate }: {
  seats: Anchor[]; busy: boolean; onRefresh: () => Promise<void>;
  onTransfer: (seatId: string, to: string) => Promise<void>;
  onBatchTransfer: (seatIds: string[], to: string) => Promise<void>;
  onSetContributions: (seatIds: string[], open: boolean) => Promise<void>;
  onActivate: (seatId: string) => Promise<void>;
}) {
  const [transferTo, setTransferTo] = useState<Record<string, string>>({});
  // multi-select batch transfer: move several positions (resonators) to one address in a single signed op
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [batchTo, setBatchTo] = useState("");
  const selectedIds = seats.filter((a) => selected[a.id]).map((a) => a.id);
  const toggle = (id: string) => setSelected((s) => ({ ...s, [id]: !s[id] }));
  // Only an anchors wallet (one that actually HOLDS anchor seats) may open a position for contribution. A
  // wallet with no seats never sees an open-to-contribution control. This mirrors the owner-only node auth in
  // the UI: contribution is opened by the anchor holder (the steward, or an owner over their own positions),
  // never by an ordinary user. The seats passed in are the wallet's own positions.
  const isAnchorHolder = seats.length > 0;
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
              <span className="text-xs font-medium text-muted">Batch actions</span>
              <span className="mono text-[11px] text-faint">{selectedIds.length} selected</span>
            </div>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <Input placeholder="Transfer selected to zir1..." value={batchTo} onChange={(e) => setBatchTo(e.target.value)} className="mono" />
              <Button variant="primary" disabled={busy || selectedIds.length === 0 || !batchTo.startsWith("zir1")} onClick={() => void doBatch()}>Transfer {selectedIds.length || ""} position{selectedIds.length === 1 ? "" : "s"}</Button>
            </div>
            {isAnchorHolder && (
              <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-hairline pt-2">
                <span className="text-[11px] text-faint">Contribution</span>
                <Button variant="primary" disabled={busy || selectedIds.length === 0} onClick={() => void onSetContributions(selectedIds, true)}>Open {selectedIds.length || ""} for contribution</Button>
                <Button variant="ghost" disabled={busy || selectedIds.length === 0} onClick={() => void onSetContributions(selectedIds, false)}>Close</Button>
              </div>
            )}
            <p className="mt-1 text-[11px] text-faint">Tick the seats below, then transfer them to one address{isAnchorHolder ? ", or open/close a batch for contribution," : ""} in a single signed operation. Opening a steward-held seat makes it available for a contributor to acquire; a position&apos;s remaining one-year vesting follows any transfer.</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {seats.map((a) => (
              <div key={a.id} className="rounded-xl border bg-base p-3 text-sm"
                style={{ borderColor: `color-mix(in srgb, ${CLASS_COLOR[a.classCode]} 26%, var(--border))` }}>
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 font-semibold">
                    <input type="checkbox" checked={Boolean(selected[a.id])} onChange={() => toggle(a.id)} className="accent-[var(--teal)]" />
                    <AnchorGlyph cls={a.classCode} size={26} boxed />
                    <span>{a.id}<span className="ml-1 text-[11px] font-normal text-faint">{ANCHOR_CLASS_VISUAL[a.classCode]?.name ?? a.className}</span></span>
                  </label>
                  <Badge tone="teal">held</Badge>
                </div>
                <div className="mt-1 text-xs text-faint">ZRC-1 position. Future routing is operated by a Resonator and multiplied by earned ZTI.</div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
                  <span className="text-faint">Allocation <span className="mono text-muted">{formatNum(a.zirReserveUZIR / PROTOCOL.UZIR_PER_ZIR, 0)} ZIR</span></span>
                  <span className="text-faint">Vested <span className="mono text-[var(--teal)]">{formatNum(a.vestedUZIR / PROTOCOL.UZIR_PER_ZIR, 0)} ZIR</span></span>
                </div>
                <div className="mt-2">
                  <div className="h-1.5 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--text-faint)_18%,transparent)]"><div className="h-full rounded-full bg-[var(--teal)] transition-[width] duration-700" style={{ width: (a.zirReserveUZIR > 0 ? Math.min(100, Math.round((a.vestedUZIR / a.zirReserveUZIR) * 100)) : 0) + "%" }} /></div>
                  <div className="mt-1 flex justify-between text-[10px] text-faint"><span>{a.zirReserveUZIR > 0 ? Math.min(100, Math.round((a.vestedUZIR / a.zirReserveUZIR) * 100)) : 0}% vested over one year</span><span>{ANCHOR_CLASSES[a.classCode].role.split(":")[0]}</span></div>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto]">
                  <Input placeholder="Transfer to zir1..." value={transferTo[a.id] ?? ""} onChange={(e) => setTransferTo({ ...transferTo, [a.id]: e.target.value })} className="mono" />
                  <Button disabled={busy || !(transferTo[a.id] ?? "").startsWith("zir1")} onClick={() => onTransfer(a.id, transferTo[a.id] ?? "")}>Transfer</Button>
                </div>
                <p className="mt-1 text-[11px] text-faint">Transferring a position moves its class, ZTI, weight, and remaining one-year vesting to the new owner in one signed operation.</p>
                {isAnchorHolder && (
                  <>
                    <div className="mt-3 flex items-center justify-between rounded-lg border border-hairline bg-base/70 px-2.5 py-2">
                      <span className="text-[11px] text-faint">{a.owner === MAINNET_ANCHOR_STEWARD ? "Open for acquisition" : "User contributions"} {a.contributionsOpen ? <span className="text-[var(--teal)]">open</span> : <span className="text-muted">closed</span>}</span>
                      <Button variant={a.contributionsOpen ? "ghost" : "primary"} disabled={busy} onClick={() => void onSetContributions([a.id], !a.contributionsOpen)}>{a.contributionsOpen ? "Close" : "Open"}</Button>
                    </div>
                    <p className="mt-1 text-[11px] text-faint">{a.owner === MAINNET_ANCHOR_STEWARD ? "Open a steward-held seat to make it available for a contributor to acquire in the contribution flow. Closed seats are not offered." : "Open a position to let other participants contribute machines and storage under it. You can close it any time."}</p>
                  </>
                )}
                <Button variant="ghost" className="mt-2 w-full" disabled onClick={() => onActivate(a.id)}>Earning activates in a later phase</Button>
              </div>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
