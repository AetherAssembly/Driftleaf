// Dev/build config for the Tauri shell's frontend only — no Electron plugins. vite.config.ts
// (the Electron build) auto-launches Electron on `vite dev`, which we don't want running
// alongside the Tauri window. See docs/ELECTRON_MIGRATION_REVIEW.md, Phase 2.
import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5183,
    strictPort: true,
  },
  build: {
    outDir: path.resolve(rootDir, "dist-tauri-frontend"),
  },
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
    },
  },
});
