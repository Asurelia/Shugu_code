export type McpToolEffect =
  | "sharedRead"
  | "externalRead"
  | "additiveWrite"
  | "destructiveWrite"
  | "unknown";

export interface McpToolEffectMeta {
  label: string;
  tone: "read" | "write" | "danger" | "unknown";
  allowedInAuto: boolean;
  description: string;
}

const EFFECT_META: Record<McpToolEffect, McpToolEffectMeta> = {
  sharedRead: {
    label: "lecture bornée",
    tone: "read",
    allowedInAuto: true,
    description: "Lecture déclarée dans un domaine fermé.",
  },
  externalRead: {
    label: "lecture externe",
    tone: "read",
    allowedInAuto: true,
    description: "Lecture déclarée d’une source externe ou ouverte.",
  },
  additiveWrite: {
    label: "écriture",
    tone: "write",
    allowedInAuto: false,
    description: "Mutation déclarée additive, réservée à Full Access.",
  },
  destructiveWrite: {
    label: "destructif",
    tone: "danger",
    allowedInAuto: false,
    description: "Mutation potentiellement destructive, réservée à Full Access.",
  },
  unknown: {
    label: "effet inconnu",
    tone: "unknown",
    allowedInAuto: false,
    description:
      "Le serveur ne déclare pas d’effet fiable ; Shugu bloque cet outil hors Full Access.",
  },
};

export function getMcpToolEffectMeta(
  effect: McpToolEffect,
): McpToolEffectMeta {
  return EFFECT_META[effect] ?? EFFECT_META.unknown;
}
