// apps/console/src/app/Lattice.tsx
// "Your Lattice": the separate, premium owner space. It appears in the nav and renders here only when the
// wallet holds >= 1 anchor seat (revealed via `ownsAnchors` in the store). It leads with what the owner
// holds (YourLattice summary) and carries the full seat management (transfer, batch transfer, contributions),
// so the public Anchors page stays an explainer and ownership gets its own place in the app.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { type Anchor } from "@zira/protocol";
import { Card, useToast } from "../components/ui";
import { ResonanceField } from "../components/ResonanceField";
import { AnchorLattice } from "../components/AnchorLattice";
import { useZira } from "../store/useZira";
import { useUnlock } from "../store/useUnlock";
import { makeSignedTx } from "../lib/tx";
import { NodeApi } from "../lib/nodeApi";
import { YourLattice, OwnedSeats } from "./Anchors";

export function Lattice() {
  const { client, address, network, mode } = useZira();
  const [owned, setOwned] = useState<Anchor[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const toast = useToast();
  const request = useUnlock((s) => s.request);
  const mounted = useRef(true);

  async function load() {
    if (!client || !address) { setOwned([]); return; }
    setLoading(true);
    try { const mine = await NodeApi.myAnchors(address); if (mounted.current) setOwned(mine); }
    catch { /* keep last good */ }
    finally { if (mounted.current) setLoading(false); }
  }
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; /* eslint-disable-next-line */ }, [client, address]);

  async function signAnchorTx(
    kind: "anchor_transfer" | "anchor_position_transfer" | "anchor_activate" | "anchor_set_contributions",
    data: unknown,
    submit: (tx: ReturnType<typeof makeSignedTx>) => Promise<{ accepted: boolean; reason?: string }>,
  ) {
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
    } finally { setBusy(false); }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-6">
      {loading && owned.length === 0 ? (
        <Card className="flex flex-col items-center gap-4 py-16 text-center">
          <ResonanceField size={132} live intensity={0.4} />
          <div className="text-sm text-faint">Loading your lattice...</div>
        </Card>
      ) : owned.length === 0 ? (
        <Card className="overflow-hidden !p-0">
          <div className="brand-rule" />
          <div className="flex flex-col items-center gap-4 px-6 py-14 text-center">
            <div className="flex flex-col items-center gap-2">
              <ResonanceField size={148} live={false} intensity={0.22} />
              <div className="text-[11px] uppercase tracking-[0.16em] text-faint">no seat held</div>
            </div>
            <h2 className="title-glow text-2xl font-semibold tracking-tight">Your lattice</h2>
            <p className="mx-auto max-w-md text-sm text-muted">You do not hold a seat yet. Anchors are the 512 permanent seats in the network&apos;s core, each carrying standing and a one-year ZIR allocation. When you hold one, this becomes your space.</p>
            <Link to="/anchors" className="text-sm text-[var(--teal)]">Explore anchors &rarr;</Link>
          </div>
        </Card>
      ) : (
        <>
          {/* Hero: the six anchor classes as concentric luminous rings, with the seats you hold lit across
              them. The class totals form the tracks; your held seats and any you have opened are encoded. */}
          <Card className="overflow-hidden !p-0">
            <div className="brand-rule" />
            <div className="grid items-center gap-4 p-6 md:grid-cols-[240px_minmax(0,1fr)]">
              <div className="order-1 flex justify-center"><AnchorLattice anchors={owned} size={260} /></div>
              <div className="order-2">
                <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--teal)]">Your place in the lattice</div>
                <h2 className="mt-1 text-xl font-semibold text-text">The seats you hold, across the six classes</h2>
                <p className="mt-1 text-sm text-muted">Each ring is one of the six anchor classes. The lit arc is what you hold, and the teal tick marks seats you have opened to contribution. Manage transfers and contributions below.</p>
              </div>
            </div>
          </Card>
          <YourLattice seats={owned} />
          <OwnedSeats seats={owned} busy={busy} onRefresh={load}
            onTransfer={(seatId, to) => signAnchorTx("anchor_transfer", { seatId, to }, NodeApi.submitAnchorTransfer)}
            onBatchTransfer={(seatIds, to) => signAnchorTx("anchor_position_transfer", { seatIds, to }, NodeApi.submitAnchorPositionTransfer)}
            onSetContributions={(seatIds, open) => signAnchorTx("anchor_set_contributions", { seatIds, open }, NodeApi.submitAnchorSetContributions)}
            onActivate={(seatId) => signAnchorTx("anchor_activate", { seatId }, NodeApi.submitAnchorActivate)} />
        </>
      )}
    </div>
  );
}
