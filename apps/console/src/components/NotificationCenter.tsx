// apps/console/src/components/NotificationCenter.tsx
// A bell in the top bar with an unread badge; opens a slide-out feed. Notifications are derived in
// the store by diffing polled state and persisted to localStorage (200-item ring buffer).
import { useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Bell, Check, Trash2, X, ChevronRight } from "lucide-react";
import { cn } from "../lib/cn";
import { HexField } from "./brand";
import { useZira, type AppNotification } from "../store/useZira";

function relative(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

const KIND_COLOR: Record<string, string> = {
  payment_received: "var(--teal)", task_completed: "var(--teal)", provider_online: "var(--teal)",
  zti_milestone: "var(--indigo)", lock_contributed: "var(--indigo)", task_assigned: "var(--indigo)",
  task_delivered: "var(--indigo)", provider_offline: "var(--warn)", task_expired: "var(--warn)",
  task_disputed: "var(--danger)",
};

export function NotificationCenter() {
  const [open, setOpen] = useState(false);
  // Which notification (if any) is expanded inline. Only used for notifications without a navigation
  // target, so a click on them still reveals their detail instead of doing nothing.
  const [expanded, setExpanded] = useState<string | null>(null);
  const nav = useNavigate();
  const { notifications, markNotificationRead, markAllNotificationsRead, clearNotifications } = useZira();
  const unread = notifications.filter((n) => !n.read).length;

  // A click always lands somewhere: if the notification points at a route, mark it read, close the panel,
  // and navigate there. Otherwise mark it read and toggle its inline detail so the click is never a no-op.
  function activate(n: AppNotification) {
    markNotificationRead(n.id);
    if (n.href) {
      setOpen(false);
      setExpanded(null);
      nav(n.href);
    } else {
      setExpanded((cur) => (cur === n.id ? null : n.id));
    }
  }

  return (
    <>
      <button onClick={() => setOpen(true)} className="relative text-muted hover:text-text" aria-label="Notifications">
        <Bell size={18} />
        {unread > 0 && (
          <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--accent)] px-1 text-[10px] font-semibold text-[var(--accent-contrast)]">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && createPortal(
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-[2px]" onClick={() => setOpen(false)}>
          <aside className="glass flex h-full w-full max-w-sm flex-col rounded-none border-l border-hairline bg-[var(--bg-panel)] shadow-[var(--shadow-float)] backdrop-blur-xl" onClick={(e) => e.stopPropagation()}>
            <div className="brand-rule" />
            <div className="flex items-center justify-between border-b border-hairline px-4 py-3">
              <h3 className="text-[1rem] font-semibold">Notifications</h3>
              <div className="flex items-center gap-3 text-muted">
                <button title="Mark all read" onClick={markAllNotificationsRead} className="hover:text-text"><Check size={16} /></button>
                <button title="Clear all" onClick={clearNotifications} className="hover:text-text"><Trash2 size={16} /></button>
                <button onClick={() => setOpen(false)} className="hover:text-text"><X size={18} /></button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {notifications.length === 0 ? (
                <div className="flex flex-col items-center gap-3 px-4 py-16 text-center">
                  <HexField size={92} className="opacity-70" />
                  <div className="text-sm text-muted">Nothing yet. Payments, tasks, and milestones show up here.</div>
                </div>
              ) : (
                notifications.map((n: AppNotification) => (
                  <button key={n.id} onClick={() => activate(n)}
                    className={cn("flex w-full items-start gap-3 border-b border-hairline px-4 py-3 text-left hover:bg-elevated/60", !n.read && "bg-elevated/30")}>
                    <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: KIND_COLOR[n.kind] ?? "var(--muted)" }} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-text">{n.title}</span>
                      {n.body && <span className={cn("block text-xs text-muted", expanded === n.id ? "whitespace-pre-wrap break-words" : "truncate")}>{n.body}</span>}
                      <span className="block text-[11px] text-faint">{relative(n.ts)}{n.href ? " · tap to open" : !n.body ? "" : ""}</span>
                    </span>
                    {n.href && <ChevronRight size={15} className="mt-1 shrink-0 text-faint" aria-hidden />}
                  </button>
                ))
              )}
            </div>
          </aside>
        </div>,
        document.body,
      )}
    </>
  );
}
