// Shugu Forge — socle mémoire mascotte : types, validation pure, broadcast.
//
// Le CRUD vit dans db.ts (pattern de l'app) ; ce module isole la logique PURE
// (testable sans Tauri) et le canal de diffusion cross-fenêtre (event Tauri,
// même patron que calibration.ts — le bus Tauri franchit les WebviewWindow,
// contrairement au `storage` event qui n'est pas fiable entre webviews).

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

/** Rabat toute valeur inconnue/absente sur "general" (catégorie contrôlée côté TS). */
export function normalizeCategory(c: string | undefined | null): MascotCategory {
  return (MASCOT_CATEGORIES as readonly string[]).includes(c ?? "")
    ? (c as MascotCategory)
    : "general";
}

export interface NormalizedFact {
  category: MascotCategory;
  key: string;
  value: string;
}

/** Message d'erreur de validation, ou null si l'entrée est valide. */
export function validateFactInput(input: { key?: string; value?: string }): string | null {
  const key = (input.key ?? "").trim();
  const value = (input.value ?? "").trim();
  if (!key) return "La clé est obligatoire.";
  if (!value) return "La valeur est obligatoire.";
  if (key.length > 80) return "La clé est trop longue (80 max).";
  if (value.length > 2000) return "La valeur est trop longue (2000 max).";
  return null;
}

/** Normalise une saisie (catégorie rabattue, trim). À appeler APRÈS validation. */
export function normalizeFactInput(input: {
  category?: string;
  key?: string;
  value?: string;
}): NormalizedFact {
  return {
    category: normalizeCategory(input.category),
    key: (input.key ?? "").trim(),
    value: (input.value ?? "").trim(),
  };
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

/** S'abonne aux changements cross-fenêtre. Retourne une fonction de désabonnement. */
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
