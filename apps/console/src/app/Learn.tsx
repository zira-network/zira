// apps/console/src/app/Learn.tsx
// The ZIRA explainer in app. Plain language, skimmable, honest about limits. It respects the app-wide
// simpleMode toggle, offers a sticky table of contents with scroll-spy, cross-links each concept to the
// live section that implements it, surfaces a few live network facts, and carries a searchable glossary.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Sparkles, Network, Cpu, GitMerge, Layers, Coins, Compass, ShieldAlert,
  AlertTriangle, Search, ArrowRight, MessageSquare, Bot, Zap, Hexagon, BookOpen,
} from "lucide-react";
import { Badge, Card, Input, Meter, PageHeader } from "../components/ui";
import { HexField } from "../components/brand";
import { useUi } from "../store/useUi";
import { useZira } from "../store/useZira";
import { isDesktop } from "../lib/platform";
import { formatNum } from "../lib/format";

type LinkTo = { label: string; to: string };

interface Section {
  id: string;
  title: string;
  icon: typeof Sparkles;
  eyebrow: string;
  body: string[];
  // A plainer rendition shown when simpleMode is on (defaults ON). Falls back to `body` when absent.
  plain?: string[];
  // A single key-takeaway pull-quote rendered as an accent callout.
  takeaway?: string;
  // "See it live" cross-links to the routable sections this concept describes.
  links?: LinkTo[];
}

