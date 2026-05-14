// Applies persisted Interface settings (density, font scale, glass toggle, etc.) once on mount.
// Components that change Interface settings call applyInterfaceVars themselves; this just
// runs the very first paint with the user's last-saved values so the UI doesn't flash.

import { useEffect } from "react";
import { applyInterfaceVars, DEFAULT_INTERFACE, loadJSON, hydrateSettingsFromSqlite } from "@/features/settings/settings-extras";

export function ThemeBootstrap() {
  useEffect(() => {
    // Hydrate localStorage from SQLite BEFORE reading interface settings so
    // a fresh session on a machine with SQLite data but cleared localStorage
    // recovers the persisted values on the very first paint.
    void (async () => {
      await hydrateSettingsFromSqlite();
      const s = { ...DEFAULT_INTERFACE, ...loadJSON("shugu.interface.v1", {}) };
      applyInterfaceVars(s);
    })();
  }, []);
  return null;
}
