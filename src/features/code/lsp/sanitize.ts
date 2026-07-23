// Shugu Forge — sanitizer pour le HTML rendu depuis le Markdown LSP (Lot B §5).
//
// Les hovers/diagnostics LSP arrivent en Markdown, rendu en HTML par
// @codemirror/lsp-client. Sans sanitize, un serveur LSP compromis (ou fourni
// par un dépôt hostile via node_modules/.bin) pourrait injecter du JS dans la
// webview. On passe cette fonction à LSPClient.sanitizeHTML.
import DOMPurify from "dompurify";

const FORBIDDEN_TAGS = ["script", "style", "iframe", "object", "embed", "form"];
const URI_ATTRIBUTES = new Set(["href", "src", "xlink:href", "action", "formaction"]);

/**
 * Defense in depth after DOMPurify. WebView2 is DOMPurify's production DOM,
 * but alternative DOM implementations used by tests have historically parsed
 * forbidden elements differently. Never let that implementation detail turn
 * into executable markup at the CodeMirror boundary.
 */
function enforceSafeHtmlShape(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  template.content.querySelectorAll(FORBIDDEN_TAGS.join(",")).forEach((node) => node.remove());
  template.content.querySelectorAll("*").forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (
        name.startsWith("on") ||
        name === "style" ||
        name.startsWith("data-") ||
        (URI_ATTRIBUTES.has(name) && /^\s*(?:javascript|vbscript):/i.test(attribute.value))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  });
  return template.innerHTML;
}

/** Assainit le HTML d'un hover/diagnostic LSP : pas de <script>, pas de
 *  handlers on*, pas d'href javascript:. Les liens https/file et le code
 *  restent intacts (utiles pour la doc). */
export function sanitizeLspHtml(html: string): string {
  const prefiltered = enforceSafeHtmlShape(html);
  const sanitized = DOMPurify.sanitize(prefiltered, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: ["style"],
    ALLOW_DATA_ATTR: false,
  });
  return enforceSafeHtmlShape(sanitized);
}
