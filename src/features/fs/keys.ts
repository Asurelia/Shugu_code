// Shugu Forge — TanStack queryKey factory pour la feature fs.

export const fsKeys = {
  all: ["fs"] as const,

  /** Workspace root path (le dossier ouvert). */
  workspaceRoot: () => [...fsKeys.all, "workspace-root"] as const,

  /** Arbre récursif du workspace (cf. `fs_read_dir` Rust command). */
  tree: () => [...fsKeys.all, "tree"] as const,

  /** Contenu d'un fichier (workspace-relative path). */
  file: (path: string) => [...fsKeys.all, "file", path] as const,
};
