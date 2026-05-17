/**
 * useConversations — SQLite-first, Convex optional.
 *
 * SQLite is the source of truth. When Convex is enabled it is a one-way
 * sync TARGET:
 *   - Local changes should be pushed UP to Convex (follow-up work).
 *   - Convex data is NEVER pulled down as authoritative here.
 *   - Full bidirectional reconciliation with conflict resolution is a
 *     deliberate follow-up — do not implement ad-hoc merges here.
 *
 * Consequence: convexData is intentionally unused in the resolved result.
 * Convex is still subscribed so its connection stays live for future
 * push-up writes, but it never overwrites the returned data.
 */

import { useState, useEffect } from "react";
import { useQuery } from "convex/react";
import { convexEnabled } from "@/lib/convex";
import { db, rowToConvo } from "@/lib/db";
import { api } from "../../../convex/_generated/api";

export interface ConversationsResult {
  data: any[] | undefined;
  isLoading: boolean;
  source: "sqlite";
}

export function useConversations(): ConversationsResult {
  const [sqliteData, setSqliteData] = useState<any[] | null>(null);
  const [sqliteLoading, setSqliteLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rows = await db.conversations.list();
      if (!cancelled) {
        setSqliteData(rows.map(rowToConvo));
        setSqliteLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Convex query subscription — only when enabled. Result is intentionally
  // discarded (see header). The hook call must stay unconditional within a
  // given mounted lifecycle; `convexEnabled` is a module-level constant so
  // the hook position is stable across renders for a given build.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  if (convexEnabled) useQuery(api.conversations.list, {});

  return {
    data: sqliteData ?? [],
    isLoading: sqliteLoading,
    source: "sqlite",
  };
}
