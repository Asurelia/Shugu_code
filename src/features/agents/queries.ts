// Shugu Forge — TanStack Query hooks pour la feature agents.
//
// Remplace COMPLÈTEMENT le store Zustand `agentsStore.ts` + le hook
// `useAgents.ts` qui faisait du manual apply-event-to-store. Les events
// Tauri n'écrivent plus dans un store custom : ils invalident des queries
// (voir useEvents.ts), et TanStack refetch automatiquement.
//
// Bénéfices vs. l'ancienne approche :
//   - Pas de cascade de re-renders entre 4 events arrivant en 5 ms — chaque
//     invalidation déclenche AU MAX un seul refetch, et React 18 batche
//     les set-state qui en résultent dans une seule frame.
//   - Cache automatique : ré-ouvrir le panneau Agents ne re-fetch pas si
//     les données sont fresh (staleTime = 0 pour live, mais le cache
//     reste pendant `gcTime`).
//   - Pas de désync possible entre SQLite (source de vérité) et le state
//     UI — chaque invalidation refetch depuis SQLite via les commandes
//     Tauri existantes (`agent_list_active`, `agent_get_transcript`, …).

import { useQuery } from "@tanstack/react-query";
import {
  listActiveAgents,
  getAgentTranscript,
  listAgentsByConversation,
  type AgentRow,
  type AgentEvent,
} from "@/lib/agents";
import { queryClient } from "@/lib/queryClient";
import { agentKeys } from "./keys";

/** Forme parsée du transcript — events typés en AgentEvent (le row SQLite
 *  garde le payload comme string brute, on parse à la lecture). */
export interface ParsedAgentTranscript {
  agent: AgentRow;
  events: AgentEvent[];
}

/**
 * Liste des agents actifs (status pending | running).
 *
 * Source : `agent_list_active` Tauri command → SQLite SELECT.
 *
 * staleTime: 0 — on veut TOUJOURS du frais sur ce hook. Les invalidations
 * via `agent://lifecycle` (voir useEvents.ts) déclencheront un refetch
 * presque immédiat. Cohérent avec le pattern "live observability".
 */
export function useActiveAgents() {
  return useQuery<AgentRow[]>({
    queryKey: agentKeys.active(),
    queryFn: () => listActiveAgents(),
    staleTime: 0,
  });
}

/**
 * Transcript complet d'un agent (row + events).
 *
 * Source : `agent_get_transcript` Tauri command → SQLite SELECT (queryFn).
 * Updates live : via `setQueryData` dans `useEvents.ts` (deltas + non-deltas).
 *
 * **Container PASSIF** (Plan v4, 2026-05-17) — aligne sur le pattern
 * `chat://delta` qui marche. Le queryFn fetch SQLite **une seule fois**
 * (à la première souscription pour un agentId donné), puis les
 * setQueryData accumulent les Delta events dans le cache sans jamais
 * être wipped par un refetch.
 *
 * Pourquoi ce pattern :
 *   - SQLite ne contient PAS les Delta events (skippés par persist_and_emit
 *     côté Rust — sinon 30 INSERTs/sec pendant un stream tue la perf).
 *   - Les Deltas vivent UNIQUEMENT en mémoire dans le cache TanStack.
 *   - Un refetch (staleTime: 0 + refetchOnMount: true) écraserait le
 *     cache avec les events SQLite (sans Deltas) → wipe → streaming
 *     invisible. C'est exactement le bug du Plan v4.
 *
 * Options :
 *   - `staleTime: Infinity` — jamais stale, jamais refetch auto.
 *   - `gcTime: Infinity` — jamais GC, cohérent avec chat-stream.
 *   - `refetchOnMount/WindowFocus/Reconnect: false` — pas de refetch
 *     opportuniste sur les triggers usuels.
 *   - `enabled: !!agentId` — pas de fetch tant qu'aucun agent.
 */
export function useAgentTranscript(agentId: string | null | undefined) {
  return useQuery<ParsedAgentTranscript>({
    queryKey: agentKeys.detail(agentId ?? "__none__"),
    queryFn: async () => {
      if (!agentId) throw new Error("agentId required");
      const raw = await getAgentTranscript(agentId);
      // Parse the SQLite-row JSON payloads into typed AgentEvent objects.
      // Done here (not in lib/agents.ts) to keep the IPC boundary simple
      // and put the parsing right next to the consumers that need it.
      const events: AgentEvent[] = [];
      for (const row of raw.events) {
        try {
          events.push(JSON.parse(row.payload) as AgentEvent);
        } catch (err) {
          console.warn("[useAgentTranscript] payload parse failed:", err);
        }
      }
      return { agent: raw.agent, events };
    },
    enabled: !!agentId,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}

/**
 * Sélection actuelle (agent dont le drawer transcript est ouvert).
 *
 * Pattern TanStack "synthetic query as global state" : pas de queryFn
 * réelle, on lit/écrit via setQueryData. C'est l'équivalent d'un store
 * Zustand minimal pour une primitive partagée, mais on évite d'introduire
 * Zustand juste pour ça.
 */
export function useSelectedAgentId(): string | null {
  return (
    useQuery<string | null>({
      queryKey: agentKeys.selected(),
      // queryFn obligatoire — on retourne null par défaut. Le vrai
      // setter est `setSelectedAgentId` ci-dessous.
      queryFn: () => null,
      staleTime: Infinity,
      gcTime: Infinity,
    }).data ?? null
  );
}

/** Setter accessible depuis hors-composant (RootLayout listener, etc.). */
export function setSelectedAgentId(agentId: string | null): void {
  queryClient.setQueryData<string | null>(agentKeys.selected(), agentId);
}

/**
 * Tous les agents (any status) tied to a conversation.
 *
 * Source : `agent_list_by_conversation` Tauri command. Utilisé par le
 * réconciliateur de chat-sync pour matcher les placeholders orphelins
 * "Orchestrateur au travail…" avec leurs agents complete.
 *
 * staleTime: par défaut (30s du QueryClient) — pas du temps-réel critique.
 */
export function useAgentsByConversation(conversationId: string | null | undefined) {
  return useQuery<AgentRow[]>({
    queryKey: agentKeys.byConv(conversationId ?? "__none__"),
    queryFn: () => {
      if (!conversationId) return Promise.resolve([] as AgentRow[]);
      return listAgentsByConversation(conversationId);
    },
    enabled: !!conversationId,
  });
}
