// Shugu Forge — Lot 4 — découpage de source par symbole pour l'indexation RAG.
//
// Remplace l'embedding fichier-entier de workspaceIndexer (un vecteur par
// fichier → recherche grossière) par un découpage en chunks de la taille d'un
// symbole (fonction / classe / bloc top-level), chacun indexé séparément. Les
// frontières sont des heuristiques DÉTERMINISTES (donc testables) ; la qualité
// finale de la recherche dépend du modèle d'embedding (réglage runtime).
//
// Pas de parser AST (coûteux, par-langage) : on coupe sur les lignes en
// colonne 0 qui ressemblent à une déclaration top-level, avec un plafond dur
// pour borner la taille des chunks.

export interface SourceChunk {
  /** Texte du chunk (lignes brutes, indentation préservée). */
  text: string;
  /** Première ligne (1-indexée, inclusive). */
  startLine: number;
  /** Dernière ligne (1-indexée, inclusive). */
  endLine: number;
}

// Plafond dur : un chunk ne dépasse jamais ça (fichiers sans frontière claire —
// JSON, CSV, gros bloc — sont fenêtrés). ~160 lignes ≈ une grosse fonction.
const MAX_CHUNK_LINES = 160;
// On ne coupe à une frontière que si le chunk courant a au moins ce nombre de
// lignes — évite d'émettre un chunk par one-liner (suite de `const` / `import`).
const MIN_CHUNK_LINES = 6;

// Déclarations top-level multi-langage (col 0). Volontairement large : TS/JS,
// Python, Rust, Go, Java/C#, CSS at-rules. Préfixes de visibilité/async/export
// tolérés en tête.
const DECL_RE =
  /^(?:export\s+(?:default\s+)?)?(?:pub(?:\([^)]*\))?\s+)?(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|async\s+|abstract\s+|final\s+|unsafe\s+)*(?:function|class|interface|type|enum|struct|impl|trait|fn|def|func|module|namespace|component|const|let|var|val|public|private|protected|@|#\[)/;
// Entêtes markdown.
const MD_HEADER_RE = /^#{1,6}\s/;

/** Une ligne est une frontière de chunk si elle est en colonne 0 et ressemble
 *  à une déclaration top-level (ou un entête markdown). */
function isBoundary(line: string): boolean {
  if (line.length === 0 || /^\s/.test(line)) return false; // doit être en col 0
  return DECL_RE.test(line) || MD_HEADER_RE.test(line);
}

/**
 * Découpe `text` en chunks de la taille d'un symbole. Chaque chunk démarre soit
 * en tête de fichier, soit sur une frontière top-level, et est borné par
 * MAX_CHUNK_LINES. Pur + déterministe.
 *
 * Garanties (couvertes par les tests) :
 *   - texte vide / blanc → [].
 *   - chunks contigus, non chevauchants, couvrant tout le contenu non-blanc.
 *   - startLine/endLine 1-indexés, endLine inclusif.
 */
export function chunkSource(text: string): SourceChunk[] {
  if (typeof text !== "string" || text.trim().length === 0) return [];
  const lines = text.split(/\r?\n/);
  const chunks: SourceChunk[] = [];
  let start = 0; // index de début du chunk courant (0-indexé)

  const flush = (endExclusive: number) => {
    if (endExclusive <= start) return;
    const slice = lines.slice(start, endExclusive);
    const body = slice.join("\n");
    if (body.trim().length > 0) {
      chunks.push({ text: body, startLine: start + 1, endLine: endExclusive });
    }
    start = endExclusive;
  };

  for (let i = 0; i < lines.length; i++) {
    const sizeSoFar = i - start;
    const atBoundary = i > start && isBoundary(lines[i]) && sizeSoFar >= MIN_CHUNK_LINES;
    const tooBig = sizeSoFar >= MAX_CHUNK_LINES;
    if (atBoundary || tooBig) {
      flush(i);
    }
  }
  flush(lines.length);
  return chunks;
}

/** Id stable d'un chunk pour la collection vectorielle (path + plage de lignes). */
export function chunkId(path: string, chunk: SourceChunk): string {
  return `${path}#L${chunk.startLine}-${chunk.endLine}`;
}
