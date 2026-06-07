// Shugu Forge — conversions URI ↔ path relatif pour le LSP (Lot B §2).
//
// Extraites de client.ts pour être testables ET réutilisées par ShuguWorkspace,
// qui doit faire le chemin INVERSE : l'URI d'une définition renvoyée par le
// serveur → le path relatif du fichier à ouvrir dans l'éditeur.

/** workspaceUri (file:///F:/Dev/shugu_code) + path relatif → file URI complet.
 *  encodeURI préserve `/` (séparateur) et encode espaces/accents/?/# — requis
 *  car rust-analyzer/pylsp rejettent les URI non-RFC3986. */
export function fileUriForPath(workspaceUri: string, relativePath: string): string {
  const ws = workspaceUri.replace(/\/+$/, "");
  const rel = encodeURI(relativePath.replace(/^\/+/, ""));
  return `${ws}/${rel}`;
}

/** file URI → path relatif au workspace, ou null si l'URI est hors workspace.
 *  Inverse de fileUriForPath : strip le préfixe workspace, décode le %xx.
 *  Comparaison case-insensitive du préfixe (Windows : le drive peut arriver
 *  en `file:///F:/…` ou `file:///f:/…` selon la source). */
export function relativePathFromUri(workspaceUri: string, uri: string): string | null {
  const ws = workspaceUri.replace(/\/+$/, "");
  // Windows : casse du drive non garantie → compare en lowercase pour le test
  // d'appartenance, mais on découpe sur la longueur réelle.
  if (uri.length < ws.length) return null;
  if (uri.slice(0, ws.length).toLowerCase() !== ws.toLowerCase()) return null;
  let rest = uri.slice(ws.length).replace(/^\/+/, "");
  try {
    rest = decodeURI(rest);
  } catch {
    // URI malformée : on garde la version encodée plutôt que de throw.
  }
  return rest;
}
