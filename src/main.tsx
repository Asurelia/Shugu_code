import React from "react";
import ReactDOM from "react-dom/client";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { defaultShouldDehydrateQuery } from "@tanstack/react-query";
import { ConvexProvider } from "convex/react";
import { queryClient, queryPersister } from "./lib/queryClient";

import "./styles/styles.css";
import "./styles/panels.css";
import "./styles/chat-sidebar.css";
import "./styles/settings-extras.css";
import "./styles/ai-edit.css";
import "./styles/chat-codex.css";
import "./styles/forge-integrations.css";
import "./styles/design.css";
import "./styles/studio.css";

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

// Sous-clés ["chat", X] à NE PAS persister (synthétique localStorage-backed ou
// live éphémère) — cf. dehydrateOptions ci-dessous. Les messages/conversations
// (autres sous-clés) restent persistés.
const VOLATILE_CHAT_STATE = new Set<string>([
  "active-conv",
  "active-model",
  "codex-effort",
  "busy",
  "unread",
  "stream",
  "toolActivity",
]);

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
    persistOptions={{
      persister: queryPersister,
      // v2 : invalide le snapshot existant qui contenait encore
      // ["chat","active-conv"] (etc.). shouldDehydrateQuery ne filtre QUE
      // l'écriture, pas la restauration — sans bump, l'ancienne valeur serait
      // rehydratée une dernière fois et la divergence persisterait un boot.
      buster: "v2",
      // Les états AI inline sont PUREMENT éphémères et ne doivent JAMAIS être
      // persistés/rehydratés :
      //   • ["ai-edit","session"]  → rehydrater un "preview"/"streaming" périmé
      //     casserait le widget (pas de diff réel sous-jacent).
      //   • ["ai-apply","request"] → rehydrater une requête d'apply périmée la
      //     rejouerait au 1er mount /code (diff surprise / fichier disparu).
      //   • ["ai-review","dialog"] → rehydrater open:true rouvrirait le dialog
      //     de review tout seul au reload.
      //
      // Les états SYNTHÉTIQUES/VOLATILES du chat ne doivent pas non plus être
      // persistés ici — c'est une SECONDE source de vérité qui DIVERGE :
      //   • ["chat","active-conv"] / ["chat","active-model"] / ["chat",
      //     "codex-effort"] sont DÉJÀ persistés dans localStorage (KEY_ACTIVE…)
      //     et partagés cross-window par ce biais. Si on les rehydrate AUSSI
      //     depuis le snapshot tanstack, la fenêtre principale (qui a un
      //     PersistQueryClientProvider) repart sur la valeur du snapshot tandis
      //     que la mascotte (provider simple) lit localStorage → les deux
      //     fenêtres peuvent diverger de conversation active. On les exclut donc
      //     du snapshot : les DEUX fenêtres retombent sur loadActive()/localStorage,
      //     source unique partagée, et restent synchronisées via chat://active-changed.
      //   • ["chat","busy"|"unread"|"stream"|"toolActivity"] sont des états LIVE
      //     éphémères ; rehydrater un "streaming:true" périmé afficherait une
      //     fausse bulle « en train de travailler » au boot.
      // Les messages et la liste de conversations RESTENT persistés (rendu
      // instantané au boot, puis refetch SQLite).
      dehydrateOptions: {
        shouldDehydrateQuery: (q) =>
          q.queryKey[0] !== "ai-edit" &&
          q.queryKey[0] !== "ai-apply" &&
          q.queryKey[0] !== "ai-review" &&
          !(
            q.queryKey[0] === "chat" &&
            typeof q.queryKey[1] === "string" &&
            VOLATILE_CHAT_STATE.has(q.queryKey[1])
          ) &&
          defaultShouldDehydrateQuery(q),
      },
    }}
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
