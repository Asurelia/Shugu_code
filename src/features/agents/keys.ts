// Shugu Forge — TanStack queryKey factory for the agents feature.
//
// Pattern recommandé par la doc TanStack pour éviter les typos sur les
// queryKey strings, garantir la cohérence des invalidations partielles
// (un `invalidateQueries(agentKeys.all)` invalide TOUT, un
// `agentKeys.detail(id)` cible un agent précis), et profiter de l'IDE
// completion.
//
// Ordre hiérarchique : du plus large au plus précis.

export const agentKeys = {
  /** Racine de toutes les queries agent — invalide tout d'un coup. */
  all: ["agents"] as const,

  /** Listes (active, par conv, etc.). */
  lists: () => [...agentKeys.all, "list"] as const,
  /** Liste des agents actifs (status pending|running). */
  active: () => [...agentKeys.lists(), "active"] as const,
  /** Tous les agents d'une conversation donnée. */
  byConv: (conversationId: string) =>
    [...agentKeys.lists(), "by-conv", conversationId] as const,

  /** Détails (transcripts) — chacun par agentId. */
  details: () => [...agentKeys.all, "detail"] as const,
  /** Détail d'un agent (row + events). */
  detail: (agentId: string) => [...agentKeys.details(), agentId] as const,

  /** Sélection actuelle (agent dont le drawer transcript est ouvert).
   *  Pas un fetch — juste une "query" sans queryFn que les composants
   *  observent via useQuery + qu'on met à jour via setQueryData. C'est
   *  l'équivalent TanStack d'un store global pour une primitive partagée
   *  entre RootLayout (qui peut le set via `app://reveal-agent`) et
   *  AgentsPanel (qui consomme pour afficher le drawer). */
  selected: () => [...agentKeys.all, "selected"] as const,
};

// ─────────────────────────────────────────────────────────────────────
// Définitions d'agents portables (.md format Claude Code).
//
// Disjoint d'`agentKeys` qui traque les RUNS. Ces clés ciblent les
// fichiers sur disque (~/.claude/agents/*.md, <ws>/.claude/agents/*.md).
// Le scope est typé `string` localement pour éviter un import croisé
// avec `@/lib/agentDefs` ; les consommateurs passent leur AgentDefScope
// (sous-type de string) sans cast.
// ─────────────────────────────────────────────────────────────────────

export const agentDefKeys = {
  all: ["agent-defs"] as const,
  lists: () => [...agentDefKeys.all, "list"] as const,
  list: (scope: string) => [...agentDefKeys.lists(), scope] as const,
};
