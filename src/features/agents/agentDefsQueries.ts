// Shugu Forge — TanStack queries / mutations pour les définitions d'agents
// portables (.md format Claude Code). Source = wrappers Tauri dans
// `src/lib/agentDefs.ts` ; clés dans `keys.ts` (`agentDefKeys`).
//
// Source de vérité = fichiers sur disque. `refetchOnWindowFocus` est ON
// pour que la grille se rafraîchisse quand un autre outil (Claude Code,
// éditeur de texte) a modifié un `.md` en arrière-plan.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listAgentDefs,
  writeAgentDef,
  deleteAgentDef,
  type AgentDef,
  type AgentDefScope,
} from "@/lib/agentDefs";
import { agentDefKeys } from "./keys";

/** Liste les agents d'un scope. */
export function useAgentDefs(scope: AgentDefScope = "all") {
  return useQuery<AgentDef[]>({
    queryKey: agentDefKeys.list(scope),
    queryFn: () => listAgentDefs(scope),
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  });
}

/** Crée ou met à jour un agent (file write côté backend). Invalide toutes
 *  les listes (un agent peut migrer entre scopes ; invalidation large = sûre). */
export function useWriteAgentDef() {
  const qc = useQueryClient();
  return useMutation<string, Error, AgentDef>({
    mutationFn: (def) => writeAgentDef(def),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: agentDefKeys.lists() });
    },
  });
}

/** Supprime un agent par chemin absolu. */
export function useDeleteAgentDef() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (path) => deleteAgentDef(path),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: agentDefKeys.lists() });
    },
  });
}
