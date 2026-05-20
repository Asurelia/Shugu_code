// Shugu Forge — Lot 5 (scaffold) — construction du prompt Fill-In-the-Middle.
//
// L'autocomplete "tab" (ghost text) demande au modèle de COMPLÉTER le code À
// L'ENDROIT du curseur, en voyant le préfixe (avant) ET le suffixe (après) —
// c'est le mode FIM. Chaque famille de modèle utilise ses propres sentinelles ;
// ce module mappe famille → template. Pur + testé. La QUALITÉ/LATENCE finale
// dépend du modèle FIM choisi et se règle en runtime (cf. flag du lot).

export type FimModelFamily = "qwen" | "codellama" | "starcoder" | "deepseek" | "generic";

/** Devine la famille FIM depuis l'id de modèle (heuristique sur le nom). */
export function detectFimFamily(model: string): FimModelFamily {
  const m = (model || "").toLowerCase();
  if (m.includes("qwen")) return "qwen";
  if (m.includes("deepseek")) return "deepseek";
  if (m.includes("codellama") || m.includes("code-llama")) return "codellama";
  if (m.includes("starcoder") || m.includes("starchat") || m.includes("santacoder")) {
    return "starcoder";
  }
  return "generic";
}

export interface FimParts {
  /** Texte AVANT le curseur (déjà fenêtré). */
  prefix: string;
  /** Texte APRÈS le curseur (déjà fenêtré). */
  suffix: string;
}

/**
 * Construit le prompt FIM pour la famille donnée. Les sentinelles diffèrent :
 *   - qwen / deepseek : <|fim_prefix|> … <|fim_suffix|> … <|fim_middle|>
 *   - codellama       : <PRE> … <SUF> … <MID>
 *   - starcoder       : <fim_prefix> … <fim_suffix> … <fim_middle>
 *   - generic         : pas de sentinelle — préfixe seul (mode complétion ;
 *                       le suffixe est perdu, dernier recours).
 */
export function buildFimPrompt({ prefix, suffix }: FimParts, family: FimModelFamily): string {
  switch (family) {
    case "qwen":
    case "deepseek":
      return `<|fim_prefix|>${prefix}<|fim_suffix|>${suffix}<|fim_middle|>`;
    case "codellama":
      return `<PRE> ${prefix} <SUF>${suffix} <MID>`;
    case "starcoder":
      return `<fim_prefix>${prefix}<fim_suffix>${suffix}<fim_middle>`;
    case "generic":
    default:
      return prefix;
  }
}

/**
 * Extrait les fenêtres préfixe/suffixe autour du curseur, bornées (on n'envoie
 * jamais tout le fichier — coût + latence). Le préfixe garde la FIN (proche du
 * curseur), le suffixe garde le DÉBUT.
 */
export function fimWindow(
  doc: string,
  cursor: number,
  maxPrefix = 2000,
  maxSuffix = 1000,
): FimParts {
  const c = Math.max(0, Math.min(cursor, doc.length));
  return {
    prefix: doc.slice(Math.max(0, c - maxPrefix), c),
    suffix: doc.slice(c, c + maxSuffix),
  };
}
