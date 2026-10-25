// Dev/build config for the Tauri shell's renderer — the only frontend build this project
// has (Electron, and the separate Electron-only vite config it used, were removed once
// Tauri fully replaced it).
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
    outDir: path.resolve(rootDir, "dist"),
  },
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
    },
  },
});
