// Shugu Forge — IDE session state persistence (open tabs / active file).
//
// Per the LOCAL-FIRST mandate, this layer goes through SQLite via
// db.settings (key/value) rather than localStorage. Two reasons:
//   1. Survives across the main IDE + mascot windows uniformly.
//   2. Stays inside the same shugu.db file as the rest of the user data.
//
// Web mode (pnpm dev, no Tauri): db.settings.get/set are no-ops/null, so
// load() returns null and save() silently does nothing. The IDE still
// renders with whatever seed file tree it has — just without tab restore.

import { db } from "@/lib/db";

const KEY = "ide.openFiles.v1";

export interface IdeOpenState {
  openFiles: string[];
  activeFile: string | null;
}

interface SerializedShape {
  openFiles: unknown;
  activeFile: unknown;
}

function isString(v: unknown): v is string {
  return typeof v === "string";
}

/** Persist the current open-tab set. Best-effort: a failure (quota,
 * locked DB) is logged and swallowed — losing tab restore is acceptable. */
export async function saveOpenFiles(state: IdeOpenState): Promise<void> {
  try {
    // Normalize: dedupe + strip non-strings before serialization.
    const openFiles = Array.from(new Set(state.openFiles.filter(isString)));
    const activeFile = isString(state.activeFile) ? state.activeFile : null;
    await db.settings.set(KEY, JSON.stringify({ openFiles, activeFile }));
  } catch (err) {
    console.warn("[ide-state] saveOpenFiles failed:", err);
  }
}

/** Read the persisted tab state. Returns null if absent, malformed, or
 * if we're in web mode. Schema-tolerant: drops unknown fields, validates
 * types per field, falls back to defaults for invalid pieces. */
export async function loadOpenFiles(): Promise<IdeOpenState | null> {
  try {
    const raw = await db.settings.get(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SerializedShape;
    const openFiles = Array.isArray(parsed.openFiles)
      ? parsed.openFiles.filter(isString)
      : [];
    const activeFile = isString(parsed.activeFile) ? parsed.activeFile : null;
    if (openFiles.length === 0 && !activeFile) return null;
    return { openFiles, activeFile };
  } catch (err) {
    console.warn("[ide-state] loadOpenFiles failed:", err);
    return null;
  }
}
