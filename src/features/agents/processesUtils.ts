// Shugu Forge — P6.9 : helpers PURS pour la section « Terminaux » d'AgentsPanel.
// Testables en Vitest, pattern tokenUsage.ts / pluginsUtils.ts.

/** Libellé FR honnête d'un statut de processus d'arrière-plan. */
export function processStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "en cours";
    case "exited":
      return "terminé";
    case "interrupted":
      return "interrompu (suivi perdu)";
    case "killed":
      return "tué";
    default:
      return status;
  }
}

/** Teinte du statut pour les chips. */
export function processStatusTone(status: string): "success" | "warn" | "danger" | "muted" {
  switch (status) {
    case "running":
      return "success";
    case "interrupted":
      return "warn";
    case "killed":
      return "danger";
    case "exited":
    default:
      return "muted";
  }
}

/** Libellé court d'un statut de session shell. */
export function sessionStatusLabel(alive: boolean): string {
  return alive ? "active" : "terminée";
}

const MAX_TAIL_LINES = 40;
const MAX_LINE_CHARS = 400;

/** Formate une queue de sortie pour l'affichage : dernières N lignes, lignes
 *  bornées, marqueur de troncature honnête quand la sortie est plus longue. */
export function formatTail(tail: string): string {
  const trimmed = tail.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!trimmed.trim()) return "(pas de sortie)";
  const lines = trimmed.split("\n");
  const shown = lines.slice(-MAX_TAIL_LINES).map((l) =>
    l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + "…" : l,
  );
  const hidden = lines.length - shown.length;
  return (hidden > 0 ? `… ${hidden} ligne(s) plus tôt masquée(s) …\n` : "") + shown.join("\n");
}
