// apps/web/src/main.tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import "./globals.css";
import { App } from "./App";
import { ToastProvider } from "./components/ui";

// HashRouter so deep links work on any static host with no server rewrite needed.
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <ToastProvider>
        <App />
      </ToastProvider>
    </HashRouter>
  </React.StrictMode>,
);
