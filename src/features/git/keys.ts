// Shugu Forge — TanStack queryKey factory pour la feature git.

export const gitKeys = {
  all: ["git"] as const,

  /** Is the current workspace inside a git repository? */
  isRepo: () => [...gitKeys.all, "is-repo"] as const,

  /** HEAD content for a workspace-relative path. */
  head: (path: string) => [...gitKeys.all, "head", path] as const,
};
