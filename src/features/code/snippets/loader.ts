// Shugu Forge — Snippet loader + completion source (LOT 1.2).
//
// Politique TanStack : on charge les snippets via useQuery même si le fichier
// est statique côté front. Justification :
//   1. Cache automatique cross-component (FindPanel, Outline, CodeMirror tous
//      branchés sur la même clé).
//   2. staleTime: Infinity → un seul fetch par langage, plus jamais.
//   3. Permet l'invalidation future si on ajoute un éditeur de snippets user.
//   4. Cohérent avec la politique TanStack-par-défaut du projet (cf. mémoire
//      feedback_tanstack_mandatory).
//
// Format des snippets : compatible avec snippetCompletion() de @codemirror/autocomplete
// (label, body avec ${N:placeholder} tab-stops). Voir snippets/*.json.

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { snippetCompletion, type Completion, type CompletionSource } from "@codemirror/autocomplete";
import { queryClient } from "@/lib/queryClient";
import { snippetKeys } from "./keys";

export interface SnippetDef {
  label: string;
  prefix: string;
  description?: string;
  body: string;
}

// Dynamic import map — keys must be statically known by Vite so dynamic
// import can analyse them. We list each supported language explicitly.
//
// Note : un langage absent ici retourne [] (pas d'erreur). C'est volontaire :
// si l'utilisateur ouvre un fichier .ts on charge typescript.json ; pour un
// .css ou .toml on n'a juste pas de snippet et autocomplete fonctionne quand
// même avec les autres sources.
const SNIPPET_LOADERS: Record<string, () => Promise<{ default: SnippetDef[] }>> = {
  typescript: () => import("./typescript.json"),
  javascript: () => import("./typescript.json"), // TS snippets are JS-compatible
  python:     () => import("./python.json"),
  rust:       () => import("./rust.json"),
  markdown:   () => import("./markdown.json"),
};

/** Fetch the snippet definitions for a given language. Returns [] if unsupported. */
async function fetchSnippets(lang: string): Promise<SnippetDef[]> {
  const loader = SNIPPET_LOADERS[lang.toLowerCase()];
  if (!loader) return [];
  const mod = await loader();
  return mod.default;
}

/**
 * React hook — exposes the snippets for a language with TanStack caching.
 * Not strictly needed by CodeMirror (which uses the completion source
 * factory below), but available if a UI panel ever wants to list snippets.
 */
export function useSnippets(lang: string): UseQueryResult<SnippetDef[]> {
  return useQuery({
    queryKey: snippetKeys.byLang(lang),
    queryFn: () => fetchSnippets(lang),
    staleTime: Infinity, // les snippets sont statiques, jamais stale.
  });
}

/**
 * Convert SnippetDef[] into Completion[] using snippetCompletion() helpers.
 * The snippet body's ${N:placeholder} syntax becomes tab-stops at insertion.
 */
function buildCompletions(defs: SnippetDef[]): Completion[] {
  return defs.map((def) =>
    snippetCompletion(def.body, {
      label: def.label,
      detail: def.description,
      type: "keyword", // pour distinguer visuellement des completions LSP futures
      boost: 1, // léger boost pour faire remonter les snippets en haut quand le prefix matche
    })
  );
}

/**
 * Module-level cache (en plus du cache TanStack) — évite de reconvertir les
 * defs en Completion[] à chaque appel de la completion source. CodeMirror
 * appelle la source à chaque keystroke, donc le coût d'allocation compte.
 */
const completionCache = new Map<string, Completion[]>();

async function getCachedCompletions(lang: string): Promise<Completion[]> {
  const langKey = lang.toLowerCase();
  if (completionCache.has(langKey)) return completionCache.get(langKey)!;

  // Préférer le cache TanStack s'il est chaud (déjà fetché par useSnippets
  // dans un autre composant), sinon fetch direct.
  const cached = queryClient.getQueryData<SnippetDef[]>(snippetKeys.byLang(langKey));
  const defs = cached ?? await queryClient.fetchQuery({
    queryKey: snippetKeys.byLang(langKey),
    queryFn: () => fetchSnippets(langKey),
    staleTime: Infinity,
  });

  const completions = buildCompletions(defs);
  completionCache.set(langKey, completions);
  return completions;
}

/**
 * Build a CodeMirror CompletionSource for the given language. Returns a
 * function that CodeMirror calls on each completion trigger ; the function
 * resolves the snippets (cached) and filters by prefix.
 *
 * Usage dans CodeMirrorEditor : passer ce résultat à autocompletion({ override: [...] }).
 */
export function snippetCompletionSource(lang: string): CompletionSource {
  return async (context) => {
    const word = context.matchBefore(/\w+/);
    if (!word || (word.from === word.to && !context.explicit)) return null;

    const completions = await getCachedCompletions(lang);
    if (completions.length === 0) return null;

    return {
      from: word.from,
      options: completions,
      // validFor : tant que ce qui suit le `from` est encore un word, on peut
      // filtrer côté CodeMirror sans rappeler la source (gros gain perf sur frappe rapide).
      validFor: /^\w*$/,
    };
  };
}
