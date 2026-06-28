import type { Config } from "tailwindcss";

// All colors come from CSS variables defined in globals.css so components never hardcode hex.
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        base: "var(--bg-base)",
        surface: "var(--bg-surface)",
        elevated: "var(--bg-elevated)",
        hairline: "var(--border)",
        "hairline-strong": "var(--border-strong)",
        text: "var(--text)",
        muted: "var(--text-muted)",
        faint: "var(--text-faint)",
        teal: "var(--teal)",
        indigo: "var(--indigo)",
        mist: "var(--mist)",
        warn: "var(--warn)",
        danger: "var(--danger)",
        neutral: "var(--neutral)",
      },
      fontFamily: {
        sans: ["Geist", "Inter", "system-ui", "sans-serif"],
        mono: ["Geist Mono", "IBM Plex Mono", "ui-monospace", "monospace"],
      },
      borderColor: {
        DEFAULT: "var(--border)",
      },
    },
  },
  plugins: [],
} satisfies Config;
