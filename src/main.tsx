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
import "./styles/shell-extras.css";
// EN DERNIER — surcharge typographique (chrome en sans, code en mono).
import "./styles/typography.css";

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

// WHITELIST des sous-clés ["chat", X] DURABLES à persister. Tout le reste sous
// "chat" est synthétique (localStorage-backed : active-conv/model/codex-effort)
// ou live éphémère (busy/unread/stream/toolActivity) → JAMAIS persisté (sinon
// 2e source de vérité qui diverge). Une whitelist (vs l'ancienne blacklist) est
// robuste aux futures clés : toute nouvelle clé chat est non-persistée par défaut.
const DURABLE_CHAT_SUBKEYS = new Set<string>(["messages", "conversations"]);

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
      // v3 : la règle de déshydratation a changé (blacklist → whitelist chat) ;
      // on invalide le snapshot existant pour repartir propre.
      buster: "v3",
      // Les états AI inline sont PUREMENT éphémères et ne doivent JAMAIS être
      // persistés/rehydratés (rehydrater un preview/diff/dialog périmé casserait
      // le widget ou rouvrirait un dialog tout seul) : ["ai-edit"], ["ai-apply"],
      // ["ai-review"].
      //
      // Familles VOLUMINEUSES et/ou reconstructibles — exclues pour ne pas gonfler
      // le blob localStorage (JSON.parse synchrone AVANT le premier render au boot)
      // alors qu'elles se refetchent en ms : ["agents"] (transcripts reconstruits
      // depuis SQLite), ["fs"]/["git"] (listings/status workspace), ["grep"]
      // (résultats jetables), ["cockpit"] (layout — source autoritaire SQLite).
      //
      // Le namespace "chat" passe en WHITELIST : on ne persiste QUE l'historique
      // durable (messages + conversations, qui viennent de SQLite). Tout le reste
      // sous "chat" est soit synthétique localStorage-backed (active-conv/model,
      // partagés cross-window → les persister AUSSI dans le snapshot tanstack
      // créait une 2e source de vérité divergente), soit live éphémère (busy/
      // unread/stream/toolActivity → un "streaming:true" périmé afficherait une
      // fausse bulle au boot). La whitelist est robuste aux futures clés chat.
      dehydrateOptions: {
        shouldDehydrateQuery: (q) => {
          const ns = q.queryKey[0];
          if (ns === "ai-edit" || ns === "ai-apply" || ns === "ai-review") return false;
          // Reconstructibles/volumineuses : jamais dans le snapshot persisté.
          if (ns === "agents" || ns === "fs" || ns === "git" || ns === "grep" || ns === "cockpit") {
            return false;
          }
          if (ns === "chat") {
            return (
              typeof q.queryKey[1] === "string" &&
              DURABLE_CHAT_SUBKEYS.has(q.queryKey[1]) &&
              defaultShouldDehydrateQuery(q)
            );
          }
          return defaultShouldDehydrateQuery(q);
        },
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
