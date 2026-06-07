// Shugu Forge — sanitizer pour le HTML rendu depuis le Markdown LSP (Lot B §5).
//
// Les hovers/diagnostics LSP arrivent en Markdown, rendu en HTML par
// @codemirror/lsp-client. Sans sanitize, un serveur LSP compromis (ou fourni
// par un dépôt hostile via node_modules/.bin) pourrait injecter du JS dans la
// webview. On passe cette fonction à LSPClient.sanitizeHTML.
import DOMPurify from "dompurify";

/** Assainit le HTML d'un hover/diagnostic LSP : pas de <script>, pas de
 *  handlers on*, pas d'href javascript:. Les liens https/file et le code
 *  restent intacts (utiles pour la doc). */
export function sanitizeLspHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form"],
    FORBID_ATTR: ["style"],
    ALLOW_DATA_ATTR: false,
  });
}
