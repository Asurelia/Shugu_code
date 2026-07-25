// Shugu Forge — P6.3 rewind par tour : helpers PURS (aucune I/O), testables
// en Vitest dans la lignée de followUpQueue.ts / tokenUsage.ts.
//
// Couvre le choix affiché à l'utilisateur (« Revenir ici ») et le contenu de
// la boîte de confirmation — le composant RewindControl ne fait que rendre.

import type { SnapshotPreview } from "@/lib/rewind";

/** Les trois modes de rewind proposés par le plan P6.3. */
export type RewindChoice = "files" | "conversation" | "both";

/** Choix proposés pour un message donné : le fork de conversation est toujours
 *  possible ; les modes fichiers exigent un tour agent (le checkpoint
 *  `refs/shugu/turn/<agentId>` n'existe que pour les runs, et pas en lecture
 *  seule — le backend refusera proprement s'il est absent). */
export function rewindChoicesFor(m: { viaAgent?: boolean; agentId?: string }): RewindChoice[] {
  const hasRun = m.viaAgent === true && typeof m.agentId === "string" && m.agentId.length > 0;
  return hasRun ? ["files", "conversation", "both"] : ["conversation"];
}

export interface RewindConfirm {
  title: string;
  /** Lignes du corps de la boîte (fichiers restaurés/supprimés, filet de sécurité). */
  lines: string[];
  /** true → ton danger (action qui écrase l'état du workspace). */
  danger: boolean;
  confirmLabel: string;
}

const MAX_LISTED_FILES = 8;

function fileLines(label: string, files: string[], empty: string): string[] {
  if (files.length === 0) return [`${label} : ${empty}`];
  const shown = files.slice(0, MAX_LISTED_FILES).map((f) => `  ${f}`);
  if (files.length > MAX_LISTED_FILES) {
    shown.push(`  … et ${files.length - MAX_LISTED_FILES} autre(s)`);
  }
  return [`${label} (${files.length}) :`, ...shown];
}

/** Contenu de la boîte de confirmation pour un choix + un preview fichiers
 *  (null pour « conversation seule »). Mentionne TOUJOURS le filet de sécurité
 *  (checkpoint pré-revert) pour les modes fichiers : le rewind est rewindable. */
export function rewindConfirmContent(
  choice: RewindChoice,
  preview: SnapshotPreview | null,
): RewindConfirm {
  const safety =
    "Un checkpoint de secours de l'état actuel est pris juste avant : ce rewind est lui-même réversible.";
  if (choice === "conversation") {
    return {
      title: "Créer une branche de conversation ici ?",
      lines: [
        "Une nouvelle conversation copiera les messages jusqu'à celui-ci (inclus).",
        "La conversation actuelle est conservée telle quelle — aucun fichier n'est touché.",
      ],
      danger: false,
      confirmLabel: "Créer la branche",
    };
  }
  const p = preview;
  const lines: string[] = [];
  if (p) {
    lines.push(...fileLines("Fichiers restaurés à l'état du checkpoint", p.restored, "aucun"));
    lines.push(...fileLines("Fichiers créés après le checkpoint SUPPRIMÉS", p.removed, "aucun"));
  }
  lines.push(safety);
  if (choice === "both") {
    lines.push("Une branche de conversation sera aussi créée à partir de ce message.");
  }
  return {
    title:
      choice === "both"
        ? "Revenir ici — fichiers ET conversation ?"
        : "Restaurer les fichiers à ce checkpoint ?",
    lines,
    danger: true,
    confirmLabel: choice === "both" ? "Revenir ici (fichiers + branche)" : "Restaurer les fichiers",
  };
}

/** Résumé toast après un rewind fichiers appliqué. */
export function rewindResultSummary(restored: number, removed: number, safetyRef: string | null): string {
  const parts = [`${restored} fichier(s) restauré(s)`, `${removed} supprimé(s)`];
  return safetyRef
    ? `Rewind appliqué — ${parts.join(", ")}. Réversible via le checkpoint de secours.`
    : `Rewind appliqué — ${parts.join(", ")}. ⚠ Checkpoint de secours non capturé : rewind non réversible.`;
}
