// src/features/cockpit/layoutPersistence.ts
// LOCAL-FIRST persistence of the cockpit layout, mirroring ide-state.ts:
// SQLite db.settings, key "ide.layout.v1", schema-tolerant load.
import { normalizeLayout, DEFAULT_LAYOUT, type CockpitLayout } from "./layout";

const KEY = "ide.layout.v1";

/** Read the persisted layout (defaults if absent/malformed). */
export async function loadLayout(): Promise<CockpitLayout> {
  try {
    const { db } = await import("@/lib/db");
    const raw = await db.settings.get(KEY);
    if (!raw) return { ...DEFAULT_LAYOUT };
    return normalizeLayout(JSON.parse(raw));
  } catch (err) {
    console.warn("[cockpit] loadLayout failed:", err);
    return { ...DEFAULT_LAYOUT };
  }
}

/** Persist the layout. Best-effort: a failure is logged and swallowed. */
export async function saveLayout(layout: CockpitLayout): Promise<void> {
  try {
    const { db } = await import("@/lib/db");
    await db.settings.set(KEY, JSON.stringify(normalizeLayout(layout)));
  } catch (err) {
    console.warn("[cockpit] saveLayout failed:", err);
  }
}
