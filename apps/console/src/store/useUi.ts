// apps/console/src/store/useUi.ts
// Small UI-only store for shell chrome and appearance. It holds whether the left navigation is collapsed
// to a thin rail, plus the three appearance axes (theme, density, font size) from Settings. All choices
// are persisted to localStorage so they survive reloads, and they are the single source of truth shared
// across the shell. Appearance is applied to the document root (data-theme / data-density / root
// font-size), so the whole app reflows from CSS variables with no per-component work.
import { create } from "zustand";

const COLLAPSE_KEY = "zira.ui.sidebarCollapsed.v1";
const THEME_KEY = "zira.ui.theme";
const DENSITY_KEY = "zira.ui.density";
const FONT_KEY = "zira.ui.font";
const SIMPLE_KEY = "zira.ui.simple"; // plain-language "Simple" copy mode

export type Theme = "dark" | "light";
export type Density = "compact" | "standard";
export type FontSize = "s" | "m" | "l";

const FONT_PX: Record<FontSize, number> = { s: 14, m: 16, l: 18 };

function loadCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSE_KEY) === "1"; } catch { return false; }
}
function saveCollapsed(v: boolean): void {
  try { localStorage.setItem(COLLAPSE_KEY, v ? "1" : "0"); } catch { /* ignore */ }
}
// Simple mode shows plain, human copy across the app (jargon like "coordination", "Proof of Resonance",
// "ZTI" gives way to everyday wording). Defaults ON so a first-time visitor gets the clear version; power
// users can switch to the full/technical wording in Settings.
function loadSimple(): boolean {
  try { const v = localStorage.getItem(SIMPLE_KEY); return v === null ? true : v === "1"; } catch { return true; }
}
function saveSimple(v: boolean): void {
  try { localStorage.setItem(SIMPLE_KEY, v ? "1" : "0"); } catch { /* ignore */ }
}
function loadPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try { const v = localStorage.getItem(key) as T | null; return v && allowed.includes(v) ? v : fallback; } catch { return fallback; }
}

// Apply the three appearance axes to the document root. Theme drives the CSS variable set (light = :root,
// dark = :root[data-theme="dark"]); font size sets the root px so all rem-based sizing scales; density is
// exposed as a data attribute and nudges the base size a notch tighter when compact.
function applyAppearance(theme: Theme, density: Density, font: FontSize): void {
  try {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    root.setAttribute("data-density", density);
    root.style.fontSize = `${FONT_PX[font] - (density === "compact" ? 1 : 0)}px`;
  } catch { /* no document (SSR/tests) */ }
}

// Theme defaults to dark (the app's established look) and migrates the pre-Appearance shell toggle key.
function loadTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "dark" || v === "light") return v;
    const legacy = localStorage.getItem("zira.theme"); // the old top-bar toggle, pre-Appearance
    if (legacy === "dark" || legacy === "light") return legacy;
  } catch { /* ignore */ }
  return "dark";
}

// Apply persisted appearance immediately on first import, before React renders, so there is no flash.
const initialTheme = loadTheme();
const initialDensity = loadPref<Density>(DENSITY_KEY, ["compact", "standard"], "standard");
const initialFont = loadPref<FontSize>(FONT_KEY, ["s", "m", "l"], "m");
applyAppearance(initialTheme, initialDensity, initialFont);

interface UiState {
  // Desktop: the left nav is collapsed to a thin icon rail.
  sidebarCollapsed: boolean;
  // Mobile: the left nav is shown as a slide-over drawer.
  mobileNavOpen: boolean;
  // The command palette (Cmd/Ctrl+K): a fuzzy-filtered launcher for navigation and a few key actions.
  paletteOpen: boolean;
  // Appearance (Settings -> Appearance).
  theme: Theme;
  density: Density;
  fontSize: FontSize;
  // Plain-language copy mode (Settings -> Appearance). Default on.
  simpleMode: boolean;
  setSidebarCollapsed: (v: boolean) => void;
  toggleSidebar: () => void;
  setMobileNavOpen: (v: boolean) => void;
  setPaletteOpen: (v: boolean) => void;
  togglePalette: () => void;
  setTheme: (v: Theme) => void;
  setDensity: (v: Density) => void;
  setFontSize: (v: FontSize) => void;
  setSimpleMode: (v: boolean) => void;
}

export const useUi = create<UiState>((set, get) => ({
  sidebarCollapsed: loadCollapsed(),
  mobileNavOpen: false,
  paletteOpen: false,
  theme: initialTheme,
  density: initialDensity,
  fontSize: initialFont,
  simpleMode: loadSimple(),
  setSidebarCollapsed: (v) => { saveCollapsed(v); set({ sidebarCollapsed: v }); },
  toggleSidebar: () => { const next = !get().sidebarCollapsed; saveCollapsed(next); set({ sidebarCollapsed: next }); },
  setMobileNavOpen: (v) => set({ mobileNavOpen: v }),
  setPaletteOpen: (v) => set({ paletteOpen: v }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  setTheme: (v) => { try { localStorage.setItem(THEME_KEY, v); } catch { /* ignore */ } applyAppearance(v, get().density, get().fontSize); set({ theme: v }); },
  setDensity: (v) => { try { localStorage.setItem(DENSITY_KEY, v); } catch { /* ignore */ } applyAppearance(get().theme, v, get().fontSize); set({ density: v }); },
  setFontSize: (v) => { try { localStorage.setItem(FONT_KEY, v); } catch { /* ignore */ } applyAppearance(get().theme, get().density, v); set({ fontSize: v }); },
  setSimpleMode: (v) => { saveSimple(v); set({ simpleMode: v }); },
}));
