// Shugu Forge — TanStack Query keys for the snippets feature.
//
// Suit le pattern src/features/fs/keys.ts : un namespace stable + builder
// pour les clés dérivées. Permet l'invalidation ciblée par langage si
// un jour on supporte l'édition de snippets côté user (hors scope LOT 1).

export const snippetKeys = {
  all: ["snippets"] as const,
  byLang: (lang: string) => [...snippetKeys.all, lang] as const,
};
