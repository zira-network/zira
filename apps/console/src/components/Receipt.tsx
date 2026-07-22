// apps/console/src/components/Receipt.tsx
// The Proof panel: a first-class, honest receipt for an answered field query. It makes ZIRA's "verify"
// promise concrete by showing WHO answered, their earned trust (domain ZTI), how much each shaped the
// fused answer (weight), the coordinated confidence, the cost, and a real ed25519 signature check per
// contributor. Every value is read straight from the AnswerReceipt the field already returns; nothing is
// fabricated. When a field the node did not send is absent, the panel omits it rather than inventing it.
import { useState, type ReactNode } from "react";
import { ShieldCheck, ChevronDown, ChevronUp, CheckCircle2, X, Coins, Radio } from "lucide-react";
import { verify as edVerify, type AnswerReceipt } from "@zira/protocol";
import { Card, Badge, Meter } from "./ui";
import { NeonDial, Bars } from "./viz";
import { formatZir, formatNum, shortHash, shortAddress } from "../lib/format";

// A contributor's self-reported confidence is not carried verbatim on the receipt: weight is the
// NORMALIZED share (domainZti x confidence, divided by the panel total). A newer node may attach a raw
// confidence/address; when it does not, recover an indicative confidence from weight / domainZti (bounded
// 0..1). Returns null when neither the raw value nor a valid recovery is available, so nothing is guessed.
function recoverConfidence(weight: number, domainZti: number): number | null {
  if (!Number.isFinite(weight)) return null;
  if (!Number.isFinite(domainZti) || domainZti <= 0) return null;
  return Math.max(0, Math.min(1, weight / domainZti));
}

// Trust is encoded visually: a contributor with high domain ZTI reads as teal-lit and credible; a low-trust
// voice stays dim. This keeps the accent meaningful (rationed to the trustworthy) rather than everywhere.
function isTrusted(domainZti: number): boolean {
  return Number.isFinite(domainZti) && domainZti >= 0.5;
}