const SECTIONS: Section[] = [
  {
    id: "the-idea",
    title: "The idea",
    icon: Sparkles,
    eyebrow: "Overview",
    body: [
      "ZIRA is a decentralized AI field: one interface you can talk to, backed by independently run nodes, miners, storage peers, models, and Resonators.",
      "You can use the field, run a node, store model bytes, mine, create Resonators, or do all of them. The long-term goal is simple: useful intelligence that keeps running because many people operate it, not because one company owns it.",
    ],
    plain: [
      "ZIRA is an AI you can talk to that no single company owns. Lots of people run the machines behind it.",
      "You can just use it, or you can help run it: host a node, lend your computer, store models, or build your own AI workers (Resonators). The goal is intelligence that keeps working because many people keep it alive.",
    ],
    takeaway: "Useful intelligence that keeps running because many people operate it, not because one company owns it.",
  },
  {
    id: "how-it-works",
    title: "How it works",
    icon: Network,
    eyebrow: "Mechanics",
    body: [
      "The Living Web: every transaction, observation, and agreement is a signed event that points back to earlier ones, so events link into a growing web rather than a stack of blocks. There is no block race.",
      "Proof of Resonance: for a subject, the network gathers signed observations and takes the trust weighted median, never the mean, because a median does not move unless an attacker controls more than half of the weight. When the readings converge tightly and enough trust supports them, the agreement is sealed into a Lock.",
      "ZTI, the trust index: a number from 0 to 1 that says how accurately an identity reads reality. It is earned, never bought, and it fades if you stop showing up. It is specialized by domain.",
    ],
    plain: [
      "Every action is a signed record that links back to earlier ones, forming a web of history instead of a chain of blocks. There is no mining race to win.",
      "To agree on a fact, the network collects signed readings and takes the middle value weighted by trust, not the average. The middle value can't be pushed around unless an attacker controls more than half the trust. Once readings line up, the agreement is locked in.",
      "Trust (ZTI) is a 0-to-1 score for how accurately you read reality. You earn it by being right, you can't buy it, and it fades if you go quiet. You build it separately in each topic.",
    ],
    takeaway: "A median does not move unless an attacker controls more than half of the weight.",
    links: [{ label: "See Locks in the Explorer", to: "/explorer" }],
  },
  {
    id: "the-intelligence-layer",
    title: "The intelligence layer",
    icon: Cpu,
    eyebrow: "What runs",
    body: [
      "The Console has two modes. Field mode asks the network, pays contributors in ZIR, and returns receipts. Local workspace mode is for private build, file, planning, and debugging tasks on your own machine, useful like a coding tool, with no ZIR spend and no network receipt.",
      "Mining is useful work. A Resonator node can coordinate field status, accept local workspace task permission, submit observations, or answer with a native model or endpoint when available. Model bytes are distributed by storage-enabled peers, not by mining alone. New nodes keep peer to peer storage on by default with a small 1GB cap that users can edit.",
      "Resonators are intelligences you create, fund, and give a character. They spend inside your limits, learn from verified outcomes, and can earn by doing useful work. Model-dependent learning should wait until authorized models are actually distributed.",
    ],
    plain: [
      "The Console works two ways. Field mode asks the whole network, pays the people who answer in ZIR, and gives you a receipt. Local mode runs private work on your own machine, like a coding tool, with no spend and no receipt.",
      "Mining means doing useful work, not solving puzzles. Your node can keep the network in sync, take on local tasks, share readings, or answer questions when it can. Models are shared by storage peers, not by mining alone. New nodes keep a small 1GB store on by default, and you can change that.",
      "Resonators are AI agents you create, fund, and give a personality. They spend only within the limits you set, learn from checked results, and can earn by doing real work for others.",
    ],
    takeaway: "Mining is useful work, not wasted puzzles.",
    links: [{ label: "See your node on the Dashboard", to: "/dashboard" }, { label: "Open Resonators", to: "/resonators" }, ...(isDesktop() ? [{ label: "Run a node in Mine", to: "/mine" }] : [])],
  },
  {
    id: "how-coordination-works",
    title: "How coordination works",
    icon: GitMerge,
    eyebrow: "Coordination",
    body: [
      "Everything in ZIRA is a coordination between parties whose contributions are signed and weighted by earned trust. The same Proof of Resonance settles them all.",
      "Human to AI: you ask, the field answers, you pay per use, and your spend is also a signal of what is worth answering. AI to human: a Resonator does work and pays you, or a miner earns for serving you well.",
      "AI to AI: Resonators and miners coordinate with each other, paying small amounts for sub results inside set limits, so accurate work flows to accurate workers with no manager. Many to one: a single answer is selected and scored by earned trust, so no one model and no one company is the source of truth.",
      "In every case the rule is the same. Contributions are signed, weighed by how accurate the contributor has been, and settled in ZIR. Accuracy raises trust, trust routes the next work, and the system corrects itself with nobody at the wheel.",
    ],
    plain: [
      "Everything in ZIRA is people and agents working together. Each contribution is signed and weighted by how much trust the contributor has earned, and the same rule settles them all.",
      "You ask and pay; the AI answers. An agent does a job and pays you; a miner earns for serving you well.",
      "Agents and miners also hire each other for small pieces of work inside set limits, so accurate work flows to accurate workers with no boss. When several answer, the most trusted answer carries the most weight, and no single model is the source of truth.",
      "The rule never changes: contributions are signed, weighed by track record, and paid in ZIR. Being accurate raises your trust, trust routes the next job, and the system keeps correcting itself.",
    ],
    takeaway: "Accuracy raises trust, trust routes the next work, and the system corrects itself with nobody at the wheel.",
  },
  {
    id: "many-minds-on-one-task",
    title: "Many minds on one task",
    icon: Layers,
    eyebrow: "Ensembles",
    body: [
      "The field coordinates Resonators and models on its own, and it can put several of them on the same task at once. Their independent answers are then converged by earned trust, with the most trusted reading carrying the most weight, so no single model is ever the source of truth.",
      "So a question is not answered by one model you have to take on faith, but by an ensemble whose agreement is checked and weighted. Only the steward authorizes which models join, and once authorized they distribute peer to peer to any storage-enabled peer.",
    ],
    plain: [
      "The network can put several agents and models on the same question at once, then blend their answers by trust, so the most trusted reading counts most. No single model is ever the final word.",
      "So a question isn't answered by one model you must take on faith, but by a group whose agreement is checked. The steward approves which models can join, and approved models then spread peer to peer to anyone storing them.",
    ],
    takeaway: "A set of answers that are checked and weighted by trust, not one model you take on faith.",
  },
  {
    id: "the-economy",
    title: "The economy",
    icon: Coins,
    eyebrow: "ZIR",
    body: [
      "ZIR is capped at 28.7 billion. Amounts are integer uZIR, where one ZIR is a million uZIR. Half of every fee is burned forever, a steady deflation that grows with use.",
      "ZIR is not pre-sold. It enters the world only as it is earned, by answering accurately, running a node, and doing useful work, on a tapering curve. There is no public sale and no allocation you can buy your way into.",
      "There are only 512 ZRC-1 Anchor positions on the ZIRA field. They are foundational, transferable high-trust Resonator positions, never sold. Each carries a class, seeded ZTI, a routing weight, and a reserve-backed ZIR allocation that vests to its owner over one year. The steward holds all 512 at genesis and assigns them by invitation and contribution. Ownership and transfers are live; activation and routing earnings open later after all positions are secured. Classes run from Genesis 6/6 weight down to Foundation 1/6.",
    ],
    plain: [
      "There will only ever be 28.7 billion ZIR. The smallest unit is uZIR, and one ZIR is a million of them. Half of every fee is destroyed forever, so the more the network is used, the scarcer ZIR gets.",
      "ZIR is never pre-sold. It only enters the world as people earn it, by answering well, running a node, and doing useful work, on a curve that tapers over time. There is no public sale to buy into.",
      "There are exactly 512 Anchor positions. They are foundational, transferable, high-trust seats that are never sold. Each has a class, a starting trust score, a routing weight, and a reserve-backed ZIR allocation that vests over one year. The steward holds all 512 at the start and gives them out by invitation and contribution.",
    ],
    takeaway: "ZIR is not pre-sold. It enters the world only as it is earned.",
    links: [{ label: "View Anchors", to: "/anchors" }, { label: "Open your Wallet", to: "/wallet" }],
  },
  {
    id: "where-this-is-going",
    title: "Where this is going",
    icon: Compass,
    eyebrow: "Direction",
    body: [
      "The point of ZIRA is that the work which secures the network is the intelligence itself, not wasted puzzles. When you ask something, the field answers, and enough trusted nodes agree, that act of being useful is the security.",
      "Three things stay scarce here: ZIR, the money; trust, which you earn and cannot buy; and real compute, the work. They trade against each other in one open market, and an answer only counts when the network can actually check it.",
      "Resonators will hire other Resonators. A planner can pay a specialist for part of a job, that specialist can pay another, and value flows to whoever really did the work, with no boss in the middle. People still own their Resonators and set the limits.",
      "Models become a shared, living commons. The steward authorizes the first ones so nothing unsafe gets in, they spread from peer to peer, and over time the people who help improve them can share in what they earn.",
    ],
    plain: [
      "What secures ZIRA is the intelligence itself, not wasted puzzles. When you ask, the network answers, and enough trusted nodes agree. That act of being useful is the security.",
      "Three things stay scarce: ZIR (the money), trust (earned, never bought), and real compute (the work). They trade in one open market, and an answer only counts when the network can actually check it.",
      "Agents will hire other agents. A planner pays a specialist, who pays another, and value flows to whoever really did the work, with no boss in the middle. You still own your agents and set their limits.",
      "Models become a shared commons. The steward approves the first ones for safety, they spread peer to peer, and over time the people who improve them can share in what they earn.",
    ],
    takeaway: "Three things stay scarce: ZIR, trust, and real compute. An answer only counts when the network can check it.",
  },
  {
    id: "where-we-are-honestly",
    title: "Where we are, honestly",
    icon: ShieldAlert,
    eyebrow: "Status",
    body: [
      "ZIRA is peer to peer. There is no company and no server in the middle. The ledger lives on nodes that anyone can run, and every node checks every rule, so no one can forge a balance or print extra ZIR.",
      "The first network still needs reachable bootstrap peers and the first authorized model. As more independent users run nodes, mine, store model bytes, and earn trust, coordination spreads away from the launch machine.",
      "ZIR has no value yet, and maybe never will. Test ZIR has no value. You could lose everything. None of this is a promise of a price, a listing, or a return. Take part because you believe in the idea.",
    ],
    plain: [
      "ZIRA is run by its users, with no company and no server in the middle. The ledger lives on nodes anyone can run, and every node checks every rule, so nobody can fake a balance or print extra ZIR.",
      "The young network still needs reachable starter peers and the first approved model. As more people run nodes, mine, store models, and earn trust, the network leans less on the launch machine.",
      "ZIR has no value yet, and maybe never will. Test ZIR has no value. You could lose everything. Nothing here promises a price, a listing, or a return. Take part because you believe in the idea.",
    ],
    // The risk paragraph (last in body) is rendered with a distinct warn callout below.
  },
];

