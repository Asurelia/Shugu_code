// Shugu Forge — TanStack queryKey factory pour la feature grep (LOT 2).
//
// Suit le pattern src/features/fs/keys.ts. La key search() inclut les opts
// pour que des recherches différentes (case-sensitive vs pas, regex vs pas)
// soient cachées séparément — un toggle ne réémet pas le réseau.

import type { GrepOpts } from "./queries";

export const grepKeys = {
  all: ["grep"] as const,
  /** Recherche workspace pour `query` avec les options données. */
  search: (query: string, opts: GrepOpts) =>
    [
      ...grepKeys.all,
      "search",
      query,
      opts.caseSensitive ? "cs" : "ci",
      opts.regex ? "rx" : "lit",
      opts.maxResults ?? 0,
    ] as const,
};
