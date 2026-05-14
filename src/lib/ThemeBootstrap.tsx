// Applies persisted Interface settings (density, font scale, glass toggle, etc.) once on mount.
// Components that change Interface settings call applyInterfaceVars themselves; this just
// runs the very first paint with the user's last-saved values so the UI doesn't flash.

import { useEffect } from "react";
import { applyInterfaceVars, DEFAULT_INTERFACE, loadJSON } from "@/features/settings/settings-extras";

export function ThemeBootstrap() {
  useEffect(() => {
    const s = { ...DEFAULT_INTERFACE, ...loadJSON("shugu.interface.v1", {}) };
    applyInterfaceVars(s);
  }, []);
  return null;
}
