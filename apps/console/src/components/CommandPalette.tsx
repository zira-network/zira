// apps/console/src/components/CommandPalette.tsx
// Cmd/Ctrl+K command palette: a fuzzy-filtered launcher to navigate to any tab/route and run a few key
// actions. Accessible by design: it traps focus, supports arrow-key navigation, Enter to select, and
// Escape to close. The global key handler (Cmd/Ctrl+K to open, Escape to close any open panel) lives in
// useGlobalShortcuts, mounted once at the app root.
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  MessageSquare, Wallet as WalletIcon, Bot, CircuitBoard, Network, Hexagon,
  BookOpen, Settings as SettingsIcon, Crown, Zap, Search, Moon, Sun, PanelLeftClose,
} from "lucide-react";
import { useUi } from "../store/useUi";
import { useZira } from "../store/useZira";
import { isDesktop } from "../lib/platform";

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: typeof MessageSquare;
  run: () => void;
  keywords?: string;
}

// A tiny subsequence fuzzy match: every character of the query must appear in order in the haystack.
// Returns a score (lower is better, earlier/tighter matches rank higher) or null when there is no match.
function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let ti = 0, score = 0, lastHit = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]!;
    const found = t.indexOf(c, ti);
    if (found === -1) return null;
    if (lastHit >= 0) score += found - lastHit; // reward adjacency
    score += found; // reward early matches
    lastHit = found;
    ti = found + 1;
  }
  return score;
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const navigate = useNavigate();
  const { isFounder, isStewardWallet } = useZira();
  const showSteward = isFounder || isStewardWallet;

  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const toggleTheme = useCallback(() => {
    const current = (document.documentElement.dataset.theme as "dark" | "light") || "dark";
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("zira.theme", next);
  }, []);

  const commands = useMemo<Command[]>(() => {
    const go = (to: string) => () => { navigate(to); setOpen(false); };
    const list: Command[] = [
      { id: "nav-console", label: "Go to Console", hint: "Ask the field", icon: MessageSquare, run: go("/"), keywords: "chat ask home" },
      { id: "nav-resonators", label: "Go to Resonators", icon: Bot, run: go("/resonators"), keywords: "agents personas" },
      { id: "nav-discover", label: "Go to Discover", icon: CircuitBoard, run: go("/marketplace"), keywords: "marketplace hire" },
      ...(isDesktop() ? [{ id: "nav-mine", label: "Go to Mine", icon: Zap, run: go("/mine"), keywords: "earn hardware contribute" } as Command] : []),
      { id: "nav-wallet", label: "Go to Wallet", icon: WalletIcon, run: go("/wallet"), keywords: "balance zir keys" },
      { id: "nav-explorer", label: "Go to Explorer", icon: Network, run: go("/explorer"), keywords: "ledger blocks locks" },
      { id: "nav-anchors", label: "Go to Anchors", icon: Hexagon, run: go("/anchors"), keywords: "positions seats vesting" },
      { id: "nav-learn", label: "Go to Learn", icon: BookOpen, run: go("/learn"), keywords: "docs help guide" },
      { id: "nav-settings", label: "Go to Settings", icon: SettingsIcon, run: go("/settings"), keywords: "connection node shortcuts" },
      ...(showSteward ? [{ id: "nav-steward", label: "Go to Steward", hint: "Stewardship tools", icon: Crown, run: go("/founder"), keywords: "founder anchors reserve" } as Command] : []),
      { id: "act-theme", label: "Toggle light / dark theme", icon: document.documentElement.dataset.theme === "light" ? Moon : Sun, run: () => { toggleTheme(); setOpen(false); }, keywords: "appearance color mode" },
      { id: "act-sidebar", label: "Collapse or expand the sidebar", icon: PanelLeftClose, run: () => { useUi.getState().toggleSidebar(); setOpen(false); }, keywords: "nav rail" },
    ];
    return list;
  }, [navigate, setOpen, showSteward, toggleTheme]);

  const results = useMemo(() => {
    if (!query.trim()) return commands;
    return commands
      .map((c) => ({ c, score: fuzzyScore(query.trim(), `${c.label} ${c.keywords ?? ""}`) }))
      .filter((r): r is { c: Command; score: number } => r.score !== null)
      .sort((a, b) => a.score - b.score)
      .map((r) => r.c);
  }, [commands, query]);

  // Reset query/selection each time the palette opens, and focus the input.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIdx(0);
      // focus after paint so the input exists
      const id = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(id);
    }
  }, [open]);

  // Keep the active index in range as results change.
  useEffect(() => { setActiveIdx((i) => Math.min(i, Math.max(0, results.length - 1))); }, [results.length]);

  // Scroll the active row into view as the user arrows through.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIdx]);

  if (!open) return null;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(results.length - 1, i + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); results[activeIdx]?.run(); }
    else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
    else if (e.key === "Tab") { e.preventDefault(); /* focus trap: keep focus on the input */ inputRef.current?.focus(); }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center p-4 pt-[12vh]" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[2px] fade-in-up" onClick={() => setOpen(false)} />
      <div className="glass glass-lit relative w-full max-w-lg overflow-hidden rounded-2xl border border-hairline bg-[var(--bg-panel)] shadow-[var(--shadow-float)] backdrop-blur-xl fade-in-up" onKeyDown={onKeyDown}>
        <div className="flex items-center gap-2 border-b border-hairline px-4 py-3">
          <Search size={16} className="shrink-0 text-faint" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search commands and pages..."
            aria-label="Search commands"
            aria-controls="command-palette-list"
            aria-activedescendant={results[activeIdx] ? `cmd-${results[activeIdx]!.id}` : undefined}
            className="w-full bg-transparent text-sm text-text placeholder:text-faint outline-none"
          />
          <kbd className="hidden rounded border border-hairline bg-base px-1.5 py-0.5 text-[10px] text-faint sm:inline">Esc</kbd>
        </div>
        <div ref={listRef} id="command-palette-list" role="listbox" aria-label="Commands" className="max-h-[50vh] overflow-auto py-1.5">
          {results.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-faint">No commands match &ldquo;{query}&rdquo;. Try a page name like &ldquo;wallet&rdquo; or &ldquo;settings&rdquo;.</div>
          ) : results.map((c, idx) => (
            <button
              key={c.id}
              id={`cmd-${c.id}`}
              data-idx={idx}
              role="option"
              aria-selected={idx === activeIdx}
              onMouseMove={() => setActiveIdx(idx)}
              onClick={() => c.run()}
              className={`flex w-full items-center gap-3 border-l-2 px-4 py-2 text-left text-sm transition-colors ${idx === activeIdx ? "border-[var(--accent)] bg-elevated text-text" : "border-transparent text-muted hover:bg-elevated/60"}`}
            >
              <c.icon size={16} className={idx === activeIdx ? "text-[var(--accent)]" : "text-faint"} />
              <span className="flex-1">{c.label}</span>
              {c.hint && <span className="text-[11px] text-faint">{c.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
