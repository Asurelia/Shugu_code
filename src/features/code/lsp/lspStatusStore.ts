// Shugu Forge — état observable du LSP par langage (Lot B §4).
//
// Projection sérialisable de ce que client.ts sait déjà (les LSPClient
// eux-mêmes sont stateful → pas de useQuery dessus, cf. client.ts l.15-18 ;
// mais leur ÉTAT est un snapshot → TanStack approprié, cohérent avec
// editorSelectionStore). client.ts appelle setLspStatus à chaque transition.
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";

export type LspStatus =
  | "absent" // pas de LSP pour cette langue, ou binaire non installé
  | "starting" // spawn + initialize en cours
  | "ready" // serveur opérationnel
  | "error"; // crash / EOF / erreur de framing

const KEY = ["lsp", "status"] as const;

// Message d'erreur le plus récent par langage (raison du statut "error"),
// pour que l'indicateur explique POURQUOI au lieu d'un "erreur" muet.
// Hors du cache TanStack (pas besoin de réactivité — lu à la demande au clic).
const errorDetails = new Map<string, string>();

/** Enregistre le message d'erreur d'un langage (appelé par client.ts). */
export function setLspError(langId: string, message: string): void {
  errorDetails.set(langId, message);
}

/** Lecture du dernier message d'erreur (ou null). */
export function getLspError(langId: string): string | null {
  return errorDetails.get(langId) ?? null;
}

function readMap(): Record<string, LspStatus> {
  return queryClient.getQueryData<Record<string, LspStatus>>(KEY) ?? {};
}

/** Publie l'état d'un langage. Appelé par client.ts. */
export function setLspStatus(langId: string, status: LspStatus): void {
  const next = { ...readMap(), [langId]: status };
  queryClient.setQueryData<Record<string, LspStatus>>(KEY, next);
}

/** Lecture non-hook d'un langage (défaut "absent"). */
export function getLspStatus(langId: string): LspStatus {
  return readMap()[langId] ?? "absent";
}

/** Lecture non-hook de la map complète. */
export function getAllLspStatus(): Record<string, LspStatus> {
  return readMap();
}

/** Hook réactif pour un langage (utilisé par LspStatusIndicator). */
export function useLspStatus(langId: string | null): LspStatus {
  const { data = {} } = useQuery<Record<string, LspStatus>>({
    queryKey: KEY,
    queryFn: () => readMap(),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  if (!langId) return "absent";
  return data[langId] ?? "absent";
}
