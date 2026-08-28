import { defineConfig } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron/simple";
import renderer from "vite-plugin-electron-renderer";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        entry: path.resolve(rootDir, "src/main/index.ts"),
        vite: {
          build: {
            outDir: path.resolve(rootDir, "dist-electron/main"),
            rollupOptions: {
              external: [/^better-sqlite3(?:\/|$)/],
            },
          },
        },
      },
      preload: {
        input: path.resolve(rootDir, "src/preload/index.ts"),
        vite: {
          build: {
            outDir: path.resolve(rootDir, "dist-electron/preload"),
          },
        },
      },
      renderer: {},
    }),
    renderer(),
  ],
  build: {
    outDir: path.resolve(rootDir, "dist"),
  },
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "src"),
    },
  },
});
