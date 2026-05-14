/**
 * useConversations — SQLite-first, Convex optional.
 *
 * Priority:
 *   1. Tauri mode  → SQLite (source of truth). Source = "sqlite".
 *      If convexEnabled, Convex query is also subscribed but SQLite wins;
 *      reconciliation is a documented TODO.
 *   2. Web mode    → SEED_CONVOS fallback.  Source = "mock".
 */

import { useState, useEffect } from "react";
import { useQuery } from "convex/react";
import { SEED_CONVOS } from "@/features/chat/chat-sidebar";
import { convexEnabled } from "@/lib/convex";
import { db, rowToConvo } from "@/lib/db";
import { api } from "../../../convex/_generated/api";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface ConversationsResult {
  data: any[] | undefined;
  isLoading: boolean;
  source: "sqlite" | "convex" | "mock";
}

export function useConversations(): ConversationsResult {
  // SQLite state — always declared (Rules of Hooks — no conditional hook calls)
  const [sqliteData, setSqliteData] = useState<any[] | null>(null);
  const [sqliteLoading, setSqliteLoading] = useState(inTauri);

  useEffect(() => {
    if (!inTauri) return;
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

  // Convex query — only subscribed when convexEnabled (module-level constant,
  // so this call is stable across all renders for a given build).
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const convexData = convexEnabled ? useQuery(api.conversations.list, {}) : undefined;

  // --- Resolution ---

  if (inTauri) {
    // SQLite is the primary source. Convex data is available for future reconciliation.
    // TODO: Convex↔SQLite reconciliation — merge convexData into SQLite when available.
    return {
      data: sqliteData ?? [],
      isLoading: sqliteLoading,
      source: "sqlite",
    };
  }

  if (convexEnabled) {
    // Web mode with Convex configured — use Convex directly.
    return {
      data: convexData,
      isLoading: convexData === undefined,
      source: "convex",
    };
  }

  // Web mode, no Convex — seed fallback.
  return { data: SEED_CONVOS, isLoading: false, source: "mock" };
}