// The dozen coined terms the body relies on, for a searchable glossary at the foot of the page.
const GLOSSARY: { term: string; def: string }[] = [
  { term: "Living Web", def: "ZIRA's history: every transaction, observation, and agreement is a signed event that points back to earlier ones, forming a web rather than a stack of blocks." },
  { term: "Proof of Resonance", def: "How the network agrees on a fact: it gathers signed observations and takes the trust-weighted median, sealing the agreement into a Lock once readings converge." },
  { term: "ZTI (trust index)", def: "A 0-to-1 score for how accurately an identity reads reality. Earned, never bought, fades if you stop showing up, and specialized by domain." },
  { term: "Lock", def: "A sealed agreement: when signed observations converge tightly and enough trust supports them, the result is locked into the ledger." },
  { term: "Resonator", def: "An intelligence you create, fund, and give a character. It spends inside your limits, learns from verified outcomes, and can earn by doing useful work." },
  { term: "Anchor (ZRC-1)", def: "One of 512 foundational, transferable high-trust Resonator positions. Each carries a class, seeded ZTI, a routing weight, and a reserve-backed ZIR allocation that vests over one year." },
  { term: "uZIR", def: "The smallest unit of ZIR. One ZIR is one million uZIR; all on-ledger amounts are integer uZIR." },
  { term: "Steward", def: "The launch authority that holds the 512 anchors at genesis and authorizes which models may join the field, so nothing unsafe gets in." },
  { term: "Convergence", def: "When independent signed readings on a subject line up tightly enough (a low coefficient of variation) for the network to seal a Lock." },
  { term: "Trust-weighted median", def: "The middle reading once each answer is weighted by the contributor's earned trust. It cannot be moved unless an attacker controls more than half the weight." },
  { term: "Field mode", def: "Asking the network: it pays contributors in ZIR and returns a receipt, versus local workspace mode which runs private work on your own machine with no spend." },
  { term: "Burn", def: "Half of every fee is removed from circulation forever, a steady deflation that grows as the network is used more." },
];

