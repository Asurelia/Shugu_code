// Subscribes to the Rust-side `chat://delta` event bus and accumulates
// streaming partial state in the TanStack cache (queryKey = streamKey).
//
// Refactor 2026-05-17 — Migration TanStack-only :
//   Ancien : useState + acceptingRef LOCAL à chaque mount → chaque window
//   avait son propre flag accepting, ce qui voulait dire que la main IDE
//   ne montrait pas le streaming d'un prompt envoyé depuis la mascotte.
//   Nouveau : un seul listener au mount, push dans setQueryData. Les deux
//   windows observent la même queryKey → les deux affichent le streaming.
//
// Le `conversationId` est inclus dans la payload Tauri, donc le consumer
// peut filtrer pour ne montrer le streaming QUE pour la conv qu'il
// affiche (évite que la mascotte montre un streaming d'une conv qu'elle
// n'a pas envoyée et que l'user voit dans la main IDE).

import { useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { listen } from "@/lib/tauri";
import { diag, diagEveryN } from "@/lib/diag";
import { queryClient } from "@/lib/queryClient";

interface ChatDelta {
  conversationId?: string;
  chunk: string;
  kind?: "content" | "reasoning";
  done: boolean;
}

export interface ChatStreamState {
  /** Conv pour laquelle le streaming est en cours. null = pas de stream actif. */
  convId: string | null;
  partial: string;
  partialReasoning: string;
  streaming: boolean;
}

const INITIAL_STREAM: ChatStreamState = {
  convId: null,
  partial: "",
  partialReasoning: "",
  streaming: false,
};

const STREAM_KEY = ["chat", "stream"] as const;

// Mount du listener au root de chaque window. Pas de "accepting gate" :
// les events sont stockés dans le cache TanStack, les consommateurs
// filtrent par convId pour décider ce qu'ils affichent.
export function useChatStreamListener(): void {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    diag(
      "chat-stream",
      `HOOK MOUNTED window=${typeof window !== "undefined" ? window.location.pathname : "?"}`,
    );
    void (async () => {
      try {
        unlisten = await listen<ChatDelta>("chat://delta", (delta) => {
          if (cancelled) return;
          diagEveryN(
            "chat-stream",
            `chat:${delta.kind ?? "content"}`,
            100,
            (c) => `delta #${c} kind=${delta.kind ?? "content"} done=${delta.done}`,
          );
          if (delta.done) {
            // Stream terminé — reset le state (le message final arrive
            // séparément via chat://messages-changed → useMessages refetch).
            queryClient.setQueryData<ChatStreamState>(STREAM_KEY, INITIAL_STREAM);
            return;
          }
          const kind = delta.kind ?? "content";
          const convId = delta.conversationId ?? null;
          queryClient.setQueryData<ChatStreamState>(STREAM_KEY, (prev) => {
            const base = prev ?? INITIAL_STREAM;
            // Si on commence un nouveau stream pour une autre conv, on
            // reset les partials (l'ancien stream est terminé OU on a
            // raté son done event — fail-safe).
            const sameConv = base.convId === convId || base.convId === null;
            const partial = sameConv && kind === "content" ? base.partial + delta.chunk : kind === "content" ? delta.chunk : base.partial;
            const partialReasoning = sameConv && kind === "reasoning" ? base.partialReasoning + delta.chunk : kind === "reasoning" ? delta.chunk : base.partialReasoning;
            return {
              convId,
              partial,
              partialReasoning,
              streaming: true,
            };
          });
        });
      } catch (err) {
        console.warn("[useChatStreamListener] listen attach failed:", err);
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

export interface ChatStreamHandle {
  streaming: boolean;
  partial: string;
  partialReasoning: string;
  start: () => void;
  stop: () => void;
}

/**
 * Lecture réactive du state de streaming pour la conv donnée.
 *
 * Si convId est fourni, le hook ne retourne `streaming: true` que si
 * le stream actif concerne cette conv ; sinon `streaming: false` même
 * si un autre stream tourne. Permet d'avoir 2 chats ouverts (mascotte
 * + main) sans qu'ils se chevauchent.
 *
 * `start()` / `stop()` sont conservés pour API rétro-compatible — ils
 * sont juste des no-ops maintenant car le listener est au root et le
 * state vit dans TanStack. Le `start()` reset l'éventuel résidu d'un
 * stream précédent pour la même conv.
 */
export function useChatStream(activeConvId?: string | null): ChatStreamHandle {
  const { data = INITIAL_STREAM } = useQuery<ChatStreamState>({
    queryKey: STREAM_KEY,
    queryFn: () => INITIAL_STREAM,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  // Filter par convId si fourni — sinon on accepte n'importe lequel.
  const matches = !activeConvId || data.convId === activeConvId;
  const streaming = matches && data.streaming;
  const partial = matches ? data.partial : "";
  const partialReasoning = matches ? data.partialReasoning : "";

  const start = useCallback(() => {
    queryClient.setQueryData<ChatStreamState>(STREAM_KEY, {
      ...INITIAL_STREAM,
      convId: activeConvId ?? null,
      streaming: true,
    });
  }, [activeConvId]);

  const stop = useCallback(() => {
    queryClient.setQueryData<ChatStreamState>(STREAM_KEY, INITIAL_STREAM);
  }, []);

  return { streaming, partial, partialReasoning, start, stop };
}
