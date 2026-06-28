// apps/console/src/lib/shortcuts.ts
// App-wide keyboard shortcuts. Mounted once at the root via useGlobalShortcuts:
//   - Cmd/Ctrl+K       toggle the command palette
//   - Escape           close any open palette / drawer / mobile nav
// Cmd/Ctrl+Enter (send the composer message) is handled inside the Console composer itself, because only
// it owns the send function and the message draft. The reference list below feeds the Settings help card.
import { useEffect } from "react";
import { useUi } from "../store/useUi";
import { isApplePlatform } from "./platform";

export interface ShortcutDoc { keys: string; label: string }

// The canonical shortcut reference, shown in Settings. The modifier label adapts to the platform.
export function shortcutDocs(): ShortcutDoc[] {
  const mod = isApplePlatform() ? "Cmd" : "Ctrl";
  return [
    { keys: `${mod} K`, label: "Open the command palette" },
    { keys: `${mod} Enter`, label: "Send the message in the Console composer" },
    { keys: "Enter", label: "Send the message (Shift+Enter for a newline)" },
    { keys: "Esc", label: "Close the palette, a drawer, or an open panel" },
    { keys: "↑ ↓", label: "Move through command palette results" },
  ];
}

// Returns true for the platform's primary modifier (Cmd on macOS, Ctrl elsewhere).
function isPrimaryMod(e: KeyboardEvent): boolean {
  return isApplePlatform() ? e.metaKey : e.ctrlKey;
}

export function useGlobalShortcuts(): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Cmd/Ctrl+K toggles the command palette from anywhere.
      if (isPrimaryMod(e) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        useUi.getState().togglePalette();
        return;
      }
      // Escape closes the most prominent open overlay. The palette and mobile nav own their own Escape
      // handling too; this is a safety net so Escape always dismisses chrome even when focus is elsewhere.
      if (e.key === "Escape") {
        const ui = useUi.getState();
        if (ui.paletteOpen) { ui.setPaletteOpen(false); return; }
        if (ui.mobileNavOpen) { ui.setMobileNavOpen(false); return; }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
