// Shugu Forge — Lot 5 (scaffold) — éligibilité + séquencement des requêtes.
//
// Deux pièces PURES (testées) du pipeline d'autocomplete, isolées de tout I/O
// et de CodeMirror :
//   - shouldRequestCompletion : faut-il demander une complétion dans ce contexte ?
//   - RequestSequencer        : jeton monotone pour annuler les requêtes obsolètes
//                               (une frappe pendant un fetch en vol invalide ce
//                               fetch — sa réponse tardive est ignorée).
// Le debounce lui-même (timer) vit dans le hook de déclenchement (non pur).

/**
 * Heuristique d'éligibilité — évite de spammer le backend dans des contextes
 * sans valeur. À RÉGLER en runtime (cf. flag du lot) :
 *   - préfixe vide / blanc → non (rien à continuer).
 *   - curseur au milieu d'un identifiant (le caractère suivant est alphanum/_)
 *     → non (l'utilisateur édite dans un token, pas en fin de frappe).
 */
export function shouldRequestCompletion(prefix: string, suffix: string): boolean {
  if (prefix.trim().length === 0) return false;
  if (/^[A-Za-z0-9_]/.test(suffix)) return false;
  return true;
}

/**
 * Jeton de séquence monotone. `next()` ouvre une nouvelle requête (et invalide
 * implicitement les précédentes) ; `isCurrent(id)` dit si une réponse qui
 * arrive correspond encore à la requête en cours ; `cancel()` invalide tout
 * fetch en vol sans en ouvrir un nouveau (frappe / Échap / blur).
 */
export class RequestSequencer {
  private current = 0;

  next(): number {
    this.current += 1;
    return this.current;
  }

  isCurrent(id: number): boolean {
    return id === this.current;
  }

  cancel(): void {
    this.current += 1;
  }
}

/**
 * Nettoie la complétion brute renvoyée par le modèle avant l'affichage en ghost
 * text : retire les sentinelles FIM qui fuient parfois, coupe au premier
 * caractère de fin-de-stream, et borne à `maxLines` lignes (une suggestion
 * inline ne doit pas déverser 50 lignes). Pur + testé.
 */
export function sanitizeCompletion(raw: string, maxLines = 8): string {
  if (typeof raw !== "string" || raw.length === 0) return "";
  let out = raw;
  // 1. Coupe à la PREMIÈRE sentinelle de fin de stream — tout ce qui suit est
  //    du bruit. (Avant de retirer les sentinelles inline, sinon on n'aurait
  //    plus rien à couper.)
  const stop = out.search(/<\|?(endoftext|eot_id|eot|file_sep)\|?>/);
  if (stop >= 0) out = out.slice(0, stop);
  // 2. Retire les sentinelles FIM qui fuient parfois au milieu.
  out = out
    .replace(/<\|?fim_(prefix|suffix|middle|pad)\|?>/g, "")
    .replace(/<(PRE|SUF|MID|EOT)>/g, "");
  // 3. Borne le nombre de lignes (une suggestion inline reste courte).
  const lines = out.split("\n");
  return lines.length > maxLines ? lines.slice(0, maxLines).join("\n") : out;
}
