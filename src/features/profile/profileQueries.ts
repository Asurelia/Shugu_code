// Shugu Forge — TanStack Query hooks for the user profile.
//
// Single source of truth shared by BOTH the titlebar AccountDropdown and the
// Settings → Profile view, so the two never drift (cf. the "no duplicate
// rendering" rule: share the data logic via a common hook, duplicate only
// styles). Values live in the local SQLite `settings` table (db.settings),
// which is the durable source of truth — no cloud account, no subscription.
//
// The activity counts and the active model / interface language are sourced
// from their OWN existing systems (db.stats, useActiveModel, the interface
// settings blob) and merely surfaced here — we do not fork a second copy.

import { useQuery } from "@tanstack/react-query";
import { db, type LocalCounts } from "@/lib/db";
import { queryClient } from "@/lib/queryClient";

// SQLite settings keys. Suffixed `.v1` like every other key in the app so a
// future shape change can migrate without clobbering existing rows.
const K_NAME = "profile.displayName.v1";
const K_EMAIL = "profile.email.v1";

export const profileKeys = {
  all: ["profile"] as const,
  fields: () => [...profileKeys.all, "fields"] as const,
  stats: () => [...profileKeys.all, "stats"] as const,
};

export interface ProfileFields {
  name: string;
  email: string;
}

/**
 * Display name + email, read from SQLite. Empty strings when unset (fresh
 * install) — the UI renders an inviting empty state rather than a fake identity.
 * Resilient: outside Tauri (web preview / tests) the SQL plugin is absent, so we
 * swallow the error and return blanks instead of throwing.
 */
export function useProfileFields() {
  return useQuery<ProfileFields>({
    queryKey: profileKeys.fields(),
    queryFn: async () => {
      try {
        const [name, email] = await Promise.all([
          db.settings.get(K_NAME),
          db.settings.get(K_EMAIL),
        ]);
        return { name: name ?? "", email: email ?? "" };
      } catch {
        return { name: "", email: "" };
      }
    },
    staleTime: Infinity,
  });
}

/**
 * Persist a partial profile edit to SQLite, then invalidate so every consumer
 * (card + settings page) reflects it immediately. Only provided fields are
 * written — undefined keys are left untouched.
 */
export async function saveProfileFields(patch: Partial<ProfileFields>): Promise<void> {
  if (patch.name !== undefined) await db.settings.set(K_NAME, patch.name);
  if (patch.email !== undefined) await db.settings.set(K_EMAIL, patch.email);
  await queryClient.invalidateQueries({ queryKey: profileKeys.fields() });
}

/**
 * Real local activity counts (conversations / messages / images generated),
 * straight from SQLite. Short staleTime so re-opening the card after a chat
 * shows fresh numbers; resilient to the plugin being absent.
 */
export function useLocalStats() {
  return useQuery<LocalCounts>({
    queryKey: profileKeys.stats(),
    queryFn: async () => {
      try {
        return await db.stats.counts();
      } catch {
        return { conversations: 0, messages: 0, images: 0 };
      }
    },
    staleTime: 15_000,
  });
}

/**
 * Avatar label = the first two letters of the pseudo (the user's explicit
 * expectation), whitespace ignored: "Rafaillac Sylvain" → "RA", "Shugu" → "SH".
 * "" when the name is unset so callers fall back to a generic user glyph.
 */
export function initialsOf(name: string): string {
  const letters = name.trim().replace(/\s+/g, "");
  return letters.slice(0, 2).toUpperCase();
}

/** Short, human label for a `<provider>/<model>` id — keeps only the model part.
 *  Shared by the account card and the profile page so the two never drift. */
export function modelLabel(m: string): string {
  if (!m) return "aucun modèle actif";
  return m.includes("/") ? m.slice(m.lastIndexOf("/") + 1) : m;
}

/**
 * Honest platform label derived from the webview UA — no `@tauri-apps/plugin-os`
 * dependency needed. Replaces the old hardcoded (and wrong) "macOS 14 · arm64".
 */
export function detectPlatform(): string {
  const ua = (navigator.userAgent || "").toLowerCase();
  const plat = (navigator.platform || "").toLowerCase();
  if (ua.includes("windows") || plat.includes("win")) return "Windows";
  if (ua.includes("mac os") || ua.includes("macintosh") || plat.includes("mac")) return "macOS";
  if (ua.includes("linux") || plat.includes("linux")) return "Linux";
  return "Desktop";
}
