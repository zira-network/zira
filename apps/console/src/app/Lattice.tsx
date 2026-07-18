// apps/console/src/app/Lattice.tsx
// "Your Lattice": the separate, premium owner space. It appears in the nav and renders here only when the
// wallet holds >= 1 anchor seat (revealed via `ownsAnchors` in the store). It leads with what the owner
// holds (YourLattice summary) and carries the full seat management (transfer, batch transfer, contributions),
// so the public Anchors page stays an explainer and ownership gets its own place in the app.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { type Anchor } from "@zira/protocol";
import { Card, useToast } from "../components/ui";
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
        <Card className="py-16 text-center text-sm text-faint">Loading your lattice...</Card>
      ) : owned.length === 0 ? (
        <Card className="field-hero py-16 text-center">
          <h2 className="title-glow text-2xl font-semibold tracking-tight">Your lattice</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted">You do not hold a seat yet. Anchors are the 512 permanent seats in the network&apos;s core, each carrying standing and a one-year ZIR allocation. When you hold one, this becomes your space.</p>
          <Link to="/anchors" className="mt-4 inline-block text-sm text-[var(--teal)]">Explore anchors &rarr;</Link>
        </Card>
      ) : (
        <>
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