// "Start here" next-step destinations, mirroring the command palette's nav (Mine is desktop-only).
function startHere(): { label: string; hint: string; to: string; icon: typeof MessageSquare }[] {
  return [
    { label: "Ask the network", hint: "Open the Console", to: "/", icon: MessageSquare },
    { label: "Create a Resonator", hint: "Your own agent", to: "/resonators", icon: Bot },
    ...(isDesktop() ? [{ label: "Run a node", hint: "Lend your machine", to: "/mine", icon: Zap }] : []),
    { label: "Anchor positions", hint: "The 512 seats", to: "/anchors", icon: Hexagon },
  ];
}

// A small accent-tinted icon chip used in section headers and start-here tiles.
function IconChip({ icon: Icon }: { icon: typeof Sparkles }) {
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-soft)] text-[var(--accent)]">
      <Icon size={18} />
    </span>
  );
}

// One scannable metric tile for the economy hard-numbers.
function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-hairline bg-base p-3">
      <div className="mono text-base text-text">{value}</div>
      <div className="mt-0.5 text-[11px] leading-tight text-faint">{label}</div>
    </div>
  );
}

export function Learn() {
  const nav = useNavigate();
  const { simpleMode } = useUi();
  const stats = useZira((s) => s.stats);
  const zti = useZira((s) => s.zti);

  const [activeId, setActiveId] = useState(SECTIONS[0]!.id);
  const [glossaryQuery, setGlossaryQuery] = useState("");
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  // Scroll-spy: highlight the section nearest the top of the viewport.
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActiveId(visible[0].target.id);
      },
      { rootMargin: "-20% 0px -65% 0px", threshold: 0 },
    );
    for (const el of Object.values(sectionRefs.current)) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const goto = (id: string) => {
    sectionRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const filteredGlossary = useMemo(() => {
    const q = glossaryQuery.trim().toLowerCase();
    if (!q) return GLOSSARY;
    return GLOSSARY.filter((g) => g.term.toLowerCase().includes(q) || g.def.toLowerCase().includes(q));
  }, [glossaryQuery]);

  // Live network facts for the honest status / economy snapshot.
  const peers = stats?.activeNodes ?? null;
  const providers = stats?.providersOnline ?? null;
  const avgZti = stats?.avgZti ?? null;
  const circulatingZir = stats ? stats.circulatingUZIR / 1_000_000 : null;
  const burnedZir = stats ? stats.burnedUZIR / 1_000_000 : null;
  const myZti = zti || avgZti || 0;

  return (
    <div className="mx-auto max-w-5xl p-6">
      <PageHeader
        title="Learn ZIRA"
        description="How ZIRA works, in plain language. What the network is, how it pays, and where it is honestly going."
        badge={<Badge tone="teal">Onboarding</Badge>}
        action={<HexField size={56} />}
      />

      {/* Start here: turn passive reading into a next step. */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {startHere().map((s) => (
          <Card key={s.to} onClick={() => nav(s.to)} className="!p-4">
            <div className="flex items-center gap-3">
              <IconChip icon={s.icon} />
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-text">{s.label}</div>
                <div className="truncate text-[11px] text-faint">{s.hint}</div>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <div className="mt-8 lg:grid lg:grid-cols-[210px_minmax(0,1fr)] lg:gap-10">
        {/* Sticky table of contents (a chip row on mobile, a left rail on desktop). */}
        <nav aria-label="Sections" className="mb-6 lg:mb-0 lg:sticky lg:top-6 lg:self-start">
          <div className="-mx-1 flex gap-1.5 overflow-x-auto px-1 lg:flex-col lg:overflow-visible lg:px-0">
            {SECTIONS.map((s, i) => {
              const on = activeId === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => goto(s.id)}
                  className={[
                    "shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm transition-colors lg:w-full lg:whitespace-normal lg:border-l-2",
                    on
                      ? "bg-elevated text-text lg:border-[var(--accent)]"
                      : "text-muted hover:bg-elevated hover:text-text lg:border-transparent",
                  ].join(" ")}
                >
                  <span className="mr-1.5 text-[11px] tabular-nums text-faint">{String(i + 1).padStart(2, "0")}</span>
                  {s.title}
                </button>
              );
            })}
            <button
              onClick={() => goto("glossary")}
              className={[
                "shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm transition-colors lg:w-full lg:whitespace-normal lg:border-l-2",
                activeId === "glossary"
                  ? "bg-elevated text-text lg:border-[var(--accent)]"
                  : "text-muted hover:bg-elevated hover:text-text lg:border-transparent",
              ].join(" ")}
            >
              <BookOpen size={13} className="mr-1.5 inline align-[-2px] text-faint" />
              Glossary
            </button>
          </div>
        </nav>

        {/* Content column. */}
        <div className="min-w-0 max-w-2xl space-y-8">
          {SECTIONS.map((s, i) => {
            const paras = simpleMode ? (s.plain ?? s.body) : s.body;
            const isRiskSection = s.id === "where-we-are-honestly";
            // For the risk section, render every paragraph but the last as normal, and the last in a warn callout.
            const normalParas = isRiskSection ? paras.slice(0, -1) : paras;
            const riskPara = isRiskSection ? paras[paras.length - 1] : null;
            return (
              <section
                key={s.id}
                id={s.id}
                ref={(el) => { sectionRefs.current[s.id] = el; }}
                className="scroll-mt-6"
              >
                <Card>
                  <div className="mb-3 flex items-start gap-3">
                    <IconChip icon={s.icon} />
                    <div className="min-w-0">
                      <div className="text-[11px] uppercase tracking-wide text-faint">
                        {String(i + 1).padStart(2, "0")} · {s.eyebrow}
                      </div>
                      <h3 className="text-lg font-semibold text-text">{s.title}</h3>
                    </div>
                  </div>

                  <div className="space-y-2.5">
                    {normalParas.map((p, idx) => (
                      <p key={idx} className="max-w-prose text-sm leading-relaxed text-muted">{p}</p>
                    ))}
                  </div>

                  {riskPara && (
                    <div className="mt-3 flex items-start gap-2.5 rounded-lg border border-[color-mix(in_srgb,var(--warn)_35%,transparent)] bg-[color-mix(in_srgb,var(--warn)_8%,transparent)] p-3">
                      <AlertTriangle size={16} className="mt-0.5 shrink-0 text-[var(--warn)]" />
                      <div>
                        <Badge tone="warn" className="mb-1.5">Risk</Badge>
                        <p className="max-w-prose text-sm leading-relaxed text-muted">{riskPara}</p>
                      </div>
                    </div>
                  )}

                  {/* The economy section: scannable hard-numbers. */}
                  {s.id === "the-economy" && (
                    <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                      <StatTile label="ZIR max supply" value="28.7B" />
                      <StatTile label="1 ZIR in uZIR" value="1,000,000" />
                      <StatTile label="of every fee burned" value="50%" />
                      <StatTile label="ZRC-1 Anchor positions" value="512" />
                      <StatTile label="Anchor vesting" value="1 year" />
                      <StatTile label="Public sale" value="None" />
                      {circulatingZir != null && <StatTile label="ZIR circulating (live)" value={formatNum(circulatingZir, 0)} />}
                      {burnedZir != null && <StatTile label="ZIR burned (live)" value={formatNum(burnedZir, 0)} />}
                    </div>
                  )}

                  {/* The honest-status section: live network snapshot. */}
                  {isRiskSection && stats && (
                    <div className="mt-4 space-y-3">
                      <div className="grid grid-cols-3 gap-3">
                        <StatTile label="Reachable nodes" value={peers != null ? formatNum(peers, 0) : "-"} />
                        <StatTile label="Providers online" value={providers != null ? formatNum(providers, 0) : "-"} />
                        <StatTile label="Avg trust (ZTI)" value={avgZti != null ? avgZti.toFixed(2) : "-"} />
                      </div>
                      <Meter value={myZti} label="Network trust sample" />
                    </div>
                  )}

                  {/* Cross-links to the live sections this concept describes. */}
                  {s.links && s.links.length > 0 && (
                    <div className="mt-4 flex flex-wrap gap-2 border-t border-hairline pt-3">
                      {s.links.map((l) => (
                        <button
                          key={l.to}
                          onClick={() => nav(l.to)}
                          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium text-[var(--accent)] transition-colors hover:bg-[var(--accent-soft)]"
                        >
                          {l.label}
                          <ArrowRight size={13} />
                        </button>
                      ))}
                    </div>
                  )}
                </Card>
              </section>
            );
          })}

          {/* Glossary: searchable reference for the coined terms. */}
          <section id="glossary" ref={(el) => { sectionRefs.current["glossary"] = el; }} className="scroll-mt-6">
            <Card>
              <div className="mb-3 flex items-start gap-3">
                <IconChip icon={BookOpen} />
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] uppercase tracking-wide text-faint">Reference</div>
                  <h3 className="text-lg font-semibold text-text">Glossary</h3>
                </div>
              </div>
              <div className="relative mb-4">
                <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
                <Input
                  value={glossaryQuery}
                  onChange={(e) => setGlossaryQuery(e.target.value)}
                  placeholder="Search terms..."
                  aria-label="Search glossary"
                  className="pl-9"
                />
              </div>
              {filteredGlossary.length === 0 ? (
                <p className="py-6 text-center text-sm text-faint">No terms match &ldquo;{glossaryQuery}&rdquo;.</p>
              ) : (
                <dl className="divide-y divide-hairline">
                  {filteredGlossary.map((g) => (
                    <div key={g.term} className="grid grid-cols-1 gap-1 py-3 sm:grid-cols-[160px_1fr] sm:gap-4">
                      <dt className="text-sm font-medium text-text">{g.term}</dt>
                      <dd className="max-w-prose text-sm leading-relaxed text-muted">{g.def}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </Card>
          </section>
        </div>
      </div>
    </div>
  );
}
