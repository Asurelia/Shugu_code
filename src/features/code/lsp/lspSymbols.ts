// Shugu Forge — mapping LSP DocumentSymbol → OutlineSymbol (Lot B §6b).
//
// textDocument/documentSymbol renvoie un arbre hiérarchique de symboles avec
// des SymbolKind numériques (LSP spec). On les convertit vers le type
// OutlineSymbol de l'app (déjà aligné sur LSP). Fonction PURE pour testabilité :
// la conversion ligne 0-based → offset document est injectée (lineToOffset).
import type { OutlineSymbol, SymbolKind } from "../outline/queries";

// LSP SymbolKind (1-based, spec) → notre SymbolKind. Les kinds non mappés
// tombent sur "variable" (neutre).
// Réf : https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#symbolKind
const KIND_MAP: Record<number, SymbolKind> = {
  5: "class",      // Class
  6: "method",     // Method
  9: "method",     // Constructor
  10: "enum",      // Enum
  11: "interface", // Interface
  12: "function",  // Function
  23: "class",     // Struct
  26: "type",      // TypeParameter
  8: "variable",   // Field
  13: "variable",  // Variable
  7: "variable",   // Property
};

interface LspPosition { line: number; character: number }
interface LspRange { start: LspPosition; end: LspPosition }
export interface LspDocumentSymbol {
  name: string;
  kind: number;
  range: LspRange;
  selectionRange?: LspRange;
  children?: LspDocumentSymbol[];
}

/** Convertit l'arbre LSP en arbre OutlineSymbol. `lineToOffset` mappe une
 *  ligne 0-based (LSP) vers un offset absolu dans le document CodeMirror. */
export function lspSymbolsToOutline(
  symbols: LspDocumentSymbol[],
  lineToOffset: (line0: number) => number,
): OutlineSymbol[] {
  return symbols.map((s) => {
    const kind = KIND_MAP[s.kind] ?? "variable";
    const out: OutlineSymbol = {
      name: s.name,
      kind,
      from: lineToOffset(s.range.start.line),
      to: lineToOffset(s.range.end.line),
    };
    if (s.children && s.children.length > 0) {
      out.children = lspSymbolsToOutline(s.children, lineToOffset);
    }
    return out;
  });
}
