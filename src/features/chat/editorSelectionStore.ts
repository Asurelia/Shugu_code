// src/features/chat/editorSelectionStore.ts
// Sélection courante de l'éditeur, publiée par CodeMirrorEditor et lue par le
// composer chat (même hors /code). TanStack-cached (pattern useActiveModel).
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";

export interface EditorSelection {
  path: string;
  text: string;
  startLine: number;
  endLine: number;
}

const KEY = ["chat", "editorSelection"] as const;

/** Publie la sélection (null = aucune sélection non vide). Appelé par l'éditeur. */
export function setEditorSelection(sel: EditorSelection | null): void {
  queryClient.setQueryData<EditorSelection | null>(KEY, sel ?? null);
}

/** Lecture non-hook (pour le send path). */
export function getEditorSelection(): EditorSelection | null {
  return queryClient.getQueryData<EditorSelection | null>(KEY) ?? null;
}

/** Hook réactif (pour le chip du composer). */
export function useEditorSelection(): EditorSelection | null {
  const { data = null } = useQuery<EditorSelection | null>({
    queryKey: KEY,
    queryFn: () => getEditorSelection(),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data;
}
