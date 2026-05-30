// Shugu Forge — TanStack queryKey factory pour la feature fs.

export const fsKeys = {
  all: ["fs"] as const,

  /** Workspace root path (le dossier ouvert). */
  workspaceRoot: () => [...fsKeys.all, "workspace-root"] as const,

  /** Arbre récursif COMPLET du workspace (cf. `fs_read_dir`). Utilisé par
   *  l'indexer vectoriel et les panneaux Studio, PAS par l'explorateur. */
  tree: () => [...fsKeys.all, "tree"] as const,

  /** Enfants directs d'UN dossier (lazy tree, cf. `fs_read_dir_shallow`).
   *  `""` = racine du workspace. L'explorateur fetch un niveau à l'expansion. */
  dir: (path: string) => [...fsKeys.all, "dir", path] as const,

  /** Sous-arbre récursif d'UN sous-chemin (cf. `fs_read_dir_scoped`).
   *  Utilisé par Studio pour ne lire que `.shugu-forge/preview/`, sans le cap. */
  scoped: (path: string) => [...fsKeys.all, "scoped", path] as const,

  /** Contenu d'un fichier (workspace-relative path). */
  file: (path: string) => [...fsKeys.all, "file", path] as const,
};
