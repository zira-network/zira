// apps/web/src/components/ui.tsx
// Themed UI primitives. Colors come from CSS variables, never hardcoded hex.
import {
  createContext, useContext, useState, useCallback, useEffect, useRef,
  type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes,
  type TextareaHTMLAttributes, type SelectHTMLAttributes, type CSSProperties,
} from "react";
import { X } from "lucide-react";
import { cn } from "../lib/cn";

// ---- Button ----
type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export function Button({ variant = "secondary", className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const base = "inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-all duration-[var(--dur)] ease-[var(--ease)] disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none active:scale-[0.99]";
  const styles: Record<ButtonVariant, string> = {
    primary: "font-semibold text-[var(--accent-contrast)] bg-[var(--accent)] hover:bg-[color-mix(in_srgb,var(--accent)_90%,black)] shadow-[var(--shadow-1)] hover:shadow-[var(--shadow-2)]",
    secondary: "bg-surface text-text border border-hairline-strong hover:bg-elevated hover:border-[var(--border-strong)]",
    ghost: "text-muted hover:text-text hover:bg-elevated",
    danger: "font-medium text-white bg-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_88%,black)] shadow-[var(--shadow-1)] hover:shadow-[var(--shadow-2)]",
  };
  return <button className={cn(base, styles[variant], className)} {...props}>{children}</button>;
}

// ---- Card ----
export function Card({ className, children, onClick, style }: { className?: string; children: ReactNode; onClick?: () => void; style?: CSSProperties }) {
  return <div onClick={onClick} style={style} className={cn("relative overflow-hidden rounded-xl border border-hairline bg-surface p-5 text-text elevate", onClick && "lift cursor-pointer", className)}><div className="relative z-[1]">{children}</div></div>;
}

// ---- Field: a labelled form row with an optional hint ----
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-xs font-medium text-muted">{label}</label>
      {children}
      {hint && <p className="mt-1.5 text-[11px] leading-relaxed text-faint">{hint}</p>}
    </div>
  );
}

// ---- Input / Textarea / Select ----
const fieldBase = "field-surface w-full rounded-lg border border-hairline-strong px-3 py-2 text-sm text-text placeholder:text-faint transition-colors focus:border-[var(--accent)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)]";
export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(fieldBase, className)} {...props} />;
}
export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(fieldBase, "resize-y", className)} {...props} />;
}
export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(fieldBase, className)} {...props}>{children}</select>;
}

// ---- Badge ----
type Tone = "teal" | "indigo" | "warn" | "danger" | "neutral";
export function Badge({ tone = "neutral", className, children }: { tone?: Tone; className?: string; children: ReactNode }) {
  const tones: Record<Tone, string> = {
    teal: "text-[var(--teal)] border-[color-mix(in_srgb,var(--teal)_28%,transparent)] bg-[color-mix(in_srgb,var(--teal)_10%,transparent)]",
    indigo: "text-[var(--accent)] border-[color-mix(in_srgb,var(--accent)_28%,transparent)] bg-[var(--accent-soft)]",
    warn: "text-[var(--warn)] border-[color-mix(in_srgb,var(--warn)_28%,transparent)] bg-[color-mix(in_srgb,var(--warn)_10%,transparent)]",
    danger: "text-[var(--danger)] border-[color-mix(in_srgb,var(--danger)_28%,transparent)] bg-[color-mix(in_srgb,var(--danger)_10%,transparent)]",
    neutral: "text-muted border-hairline bg-elevated",
  };
  return <span className={cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium", tones[tone], className)}>{children}</span>;
}

// ---- Tooltip (simple title based) ----
export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return <span title={label} className="inline-flex">{children}</span>;
}

// ---- Spinner: a calm accent ring ----
export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin" aria-label="loading" style={{ animationDuration: "0.8s" }}>
      <circle cx="12" cy="12" r="9" fill="none" stroke="var(--border-strong)" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

// ---- Meter: any 0..1 value on the trust gradient ----
export function Meter({ value, label, className }: { value: number; label?: string; className?: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className={cn("w-full", className)}>
      {label && <div className="mb-1 flex justify-between text-xs text-muted"><span>{label}</span><span className="mono">{value.toFixed(2)}</span></div>}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-elevated">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: "var(--gradient)" }} />
      </div>
    </div>
  );
}

