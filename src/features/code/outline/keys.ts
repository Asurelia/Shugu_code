// Shugu Forge — TanStack queryKey factory pour la feature outline (LOT 2).
//
// La key inclut `docVersion` (un compteur incrémenté à chaque docChanged
// dans CodeMirror) pour invalider le cache automatiquement quand le user
// édite. Sans ça, l'outline resterait figé sur l'ancien parse Lezer.

export const outlineKeys = {
  all: ["outline"] as const,
  /** Outline pour le fichier `path` à la version `docVersion`. */
  forFile: (path: string, docVersion: number) =>
    [...outlineKeys.all, path, docVersion] as const,
};
