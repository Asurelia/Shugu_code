// Shugu Forge — demandes d'ajout de source (@-mention) au composer chat.
//
// Pont entre les surfaces qui désignent un fichier (explorateur → clic droit
// « Ajouter au chat », bouton « + » du composer → picker) et le composer du
// ChatView, qui insère la mention `@"chemin"` dans l'input. Le flux @-mention
// existant (mentions.ts + chat-sync) fait le reste à l'envoi : le contenu du
// fichier est joint au message modèle, le texte persisté reste propre.
//
// Pattern TanStack-as-observable-slot (chatBusy/toast) : file d'attente de
// chemins, consommée par le ChatView monté. Si le chat n'est pas ouvert, la
// demande attend — elle sera insérée à la prochaine ouverture du composer.

import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";

const MENTION_KEY = ["chat", "mention-requests"] as const;

function get(): string[] {
  return queryClient.getQueryData<string[]>(MENTION_KEY) ?? [];
}

/** Demande l'insertion d'une @-mention du chemin dans le composer chat. */
export function requestChatMention(path: string): void {
  const cur = get();
  if (cur.includes(path)) return;
  queryClient.setQueryData<string[]>(MENTION_KEY, [...cur, path]);
}

/** Vide la file (appelé par le consommateur après insertion). */
export function clearChatMentionRequests(): void {
  if (get().length === 0) return;
  queryClient.setQueryData<string[]>(MENTION_KEY, []);
}

/** Lecture réactive de la file (consommée par ChatView). */
export function useChatMentionRequests(): string[] {
  const { data = [] } = useQuery<string[]>({
    queryKey: MENTION_KEY,
    queryFn: get,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data;
}
