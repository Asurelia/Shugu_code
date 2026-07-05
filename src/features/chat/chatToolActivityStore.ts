// src/features/chat/chatToolActivityStore.ts
// Shugu Forge — Lot A (Task 12) — activité des tool-calls du tour en cours.
//
// Pendant la boucle d'outils de chat_send, le backend émet des deltas
// `chat://delta` { conversationId, chunk: "<libellé>", kind: "tool", done: false }
// (ex « 🔍 a lu `src/lib/db.ts` », « ✏️ a écrit `src/lib/diag.ts` »). On les
// accumule ICI, indexés par conversationId, pour les afficher comme une petite
// liste d'activité discrète au-dessus du message AI en cours de stream.
//
// Pourquoi un store dédié plutôt que d'étendre useChatStream :
//   - useChatStream.ChatStreamState porte content/reasoning (du texte qui
//     s'accumule en un seul buffer). Les libellés d'outils sont des ÉLÉMENTS
//     DISCRETS (une ligne par appel) — un string[] est la bonne forme, pas un
//     string concaténé. Les mélanger forcerait un re-split fragile.
//   - On garde l'accumulation content/reasoning de useChatStream INTACTE.
// Le listener vit au root de la window (useChatToolActivityListener, monté à
// côté de useChatStreamListener) ; les consumers filtrent par convId.
//
// Reset : sur le `done` du stream (fin de tour) on vide l'activité de la conv,
// comme useChatStream remet INITIAL_STREAM. L'activité n'est PAS persistée —
// elle est éphémère, le message final (et son journal d'annulation) la remplace.
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { listen } from "@/lib/tauri";
import { queryClient } from "@/lib/queryClient";
import { isOutOfBandConvId } from "@/features/code/ai-edit/types";

interface ChatDelta {
  conversationId?: string;
  chunk: string;
  kind?: "content" | "reasoning" | "tool";
  done: boolean;
}

/** Map conversationId → libellés d'outils du tour en cours. */
type ToolActivityMap = Record<string, string[]>;

const KEY = ["chat", "toolActivity"] as const;

function setActivity(updater: (prev: ToolActivityMap) => ToolActivityMap): void {
  queryClient.setQueryData<ToolActivityMap>(KEY, (prev) => updater(prev ?? {}));
}

/**
 * Mount du listener au root de chaque window (à côté de useChatStreamListener).
 * Accumule les libellés `kind:"tool"` par conv ; vide la conv sur son `done`.
 */
export function useChatToolActivityListener(): void {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      try {
        // NB : `listen` de @/lib/tauri DÉBALLE déjà `e.payload` (cf. tauri.ts)
        // — le callback reçoit donc directement la payload, comme useChatStream.
        unlisten = await listen<ChatDelta>("chat://delta", (p) => {
          if (cancelled) return;
          // Les appels chat_send hors-flux (éditions inline `aiedit:*`, synthèse
          // vocale `speak:*`) réutilisent chat_send mais ne déclenchent pas
          // d'outils ; on les ignore par cohérence avec useChatStreamListener
          // (pas de pollution du store d'activité).
          if (isOutOfBandConvId(p.conversationId)) return;
          const convId = p.conversationId ?? "__none__";
          if (p.done) {
            // Fin du tour — on vide l'activité de cette conv (le message final
            // arrive séparément via chat://messages-changed).
            setActivity((prev) => {
              if (!(convId in prev)) return prev;
              const next = { ...prev };
              delete next[convId];
              return next;
            });
            return;
          }
          if (p.kind !== "tool" || typeof p.chunk !== "string" || !p.chunk) return;
          setActivity((prev) => ({
            ...prev,
            [convId]: [...(prev[convId] ?? []), p.chunk],
          }));
        });
      } catch (err) {
        console.warn("[useChatToolActivityListener] listen attach failed:", err);
      }
      if (cancelled) {
        unlisten?.();
        unlisten = null;
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}

/** Lecture réactive des libellés d'outils du tour en cours pour une conv. */
export function useChatToolActivity(convId: string | null | undefined): string[] {
  const { data } = useQuery<ToolActivityMap>({
    queryKey: KEY,
    queryFn: () => queryClient.getQueryData<ToolActivityMap>(KEY) ?? {},
    staleTime: Infinity,
    gcTime: Infinity,
  });
  if (!convId) return [];
  return data?.[convId] ?? [];
}
