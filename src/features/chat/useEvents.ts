// Shugu Forge — Tauri event listener pour le chat (messages live).
//
// Listen :
//   - `chat://messages-changed` (broadcast par `appendMessage`) → invalide
//     les queries messages de la conv concernée.
//   - `agent://lifecycle` kind=complete/error → run le reconciler 800ms
//     plus tard en fallback (au cas où `handleDelegate.awaitAgentComplete`
//     a manqué le complete event — window crash, HMR, etc.).
//   - `chat://active-changed`, `chat://active-model-changed` → sync
//     cross-window via setQueryData.
//
// Plan v4 (2026-05-17) — le streaming live agent dans le chat est
// maintenant géré par `useMessageDisplay` qui lit depuis le cache
// `agentKeys.detail(agentId)` (rendu PASSIF, alimenté par useAgentEvents).
// Le buffer `liveDelegateBuffers` + setQueryData sur chatKeys.messages
// du Plan v3.J est retiré : c'était une 2ème source de vérité qui ne
// marchait pas (probable structural sharing) et qui dupliquait du travail.
//
// Mount ce hook UNE FOIS par window (RootLayout pour main IDE,
// MascotApp pour mascot — chacun a son propre QueryClient instance).

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@/lib/tauri";
import type { AgentEvent } from "@/lib/agents";
import { chatKeys } from "./keys";

const EVT_MESSAGES = "chat://messages-changed";
const EVT_ACTIVE = "chat://active-changed";
const EVT_ACTIVE_MODEL = "chat://active-model-changed";

export function useChatEvents(): void {
  const qc = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    const unlistens: Array<() => void> = [];

    void (async () => {
      // chat://messages-changed → invalide la conv concernée
      try {
        const un = await listen<{ conversationId?: string }>(EVT_MESSAGES, (payload) => {
          if (cancelled) return;
          const convId = payload?.conversationId;
          if (convId) {
            void qc.invalidateQueries({ queryKey: chatKeys.messagesByConv(convId) });
          } else {
            // Pas de conv ciblée → invalide tout (rare, fallback safe).
            void qc.invalidateQueries({ queryKey: chatKeys.messages() });
          }
        });
        unlistens.push(un);
      } catch (err) {
        console.warn("[useChatEvents] messages listen failed:", err);
      }

      // agent://lifecycle handler — un seul cas géré ici : complete / error.
      // Le streaming live (kind=delta) est géré DIRECTEMENT par
      // `useAgentEvents` qui setQueryData sur `agentKeys.detail(aid)`,
      // et `useMessageDisplay` lit de ce cache.
      //
      // Sur complete/error, on lance le reconciler 800ms après. C'est un
      // FALLBACK pour le cas où `handleDelegate.awaitAgentComplete` a
      // manqué le complete event (window crash mid-stream, HMR reload,
      // 5-min timeout race). Le path normal :
      //   1. agent émet complete
      //   2. handleDelegate `await waitPromise` résout
      //   3. handleDelegate appelle `appendMessage(output)` → SQLite +
      //      émet chat://messages-changed → notre listener invalide →
      //      useMessages refetch → display final output.
      // Si ce path échoue, le reconciler ci-dessous prend le relais 800ms
      // après et écrit l'output via appendMessage (idempotent par id).
      try {
        const un = await listen<AgentEvent>("agent://lifecycle", (event) => {
          if (cancelled) return;
          if (event.kind !== "complete" && event.kind !== "error") return;

          window.setTimeout(() => {
            void (async () => {
              try {
                const { reconcileOrphanPlaceholders } = await import("./chat-sync");
                const activeConv = qc.getQueryData<string>(chatKeys.activeConv());
                if (activeConv) await reconcileOrphanPlaceholders(activeConv);
              } catch (err) {
                console.warn("[useChatEvents] reconcile failed:", err);
              }
            })();
          }, 800);
        });
        unlistens.push(un);
      } catch (err) {
        console.warn("[useChatEvents] lifecycle listen failed:", err);
      }

      // Active conv sync cross-window (l'autre fenêtre a changé de conv).
      try {
        const un = await listen<{ conversationId?: string }>(EVT_ACTIVE, (payload) => {
          if (cancelled) return;
          const id = payload?.conversationId;
          if (typeof id === "string" && id) {
            qc.setQueryData<string>(chatKeys.activeConv(), id);
          }
        });
        unlistens.push(un);
      } catch (err) {
        console.warn("[useChatEvents] active listen failed:", err);
      }

      // Active model sync cross-window.
      try {
        const un = await listen<{ model?: string }>(EVT_ACTIVE_MODEL, (payload) => {
          if (cancelled) return;
          const m = payload?.model;
          if (typeof m === "string" && m) {
            qc.setQueryData<string>(chatKeys.activeModel(), m);
          }
        });
        unlistens.push(un);
      } catch (err) {
        console.warn("[useChatEvents] active-model listen failed:", err);
      }
    })();

    return () => {
      cancelled = true;
      unlistens.forEach((u) => u());
    };
  }, [qc]);
}
