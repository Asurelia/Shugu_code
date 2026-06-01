// src/features/cockpit/commentStore.ts
// Lot C2.4 — file de commentaires inline à l'agent (Révision diff).
//
// Chaque commentaire (InlineComment) est attaché à une ligne précise du diff.
// Il est injecté de façon ÉPHÉMÈRE dans le prochain message envoyé au modèle
// depuis le composer chat, puis la file est vidée (clearComments). JAMAIS
// persisté en SQLite.
//
// Même idiome que editorSelectionStore.ts : TanStack QueryClient comme
// reactive store. staleTime Infinity → pas de refetch. Le counter de l'id est
// un module-scope var pour rester déterministe (pas de Date.now/Math.random).

import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InlineComment {
  /** Identifiant déterministe : `path:line:counter`. */
  id: string;
  /** Chemin workspace-relatif du fichier. */
  path: string;
  /** Numéro de ligne (1-based, côté new-file). */
  line: number;
  /** Texte de la ligne dans le diff (trimmé, sans marqueur +/-). */
  snippet: string;
  /** Note laissée par l'utilisateur. */
  note: string;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const KEY = ["cockpit", "inlineComments"] as const;

/** Compteur module-scope (déterministe, remis à 0 à chaque rechargement du module). */
let _counter = 0;

function getAll(): InlineComment[] {
  return queryClient.getQueryData<InlineComment[]>(KEY) ?? [];
}

function setAll(comments: InlineComment[]): void {
  queryClient.setQueryData<InlineComment[]>(KEY, comments);
}

// ---------------------------------------------------------------------------
// Public API (non-hook)
// ---------------------------------------------------------------------------

/** Ajoute un commentaire à la file. */
export function addComment(c: Omit<InlineComment, "id">): void {
  const id = `${c.path}:${c.line}:${++_counter}`;
  setAll([...getAll(), { ...c, id }]);
}

/** Retire un commentaire de la file par son id. */
export function removeComment(id: string): void {
  setAll(getAll().filter((c) => c.id !== id));
}

/** Vide entièrement la file (appelé juste après le send). */
export function clearComments(): void {
  setAll([]);
}

/** Lecture synchrone de la file (pour le send path, sans React). */
export function getComments(): InlineComment[] {
  return getAll();
}

// ---------------------------------------------------------------------------
// Hook réactif (pour le tray et le chip du composer)
// ---------------------------------------------------------------------------

export function useComments(): InlineComment[] {
  const { data = [] } = useQuery<InlineComment[]>({
    queryKey: KEY,
    queryFn: () => getAll(),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data;
}