export function Receipt({ receipt }: { receipt: AnswerReceipt }) {
  const [open, setOpen] = useState(false);
  const contributors = receipt.contributors;
  const n = contributors.length;
  const noProviders = n === 0;
  const hasConfidence = Number.isFinite(receipt.fusedConfidence) && receipt.fusedConfidence > 0;
  const maxWeight = contributors.reduce((m, c) => Math.max(m, Number.isFinite(c.weight) ? c.weight : 0), 0) || 1;
  const challengeMins = Number.isFinite(receipt.challengeOpenUntil)
    ? Math.max(0, Math.round((receipt.challengeOpenUntil - Date.now()) / 60000))
    : 0;

  return (
    <Card className="max-w-[92%] p-3">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 text-xs text-muted transition-colors hover:text-text"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ShieldCheck size={14} className={noProviders ? "text-[var(--warn)]" : "text-[var(--teal)]"} />
          {noProviders ? (
            <span className="truncate">How this was answered: no provider answered in time.</span>
          ) : (
            <span className="truncate">
              How this was answered: {n} answerer{n === 1 ? "" : "s"}, weighted by earned trust.
              {hasConfidence ? <> Confidence <span className="mono text-text">{formatNum(receipt.fusedConfidence, 2)}</span>.</> : null}
              {" "}Cost <span className="mono text-text">{formatZir(receipt.costUZIR)} ZIR</span>.
            </span>
          )}
        </span>
        <span className="shrink-0 text-faint">{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
      </button>

      {open && (
        <div className="fade-in-up mt-3">
          {noProviders ? (
            // Honest empty / timeout state, using the field motif. Never a fabricated receipt.
            <div className="flex items-start gap-3 rounded-xl border border-[color-mix(in_srgb,var(--warn)_35%,transparent)] bg-[color-mix(in_srgb,var(--warn)_8%,transparent)] p-3 text-xs text-muted">
              <Radio size={16} className="mt-0.5 shrink-0 text-[var(--warn)]" />
              <p className="leading-relaxed">
                Your question reached the field, but no online provider returned a signed answer in time. A machine
                has to be serving answers before the receipt can show who contributed. Nothing was charged.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {/* Hero: coordinated confidence dial + honest stat tiles from real receipt fields. */}
              <div className="flex flex-wrap items-center gap-4">
                {hasConfidence && (
                  <div className="shrink-0">
                    <NeonDial value={receipt.fusedConfidence} size={92} label={formatNum(receipt.fusedConfidence, 2)} sub="confidence" />
                  </div>
                )}
                <div className="grid min-w-[12rem] flex-1 grid-cols-2 gap-2 sm:grid-cols-3">
                  <StatTile label="Answerers" value={String(n)} />
                  <StatTile label="Cost" value={`${formatZir(receipt.costUZIR)} ZIR`} icon={<Coins size={12} />} teal={receipt.costUZIR === 0} />
                  {receipt.domain ? <StatTile label="Domain" value={receipt.domain} /> : null}
                </div>
              </div>

              {/* Convergence: how the fused answer's weight is distributed across the panel. This is the real,
                  normalized weight (domain ZTI x confidence), not a separate "agreement" figure the node
                  does not send. A concentrated bar = the panel leaned on a few trusted voices. */}
              {n > 1 && (
                <div className="rounded-xl border border-hairline bg-base/60 p-3">
                  <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-[0.12em] text-faint">
                    <span>Weight across the panel</span>
                    <span className="mono">{n} voices</span>
                  </div>
                  <Bars data={contributors.map((c) => (Number.isFinite(c.weight) ? c.weight : 0))} height={34} />
                </div>
              )}

              {/* Ranked contributors: who answered, their trust, share, model, verifiable signature, excerpt. */}
              <ol className="flex flex-col gap-2">
                {contributors.map((c, i) => {
                  const extra = c as typeof c & { confidence?: number; address?: string };
                  const conf = Number.isFinite(extra.confidence)
                    ? Math.max(0, Math.min(1, extra.confidence as number))
                    : recoverConfidence(c.weight, c.domainZti);
                  const who = extra.address ? shortAddress(extra.address) : shortHash(c.provider);
                  const hasZti = Number.isFinite(c.domainZti);
                  const trusted = hasZti && isTrusted(c.domainZti);
                  const weightPct = Number.isFinite(c.weight) ? Math.round((c.weight / maxWeight) * 100) : 0;
                  // Verify the ed25519 signature over the exact bytes the provider signed (queryId + "\n" +
                  // answer). A check means checked, not decorative. Older nodes that omit the signed payload
                  // read as honestly "unverifiable".
                  const verifiable = !!c.sig && !!c.queryId && typeof c.answer === "string";
                  const sigOk = verifiable ? edVerify(`${c.queryId}\n${c.answer}`, c.sig, c.provider) : false;
                  return (
                    <li
                      key={i}
                      className="rounded-xl border border-hairline bg-surface p-3 transition-colors"
                      style={trusted ? { boxShadow: "inset 2px 0 0 0 var(--brand-teal)" } : undefined}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="shrink-0 mono text-[10px] text-faint">#{i + 1}</span>
                            <span className={`truncate text-sm font-medium ${trusted ? "text-text" : "text-muted"}`}>{c.label || who}</span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-faint">
                            {c.model ? <span className="truncate">{c.model}</span> : null}
                            <span className="mono">provider {who}</span>
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className={`mono text-sm ${trusted ? "text-[var(--teal)]" : "text-muted"}`}>{hasZti ? formatNum(c.domainZti, 2) : "-"}</div>
                          <div className="text-[10px] uppercase tracking-[0.1em] text-faint">trust</div>
                        </div>
                      </div>

                      {hasZti && <Meter value={c.domainZti} className="mt-2" />}

                      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-faint">
                        <span>share <span className="mono text-muted">{weightPct}%</span></span>
                        {conf != null && <span>confidence <span className="mono text-muted">{formatNum(conf, 2)}</span></span>}
                      </div>

                      {c.excerpt ? <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-muted">{c.excerpt}</p> : null}

                      {c.sig ? (
                        <div className="mt-2 flex items-center gap-1.5 text-[11px]">
                          {sigOk ? (
                            <><CheckCircle2 size={12} className="text-[var(--teal)]" /><span className="text-muted">signature verified</span></>
                          ) : verifiable ? (
                            <><X size={12} className="text-[var(--warn)]" /><span className="text-[var(--warn)]">signature invalid</span></>
                          ) : (
                            <><ShieldCheck size={12} className="text-faint" /><span className="text-faint">signature unverifiable</span></>
                          )}
                          <span className="mono text-faint">{shortHash(c.sig)}</span>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ol>

              {/* Provenance badges: only what the receipt actually carries. */}
              <div className="flex flex-wrap items-center gap-2">
                {receipt.domain ? <Badge tone="neutral">domain: {receipt.domain}</Badge> : null}
                {receipt.proofAvailable ? <Badge tone="warn">proof available</Badge> : null}
                {challengeMins > 0 ? <Badge tone="indigo">challenge open {challengeMins}m</Badge> : null}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function StatTile({ label, value, icon, teal }: { label: string; value: string; icon?: ReactNode; teal?: boolean }) {
  return (
    <div className="rounded-xl border border-hairline bg-base/60 px-3 py-2">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-[0.12em] text-faint">{icon}<span>{label}</span></div>
      <div className={`mt-1 truncate text-sm font-medium ${teal ? "text-[var(--teal)]" : "text-text"}`}>{value}</div>
    </div>
  );
}
