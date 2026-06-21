// Shugu Forge — socle mémoire mascotte : types, validation pure, broadcast.
//
// Le CRUD vit dans db.ts (pattern de l'app) ; ce module isole la logique PURE
// (testable sans Tauri) et le canal de diffusion cross-fenêtre (event Tauri,
// même patron que calibration.ts — le bus Tauri franchit les WebviewWindow).

export const MASCOT_CATEGORIES = ["tech", "relation", "habits", "shared", "general"] as const;
export type MascotCategory = (typeof MASCOT_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<MascotCategory, string> = {
  tech: "Préférences techniques",
  relation: "Style relationnel",
  habits: "Habitudes de travail",
  shared: "Souvenirs partagés",
  general: "Divers",
};

export interface MascotFact {
  id: string;
  category: MascotCategory;
  key: string;
  value: string;
  source: "user" | "extracted";
  confidence: number;
  validated: boolean;
  createdAt: number;
  updatedAt: number;
}

export function normalizeCategory(c: string | undefined | null): MascotCategory {
  return (MASCOT_CATEGORIES as readonly string[]).includes(c ?? "")
    ? (c as MascotCategory)
    : "general";
}

export type CoerceResult =
  | { ok: true; value: { category: MascotCategory; key: string; value: string } }
  | { ok: false; error: string };

export function coerceFactInput(input: {
  category?: string; key?: string; value?: string;
}): CoerceResult {
  const key = (input.key ?? "").trim();
  const value = (input.value ?? "").trim();
  if (!key) return { ok: false, error: "La clé est obligatoire." };
  if (!value) return { ok: false, error: "La valeur est obligatoire." };
  if (key.length > 80) return { ok: false, error: "La clé est trop longue (80 max)." };
  if (value.length > 2000) return { ok: false, error: "La valeur est trop longue (2000 max)." };
  return { ok: true, value: { category: normalizeCategory(input.category), key, value } };
}

const MEMORY_EVENT = "mascot://memory-changed";

/** Diffuse un changement de mémoire à toutes les fenêtres (fire-and-forget). */
export function emitMemoryChanged(): void {
  void (async () => {
    try {
      const mod = await import("@tauri-apps/api/event");
      await mod.emit(MEMORY_EVENT, Date.now());
    } catch (err) {
      console.warn("[mascot-memory] emit failed:", err);
    }
  })();
}

/** S'abonne aux changements cross-fenêtre. Retourne un désabonnement. */
export function subscribeMemoryChanged(callback: () => void): () => void {
  let unlisten: (() => void) | null = null;
  void (async () => {
    try {
      const mod = await import("@tauri-apps/api/event");
      unlisten = await mod.listen(MEMORY_EVENT, () => callback());
    } catch (err) {
      console.warn("[mascot-memory] listen failed:", err);
    }
  })();
  return () => unlisten?.();
}
