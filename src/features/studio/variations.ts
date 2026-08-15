// Shugu Forge — Studio parallel variations (Lot C) — task builder.
//
// "3 directions" spawns one agent per contrasting design direction; each
// deposits ONE self-contained variant via `studio_deposit_exploration`, which
// the disk→canvas sync then merges as an exploration frame beside the product.
// Directions are deliberately opinionated so three runs never converge.

import { slugifyExploration } from "./canvas/canvasExplorations";

export interface VariationSpec {
  slug: string;
  direction: string;
  hints: string;
}

/** The three canonical contrasting directions (order matters: dark / light / bold). */
export function defaultVariations(seed: string): VariationSpec[] {
  const base = slugifyExploration(seed || "variante");
  return [
    {
      slug: `${base}-sombre`,
      direction: "Direction sombre & immersive",
      hints:
        "fond très sombre, accents lumineux saturés, typographie large et contrastée, " +
        "surfaces en verre dépoli, ambiance premium",
    },
    {
      slug: `${base}-editoriale`,
      direction: "Direction claire & éditoriale",
      hints:
        "fond clair papier, serif display pour les titres, grille stricte, beaucoup " +
        "d'espace blanc, accents uniques et sobres",
    },
    {
      slug: `${base}-expressive`,
      direction: "Direction expressive & audacieuse",
      hints:
        "couleurs franches inattendues, formes asymétriques, typographie oversized, " +
        "mouvement et micro-interactions marquées",
    },
  ];
}

/**
 * Task for ONE variation agent. The agent must deposit exactly one exploration
 * frame and never touch the live product in `.shugu-forge/preview/`.
 */
export function buildVariationTask(brief: string, v: VariationSpec): string {
  return [
    `Crée UNE exploration de design pour ce brief : ${brief}`,
    "",
    `${v.direction} — ${v.hints}.`,
    "",
    "Livre UNE page HTML autonome et complète (CSS inline, JS inline si utile),",
    "visuellement aboutie (vraie grille, vraie typographie, contenu réaliste en français),",
    `en appelant l'outil studio_deposit_exploration avec name "${v.direction}",`,
    `slug "${v.slug}" et le document HTML complet.`,
    "",
    "N'écris RIEN dans .shugu-forge/preview/ — c'est le produit live, interdit pour une variante.",
    "Termine par un résumé d'une phrase de la direction choisie.",
  ].join("\n");
}
