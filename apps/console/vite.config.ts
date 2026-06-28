import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Pure static build. No SSR. The API base is read at runtime from settings (default same
// origin /api), so one build works everywhere: locally and on app.zira.network.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    target: "es2020",
    sourcemap: false,
  },
  server: {
    port: 5173,
  },
});
