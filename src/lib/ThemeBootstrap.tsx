// The synchronous local cache is already applied by /theme-preload.js before
// React loads. This component hydrates a missing cache from SQLite, reapplies
// the resolved values, and keeps the opaque Tauri window background aligned.

import { useEffect } from "react";
import {
  applyInterfaceVars,
  DEFAULT_INTERFACE,
  loadJSON,
  hydrateSettingsFromSqlite,
} from "@/features/settings/settings-extras";

export function ThemeBootstrap() {
  useEffect(() => {
    // Hydrate localStorage from SQLite BEFORE reading interface settings so
    // a fresh session on a machine with SQLite data but cleared localStorage
    // recovers the persisted values on the very first paint.
    void (async () => {
      await hydrateSettingsFromSqlite();
      const s = { ...DEFAULT_INTERFACE, ...loadJSON("shugu.interface.v1", {}) };
      applyInterfaceVars(s);

      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const currentWindow = getCurrentWindow();
        // The mascot window is intentionally OS-transparent.
        if (currentWindow.label === "main") {
          await currentWindow.setBackgroundColor("#050510");
        }
      } catch {
        // Vite-only UI tours have no Tauri runtime.
      }
    })();
  }, []);
  return null;
}
