// Shugu Forge — `useGitStatusMap` (LOT 2).
//
// Dérive un `Map<workspaceRelativePath, char>` à partir de `useGitStatus`,
// pour que `SideFiles` (LOT 3) puisse en O(1) annoter chaque `FileNode`
// avec son statut git visuel.
//
// Stratégie de réduction (statut le PLUS informatif en priorité) :
//   1. conflicted        → 'U'
//   2. untracked         → '?'
//   3. worktree dirty    → worktreeStatus
//   4. else              → indexStatus
//
// La table `index_status / worktree_status` produit naturellement des
// paires `'M' 'M'` (modif staged + nouvelle modif), `'A' ' '` (full
// staged), `'M' ' '` (modif staged), `' ' 'M'` (modif unstaged), `'D'
// ' '` (delete staged), etc. — la règle ci-dessus rend visible la chose
// qui mérite l'attention de l'utilisateur (un conflit, un fichier
// fraîchement créé, ou la modif locale en cours).
//
// Note pour LOT 3 : `FileNode.git` (cf. `src/lib/types.ts`) est typé
// `"M" | "A" | "D"` à l'origine — l'élargissement (ajout de `'U'` /
// `'?'`) sera fait dans LOT 3 quand `SideFiles` consommera ce Map.
// Le présent hook expose déjà le type complet pour ne pas avoir à
// changer la signature plus tard.

import { useMemo } from "react";
import type { GitFileStatus } from "@/lib/types";
import { useGitStatus } from "./queries";

/** Char retourné par `useGitStatusMap` pour chaque fichier suivi. */
export type GitStatusChar = "M" | "A" | "D" | "U" | "?";

/**
 * Réduit une ligne de statut git à un seul caractère "headline".
 *
 * Pure function — exposée pour les tests vitest (le hook lui-même est
 * juste un `useMemo` autour d'une boucle qui appelle ça).
 *
 * Les caractères en dehors de `{M, A, D, U, ?}` (R / C / T) sont mappés
 * sur 'M' faute de mieux — la UI tree ne dispose pas de glyphe dédié
 * pour les renames/copies, et "modifié" reste la lecture la plus juste.
 * `null` quand le fichier n'a aucun statut à afficher (status `' '` /
 * `' '` ne devrait pas arriver — git_status filtre ces lignes — mais on
 * reste défensif).
 */
export function computeStatusChar(s: GitFileStatus): GitStatusChar | null {
  if (s.isConflicted) return "U";
  if (s.isUntracked) return "?";
  // worktree status prend le pas s'il y a une modif locale.
  const w = s.worktreeStatus;
  if (w && w !== " ") {
    return normalizeChar(w);
  }
  const i = s.indexStatus;
  if (i && i !== " " && i !== "?") {
    return normalizeChar(i);
  }
  return null;
}

function normalizeChar(c: string): GitStatusChar {
  if (c === "M" || c === "A" || c === "D" || c === "U" || c === "?") return c;
  // R (renamed), C (copied), T (type-change) → on les présente comme
  // "modified" : c'est la lecture la plus utile dans l'arbre.
  return "M";
}

/**
 * Map workspace-relative path → char le plus informatif pour ce fichier.
 *
 * Les fichiers qui n'apparaissent pas dans le Map sont propres (clean).
 * Renvoie un Map vide quand le repo n'est pas chargé / hors d'un repo
 * git — les consumers doivent traiter `undefined` du Map comme "pas de
 * statut" (cf. `SideFiles` qui ne décore rien dans ce cas).
 */
export function useGitStatusMap(): Map<string, GitStatusChar> {
  const { data } = useGitStatus();
  return useMemo(() => {
    const m = new Map<string, GitStatusChar>();
    if (!data) return m;
    for (const row of data) {
      const c = computeStatusChar(row);
      if (c !== null) m.set(row.path, c);
    }
    return m;
  }, [data]);
}
