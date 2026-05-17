import React from "react";
import ReactDOM from "react-dom/client";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { ConvexProvider } from "convex/react";
import { queryClient, queryPersister } from "./lib/queryClient";

import "./styles/styles.css";
import "./styles/panels.css";
import "./styles/chat-sidebar.css";
import "./styles/settings-extras.css";

import { RouterProvider } from "@tanstack/react-router";
import { ThemeBootstrap } from "./lib/ThemeBootstrap";
import { convex, convexEnabled } from "./lib/convex";
import { router } from "./router";

// ── Debug instrumentation — uncaught JS errors → Rust stdout ──────────
//
// WebView2 crashes wipe the DevTools console (the window dies before we
// can read it). We forward each uncaught error to a Tauri event so the
// Rust side can `eprintln!` it into the tauri-dev stdout, which IS
// captured in boot.log via Tee-Object. This is the only reliable way to
// see what made the page die when F12 itself crashes.
//
// Keep this BEFORE any other module-level side effect — we want to catch
// errors thrown during the initial app boot too.
void (async () => {
  try {
    const { emit } = await import("@tauri-apps/api/event");
    window.addEventListener("error", (e) => {
      void emit("debug://js-error", {
        kind: "error",
        message: e.message,
        filename: e.filename,
        line: e.lineno,
        col: e.colno,
        stack: (e.error as Error | undefined)?.stack ?? null,
        window: "main",
      });
    });
    window.addEventListener("unhandledrejection", (e) => {
      const reason = e.reason as unknown;
      void emit("debug://js-error", {
        kind: "unhandledrejection",
        message: "unhandledrejection: " + String(reason),
        stack: (reason as { stack?: string } | null)?.stack ?? null,
        window: "main",
      });
    });
  } catch (err) {
    console.warn("[main] debug js-error wiring failed", err);
  }
})();

// Cross-window navigation listener (main window only — mascot uses its own
// entry point at mascot.html). Other windows can emit `app://navigate` with
// `{ path: "..." }` to trigger a route change here. Used today by the chibi's
// "Set API key" button to bring the user to Settings → Connections.
void (async () => {
  try {
    const mod = await import("@tauri-apps/api/event");
    await mod.listen<{ path: string }>("app://navigate", (e) => {
      const path = e.payload?.path;
      if (!path) return;
      // tanstack-router strict mode wants a typed `to`; runtime-routed paths
      // are still valid, we just cast through `any` to satisfy the compiler.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void router.navigate({ to: path as any });
    });
  } catch (err) {
    console.warn("[main] app://navigate listener failed", err);
  }
})();

// queryClient est maintenant un singleton importé depuis lib/queryClient
// (réutilisé par les helpers hors-React via import direct).

// PersistQueryClientProvider remplace QueryClientProvider :
//   - Hydrate le cache depuis localStorage au mount (cache rehydration)
//   - Sauvegarde les mutations dans localStorage (throttle 1s)
//   - Sert ensuite comme un QueryClientProvider normal pour ses enfants
//
// Le `buster` est une chaîne incluse dans la clé de cache — la bumper
// invalide tous les caches existants (utile sur changement de schema).
const inner = (
  <PersistQueryClientProvider
    client={queryClient}
    persistOptions={{ persister: queryPersister, buster: "v1" }}
  >
    <ThemeBootstrap />
    <RouterProvider router={router} />
  </PersistQueryClientProvider>
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {convexEnabled ? <ConvexProvider client={convex}>{inner}</ConvexProvider> : inner}
  </React.StrictMode>,
);
