import React from "react";
import ReactDOM from "react-dom/client";
import "@aetherAssembly/ui/styles.css";
import "./app.css";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
