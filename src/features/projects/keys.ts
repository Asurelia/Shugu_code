// Shugu Forge — TanStack queryKey factory for the projects feature (V18).

export const projectKeys = {
  all: ["projects"] as const,

  /** Registered projects, ordered most-recently-opened. */
  list: () => [...projectKeys.all, "list"] as const,

  /** Active-conversation count per project id. */
  counts: () => [...projectKeys.all, "counts"] as const,

  /** The project resolved from a given workspace root (the current folder). */
  current: (root: string | null) =>
    [...projectKeys.all, "current", root ?? "__none__"] as const,
};
