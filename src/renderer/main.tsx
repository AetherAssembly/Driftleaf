import React from "react";
import ReactDOM from "react-dom/client";
import "@aetherAssembly/ui/styles.css";
import "./app.css";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";

// Electron's preload sets window.driftleaf via contextBridge before any renderer script
// runs, so it's already present here under Electron. Under Tauri nothing has set it yet —
// install the Tauri adapter (src/tauri-bridge) in that case so this file is the only place
// that needs to know which shell it's running under; every component downstream just uses
// window.driftleaf, unchanged. See docs/ELECTRON_MIGRATION_REVIEW.md, Phase 2.
async function ensureDriftleafApi(): Promise<void> {
  if (window.driftleaf) return;
  if (!("__TAURI_INTERNALS__" in window)) return;
  const { tauriDriftleafApi } = await import("../tauri-bridge");
  window.driftleaf = tauriDriftleafApi;
}

function renderApp(): void {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  );
}

// Render even if bridge setup fails — a visibly broken app (with an error in the console) is
// far easier to diagnose than a silently blank page from an unhandled rejection here.
ensureDriftleafApi()
  .catch((error: unknown) => {
    console.error("Failed to install the Tauri driftleaf bridge:", error);
  })
  .finally(renderApp);
