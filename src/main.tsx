import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ConvexProvider } from "convex/react";

import "./styles/styles.css";
import "./styles/panels.css";
import "./styles/chat-sidebar.css";
import "./styles/settings-extras.css";

import { RouterProvider } from "@tanstack/react-router";
import { ThemeBootstrap } from "./lib/ThemeBootstrap";
import { convex, convexEnabled } from "./lib/convex";
import { router } from "./router";

// Cross-window navigation listener (main window only — mascot uses its own
// entry point at mascot.html). Other windows can emit `app://navigate` with
// `{ path: "..." }` to trigger a route change here. Used today by the chibi's
// "Set API key" button to bring the user to Settings → Connections.
const inTauriMain = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
if (inTauriMain) {
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
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

const inner = (
  <QueryClientProvider client={queryClient}>
    <ThemeBootstrap />
    <RouterProvider router={router} />
  </QueryClientProvider>
);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {convexEnabled ? <ConvexProvider client={convex}>{inner}</ConvexProvider> : inner}
  </React.StrictMode>,
);
