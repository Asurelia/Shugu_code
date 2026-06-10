// Shugu Forge — Lot projets-récents (2026-06-10) — historique des workspaces.
//
// db.settings "workspace.recent" = JSON array de chemins absolus, du plus
// récent au plus ancien, plafonné à 8. Alimenté par la commande open-folder
// (palette) ET au boot (le root restauré entre dans l'historique, donc la
// liste se peuple sans action utilisateur). Consommé par le picker « Open
// Recent Folder… » (RecentWorkspacesPalette).

import { db } from "@/lib/db";

const KEY = "workspace.recent";
const MAX_RECENT = 8;

/** Liste des workspaces récents (plus récent en premier). Erreur → []. */
export async function listRecentWorkspaces(): Promise<string[]> {
  try {
    const raw = await db.settings.get(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((p): p is string => typeof p === "string") : [];
  } catch (err) {
    console.warn("[recentWorkspaces] list failed:", err);
    return [];
  }
}

/** Enregistre `root` en tête d'historique (dédupliqué, cap 8). Best-effort. */
export async function recordRecentWorkspace(root: string): Promise<void> {
  const norm = root.replace(/\\/g, "/");
  if (!norm.trim()) return;
  try {
    const cur = await listRecentWorkspaces();
    const next = [norm, ...cur.filter((p) => p !== norm)].slice(0, MAX_RECENT);
    await db.settings.set(KEY, JSON.stringify(next));
  } catch (err) {
    console.warn("[recentWorkspaces] record failed:", err);
  }
}

/** Retire une entrée (dossier supprimé/déplacé — appelé quand l'ouverture échoue). */
export async function removeRecentWorkspace(root: string): Promise<void> {
  try {
    const cur = await listRecentWorkspaces();
    await db.settings.set(KEY, JSON.stringify(cur.filter((p) => p !== root)));
  } catch (err) {
    console.warn("[recentWorkspaces] remove failed:", err);
  }
}
