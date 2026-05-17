// Hook partagé entre ChatView (main IDE) et ChatPanel (mascotte).
//
// Pourquoi ce hook existe :
//   ChatView et ChatPanel affichent EXACTEMENT les mêmes infos (messages
//   user/AI, badge via_orchestrator, reasoning, streaming live de l'agent).
//   Seul le STYLE diverge — main IDE = full panel avec avatars / chips,
//   mascotte = bulle compacte. Avant ce hook, la logique data était
//   dupliquée dans chaque composant → quand on ajoutait quelque chose
//   (par exemple le live streaming agent), il fallait le coller à 2
//   endroits et risquer la désync.
//
//   Maintenant : un seul hook qui prend `m: Message`, branche
//   `useAgentTranscript` quand c'est un placeholder agent, et retourne
//   tout ce dont les deux UIs ont besoin pour rendre — `displayBody`
//   (live OU final selon état), `liveReasoning`, et le flag
//   `isStreamingAgent`. Chaque UI rend avec son propre style.
//
// Les styles inline restent dans chaque composant (mascotte compact vs
// main IDE full) — c'est légitime car les contraintes spatiales diffèrent.

import { useAgentTranscript } from "@/features/agents/queries";
import type { Message } from "@/lib/types";

export interface MessageDisplay {
  /** Le body à afficher — soit le streaming live de l'agent, soit m.body. */
  displayBody: string;
  /** Le reasoning streamé live pendant le run agent (vide si pas applicable). */
  liveReasoning: string;
  /** True si on est en train de stream le contenu d'un agent encore actif. */
  isStreamingAgent: boolean;
  /** Populated when the message is an image attachment (m.image === true and
   *  body starts with "data:"). Renderers should show an <img> tag instead of
   *  interpreting displayBody as text. */
  imageDataUrl?: string;
}

/**
 * Hook pour préparer un Message à l'affichage. Détecte les placeholders
 * agent "Orchestrateur au travail…" et y branche le live streaming
 * depuis le transcript cache (qui est updaté en temps réel par
 * `useAgentEvents` — chemin connu fonctionnel via le drawer agent).
 *
 * Pour les messages user / AI normaux : ne fetch rien, retourne juste
 * `m.body` (ou `m.text` pour user). Aucun overhead.
 */
export function useMessageDisplay(m: Message): MessageDisplay {
  const isAgentPlaceholder =
    m.role === "ai" && m.viaAgent === true && typeof m.agentId === "string";
  const agentIdForLive = isAgentPlaceholder ? (m.agentId as string) : null;
  const { data: transcript } = useAgentTranscript(agentIdForLive);

  let liveContent = "";
  let liveReasoning = "";
  if (isAgentPlaceholder && transcript) {
    for (const ev of transcript.events) {
      if (ev.kind === "delta" && ev.deltaKind === "content") liveContent += ev.chunk;
      else if (ev.kind === "delta" && ev.deltaKind === "reasoning") liveReasoning += ev.chunk;
    }
  }

  const stillPlaceholder = isAgentPlaceholder && m.body === "Orchestrateur au travail…";
  const isStreamingAgent = stillPlaceholder && (liveContent.length > 0 || liveReasoning.length > 0);

  const displayBody =
    stillPlaceholder && liveContent.length > 0
      ? liveContent
      : (m.text ?? m.body ?? "");

  // Detect image messages — body is a data URL when image=true.
  const imageDataUrl =
    m.image === true && typeof m.body === "string" && m.body.startsWith("data:")
      ? m.body
      : undefined;

  return { displayBody, liveReasoning, isStreamingAgent, imageDataUrl };
}
