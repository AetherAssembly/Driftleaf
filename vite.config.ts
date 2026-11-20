// Dev/build config for the Tauri shell's renderer — the only frontend build this project
// has (Electron, and the separate Electron-only vite config it used, were removed once
// Tauri fully replaced it).
import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

// Dev server only, and only when scripts/dev/web-harness.mjs started it: loads the script
// that stands in for the Tauri shell so the renderer can run in an ordinary browser. Never
// part of a build (`apply: "serve"`), and inert unless the variable is set.
function webHarness(): Plugin {
  const harnessUrl = process.env.DRIFTLEAF_WEB_HARNESS;
  return {
    name: "driftleaf-web-harness",
    apply: "serve",
    transformIndexHtml: () =>
      harnessUrl
        ? [{ tag: "script", attrs: { src: `${harnessUrl}/harness.js` }, injectTo: "head-prepend" }]
        : [],
  };
}

export default defineConfig({
  plugins: [react(), webHarness()],
  server: {
    port: 5183,
    strictPort: true,
  },
  build: {
    outDir: path.resolve(rootDir, "dist"),
  },
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
    },
  },
});