// ---- Modal ----
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title?: string; children: ReactNode; wide?: boolean }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  // Close on Escape, and move focus INTO the dialog on open / restore it to the trigger on close (standard
  // dialog behaviour, so keyboard + screen-reader users land in the dialog and return where they were). The
  // effect is declared before the early return so hooks order is stable; it only binds while open.
  useEffect(() => {
    if (!open) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => dialogRef.current?.focus());
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      cancelAnimationFrame(raf);
      prevFocus?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px] fade-in-up" onClick={onClose}
      role="dialog" aria-modal="true" aria-label={title}>
      <div ref={dialogRef} tabIndex={-1} className={cn("max-h-[90vh] w-full overflow-auto rounded-2xl border border-hairline bg-surface p-6 shadow-[var(--shadow-float)] focus:outline-none", wide ? "max-w-2xl" : "max-w-md")} onClick={(e) => e.stopPropagation()}>
        {title && (
          <div className="mb-5 flex items-center justify-between">
            <h3 className="text-lg font-semibold">{title}</h3>
            <button onClick={onClose} className="rounded-md p-1 text-muted transition-colors hover:bg-elevated hover:text-text"><X size={18} /></button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

// ---- Tabs ----
export function Tabs({ tabs, active, onChange }: { tabs: { id: string; label: string }[]; active: string; onChange: (id: string) => void }) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-hairline">
      {tabs.map((t) => (
        <button key={t.id} onClick={() => onChange(t.id)} role="tab" aria-selected={active === t.id}
          className={cn("px-3.5 py-2.5 text-sm font-medium -mb-px border-b-2 transition-colors",
            active === t.id ? "border-[var(--accent)] text-text" : "border-transparent text-muted hover:text-text")}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ---- Toast ----
interface Toast { id: number; message: string; tone: Tone; }
const ToastCtx = createContext<{ push: (m: string, tone?: Tone) => void } | null>(null);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Tone = "teal") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={{ push }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} onClick={() => setToasts((arr) => arr.filter((x) => x.id !== t.id))} role="button" title="Dismiss"
            className="fade-in-up flex max-w-sm cursor-pointer items-start gap-2.5 rounded-xl border border-hairline bg-surface px-4 py-3 text-sm shadow-[var(--shadow-float)] transition-colors hover:bg-elevated">
            <span className={cn("mt-[5px] inline-block h-1.5 w-1.5 shrink-0 rounded-full",
              t.tone === "danger" ? "bg-[var(--danger)]" : t.tone === "warn" ? "bg-[var(--warn)]" : "bg-[var(--teal)]")} />
            <span className={cn("leading-relaxed", t.tone === "danger" && "text-[var(--danger)]", t.tone === "warn" && "text-[var(--warn)]")}>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export function useToast() {
  const ctx = useContext(ToastCtx);
  if (!ctx) return { push: (_m: string, _t?: Tone) => {} };
  return ctx;
}

// ---- EmptyState ----
// An empty state can now carry a primary action, so a blank list always offers an obvious next step
// instead of dead-ending. `action` renders below the hint (pass a Button or any node).
export function EmptyState({ title, hint, children, action }: { title: string; hint?: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      {children}
      <div className="text-base font-semibold text-text">{title}</div>
      {hint && <div className="max-w-sm text-sm leading-relaxed text-muted">{hint}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

// ---- Breadcrumbs ----
// A simple breadcrumb trail for nested pages. Each crumb with an `href` is a router link (rendered by
// the caller via the `linkAs` slot is overkill, so we keep it dependency-free: callers pass plain {label,
// to} and we render <a>; React Router intercepts same-origin anchors through the HashRouter fine, but to
// stay framework-correct callers in this app pass already-resolved onClick handlers when needed). Here we
// render anchors that the surrounding Link/NavLink context handles; for in-app routes pass an onNavigate.
export function Breadcrumbs({ items }: { items: { label: string; onClick?: () => void }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-1 text-xs text-faint">
      {items.map((it, i) => (
        <span key={i} className="flex items-center gap-1">
          {it.onClick ? (
            <button onClick={it.onClick} className="transition-colors hover:text-text">{it.label}</button>
          ) : (
            <span className="text-muted">{it.label}</span>
          )}
          {i < items.length - 1 && <span aria-hidden className="text-faint">/</span>}
        </span>
      ))}
    </nav>
  );
}

// ---- PageHeader ----
// A consistent page header: optional breadcrumbs, a title, a one-line description, and a slot for a
// primary action on the right. Used across the section pages so navigation, headings, and the obvious
// primary action read the same way on every tab.
export function PageHeader({ title, description, breadcrumbs, action, badge }: {
  title: ReactNode;
  description?: ReactNode;
  breadcrumbs?: { label: string; onClick?: () => void }[];
  action?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      {breadcrumbs && breadcrumbs.length > 0 && <Breadcrumbs items={breadcrumbs} />}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight text-text">{title}</h2>
            {badge}
          </div>
          {description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
    </div>
  );
}

// ---- LoadingState: a spinner plus an optional "Taking longer than usual..." hint after ~10s ----
// Pass `slow` (e.g. from useSlowHint) to surface the reassurance line so a long load never feels stuck.
export function LoadingState({ label = "Loading...", slow = false }: { label?: string; slow?: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      <Spinner size={22} />
      <div className="text-sm text-muted">{label}</div>
      {slow && <div className="max-w-xs text-xs text-faint">Taking longer than usual. The node may be busy or syncing; this will keep trying.</div>}
    </div>
  );
}

// ---- ErrorState: an actionable error with a retry affordance, never a silent console.log ----
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-lg border border-[color-mix(in_srgb,var(--danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--danger)_8%,transparent)] p-3 text-sm text-muted">
      <span>{message}</span>
      {onRetry && <button onClick={onRetry} className="ml-2 underline transition-colors hover:text-text">Retry</button>}
    </div>
  );
}

// useSlowHint: returns true once `active` has been true continuously for ~10s, for views that manage their
// own loading state. Resets when `active` goes false. Cancels its timer on unmount.
export function useSlowHint(active: boolean, afterMs = 10_000): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!active) { setSlow(false); return; }
    const t = setTimeout(() => setSlow(true), afterMs);
    return () => clearTimeout(t);
  }, [active, afterMs]);
  return slow;
}

// ---- usePoll: a guarded interval hook ----
// Runs fn once immediately, then on an interval. To poll only when needed, it skips ticks while the
// browser tab is hidden and fires once on the way back to visible, so a backgrounded Console does not
// keep hammering the node. The immediate first call still runs so a freshly mounted view loads at once.
export function usePoll(fn: () => void, ms: number, deps: unknown[] = []) {
  useEffect(() => {
    const tick = () => { if (typeof document === "undefined" || !document.hidden) fn(); };
    fn();
    const id = setInterval(tick, ms);
    const onVis = () => { if (typeof document !== "undefined" && !document.hidden) fn(); };
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
