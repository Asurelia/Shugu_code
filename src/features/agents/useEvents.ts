// Shugu Forge — Tauri event listener pour la feature agents.
//
// Responsabilité : listen `agent://lifecycle` et appliquer chaque event
// au cache TanStack via setQueryData. C'est TOUT. Aucun state custom,
// aucun applyEvent manuel, aucun store Zustand.
//
// Pourquoi un hook (vs un listener attached at app boot) ? Pour respecter
// le cycle de vie React et garantir le cleanup proprement quand le
// composant qui le mount est unmounté (StrictMode dev double-mount,
// HMR reload, etc.). Mount ce hook UNE FOIS par window au niveau racine
// (RootLayout pour main IDE, MascotApp pour mascot).
//
// Cross-window — chaque webview Tauri a son propre QueryClient instance.
// Le hook se mount séparément dans chacune et alimente son cache local
// (les events Tauri sont broadcastés à toutes les windows par défaut).
// Lazy-init du cache si `prev=undefined` : permet à la window qui n'a
// pas initié le spawn (via handleDelegate) de bootstrap son transcript
// depuis l'event Spawn (qui contient tout le métadata nécessaire).

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@/lib/tauri";
import { diag, diagEveryN } from "@/lib/diag";
import type { AgentEvent, AgentRow } from "@/lib/agents";
import type { ParsedAgentTranscript } from "./queries";
import { agentKeys } from "./keys";

export function useAgentEvents(): void {
  const qc = useQueryClient();
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    diag(
      "agent-events",
      `HOOK MOUNTED window=${typeof window !== "undefined" ? window.location.pathname : "?"}`,
    );

    void (async () => {
      try {
        unlisten = await listen<AgentEvent>("agent://lifecycle", (event) => {
          if (cancelled) return;
          const aid = event.agentId;
          if (!aid) return;

          // Diag — log non-delta events full, et coalesce delta logs.
          if (event.kind === "delta") {
            diagEveryN(
              "agent-events",
              `${aid}:${event.deltaKind}`,
              50,
              (c) =>
                `delta #${c} agent=${aid.slice(0, 8)} kind=${event.deltaKind} chunkLen=${event.chunk.length}`,
            );
          } else {
            diag(
              "agent-events",
              `event=${event.kind} agent=${aid.slice(0, 8)}`,
            );
          }

          // Tous les events (delta + non-delta) sont appliqués via
          // setQueryData APPEND au cache du transcript. Pas d'invalidate
          // — ça wiperait les deltas accumulés (les deltas ne sont PAS
          // persistés en SQLite). On invalide seulement les listes
          // (active, byConv) pour les transitions de status qui doivent
          // refléter le row SQLite mis à jour par le runner Rust.
          qc.setQueryData<ParsedAgentTranscript | undefined>(
            agentKeys.detail(aid),
            (prev) => {
              if (!prev) {
                // LAZY-INIT cross-window : cette window n'a pas vu le
                // pré-populate de handleDelegate, on bootstrap depuis
                // l'event courant. Si c'est un Spawn, on a tout pour un
                // row complet ; sinon on construit un row minimal — le
                // user verra le streaming, juste avec des métadonnées
                // partielles jusqu'au prochain message persisté.
                if (event.kind === "spawn") {
                  const agentRow: AgentRow = {
                    id: event.agentId,
                    role: event.role,
                    status: "running",
                    parentId: event.parentId,
                    model: event.model,
                    task: event.task,
                    conversationId: event.conversationId,
                    createdAt: Date.now(),
                    finishedAt: null,
                    output: null,
                    error: null,
                  };
                  return { agent: agentRow, events: [event] };
                }
                const minimalAgent: AgentRow = {
                  id: aid,
                  role: "orchestrator",
                  status: "running",
                  parentId: null,
                  model: "",
                  task: "",
                  conversationId: null,
                  createdAt: Date.now(),
                  finishedAt: null,
                  output: null,
                  error: null,
                };
                return { agent: minimalAgent, events: [event] };
              }

              if (event.kind === "delta") {
                // Coalesce les deltas consécutifs de même deltaKind.
                const lastIdx = prev.events.length - 1;
                const last = prev.events[lastIdx];
                if (last && last.kind === "delta" && last.deltaKind === event.deltaKind) {
                  const merged: AgentEvent = { ...last, chunk: last.chunk + event.chunk };
                  return {
                    ...prev,
                    events: [...prev.events.slice(0, lastIdx), merged],
                  };
                }
                return { ...prev, events: [...prev.events, event] };
              }

              // Non-delta event : append + reflect au row si applicable.
              let nextRow = prev.agent;
              if (event.kind === "complete") {
                nextRow = {
                  ...nextRow,
                  status: "complete",
                  output: event.output,
                  finishedAt: Date.now(),
                };
              } else if (event.kind === "error") {
                nextRow = {
                  ...nextRow,
                  status: nextRow.status === "killed" ? "killed" : "error",
                  error: event.error,
                  finishedAt: Date.now(),
                };
              }
              return { agent: nextRow, events: [...prev.events, event] };
            },
          );

          // Invalide juste les LISTES (active, byConv) sur transitions
          // de status. Le détail (transcript) ne s'invalide PAS — il vit
          // en mémoire avec les deltas, et un refetch wiperait le stream.
          if (event.kind === "spawn" || event.kind === "complete" || event.kind === "error") {
            void qc.invalidateQueries({ queryKey: agentKeys.lists() });
          }
        });
        diag("agent-events", `LISTEN ATTACHED cancelled=${cancelled}`);
      } catch (err) {
        diag("agent-events", `LISTEN ATTACH FAILED: ${String(err)}`);
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
  }, [qc]);
}
