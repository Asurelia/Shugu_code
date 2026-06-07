// src/features/chat/codeBlockTarget.ts
// Shugu Forge — Lot A — résolution de la cible d'apply d'un bloc de code.
// Cherche un chemin workspace-relatif : (1) dans l'info-string (```ts path),
// (2) sinon en 1ʳᵉ ligne de commentaire (// path | # path). null si aucun.

function looksLikePath(t: string): boolean {
  return t.includes("/") || /\.[A-Za-z0-9]+$/.test(t);
}

function pickPath(token: string | undefined): string | null {
  if (!token) return null;
  const t = token.trim().replace(/^\.\//, "").replace(/\\/g, "/");
  return t && looksLikePath(t) ? t : null;
}

/** `info` = texte après les ``` (ex "ts src/foo.ts") ; `body` = contenu du bloc. */
export function parseCodeBlockTarget(info: string, body: string): string | null {
  // (1) info-string : "lang path" → 2ᵉ token
  const infoParts = (info ?? "").trim().split(/\s+/);
  if (infoParts.length >= 2) {
    const fromInfo = pickPath(infoParts[infoParts.length - 1]);
    if (fromInfo) return fromInfo;
  }
  // (2) 1ʳᵉ ligne de commentaire
  const first = (body ?? "").split(/\r?\n/, 1)[0]?.trim() ?? "";
  const m = first.match(/^(?:\/\/|#|--|<!--)\s*(.+?)(?:\s*-->)?$/);
  if (m) return pickPath(m[1]);
  return null;
}
