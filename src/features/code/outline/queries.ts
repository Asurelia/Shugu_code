// Shugu Forge — Outline symbols (LOT 2).
//
// Source des symboles : le syntax tree Lezer maintenu par CodeMirror. On
// parse en O(n) (n = nombre de noeuds), filtre par type (FunctionDeclaration,
// ClassDeclaration, MethodDeclaration, InterfaceDeclaration, ATXHeading[1-6],
// etc.) et on émet une structure plate qui colle au DocumentSymbol LSP —
// ce qui permettra de swap la source Lezer pour LSP en LOT 3 sans toucher
// la UI OutlinePanel.
//
// Politique TanStack : queryKey = (path, docVersion) → cache automatique.
// Le docVersion incrémente sur chaque docChanged dans CodeMirror, ce qui
// invalide proprement le cache. staleTime: Infinity car la donnée n'est
// jamais stale tant que docVersion n'a pas bougé.

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { outlineKeys } from "./keys";

/**
 * Symbole structurel (fonction, classe, heading…). Aligné sur LSP
 * `DocumentSymbol` pour pouvoir swap la source en LOT 3 sans casser l'UI.
 */
export interface OutlineSymbol {
  /** Nom affiché (e.g. "useEffect", "ChatPanel", "## Section"). */
  name: string;
  /** Catégorie pour l'icône (fonction / classe / heading / …). */
  kind: SymbolKind;
  /** Range absolue dans le document (offsets). */
  from: number;
  to: number;
  /** Symboles enfants (méthodes d'une classe, headings imbriqués). */
  children?: OutlineSymbol[];
}

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "enum"
  | "variable"
  | "heading"
  // Smoke test feedback — kinds sémantiques détectés depuis le body
  // des const-arrow-functions (TanStack convention). Permet à l'outline
  // de distinguer un useQuery d'un useMutation visuellement.
  | "query"
  | "mutation";

// Map node.name Lezer → SymbolKind. Couvre TS/JS, Python, Rust et Markdown
// (les 4 langages avec syntax extension installée).
//
// Smoke test fix : VariableDeclaration retiré de la map (auparavant tout
// `const x = 1` apparaissait, polluant l'outline avec des `q`, `id`,
// `effect`, etc.). À la place, parseLezerSymbols détecte SPÉCIFIQUEMENT
// les const dont l'init est une ArrowFunction / ClassExpression, qui
// sont les vrais composants/fonctions exportés (e.g. React FCs).
const KIND_FOR_NODE: Record<string, SymbolKind> = {
  // JS/TS (lezer-javascript) — déclarations structurelles
  FunctionDeclaration: "function",
  ClassDeclaration: "class",
  MethodDeclaration: "method",
  InterfaceDeclaration: "interface",
  TypeAliasDeclaration: "type",
  EnumDeclaration: "enum",
  // Python (lezer-python)
  FunctionDefinition: "function",
  ClassDefinition: "class",
  // Markdown (lezer-markdown)
  ATXHeading1: "heading",
  ATXHeading2: "heading",
  ATXHeading3: "heading",
  ATXHeading4: "heading",
  ATXHeading5: "heading",
  ATXHeading6: "heading",
  SetextHeading1: "heading",
  SetextHeading2: "heading",
};

/**
 * Vérifie si un VariableDeclaration contient une ArrowFunction ou
 * ClassExpression comme initializer — donc si c'est un "vrai" composant
 * fonctionnel (React FC, factory, etc.) qui mérite sa place dans l'outline.
 *
 * Walk shallow : on regarde uniquement les enfants directs du VariableDeclaration
 * (qui ont un VariableDefinition + Equals + <expression>). On évite de
 * descendre dans le corps de la fonction (sinon on aurait un faux positif
 * pour `const x = something(() => ...)`).
 */
function variableDeclIsFunctionLike(
  node: { node: { firstChild: unknown } },
): { kind: SymbolKind } | null {
  // SyntaxNodeRef.node = SyntaxNode. SyntaxNode.firstChild / nextSibling.
  // Typage minimal pour ne pas avoir à importer SyntaxNode (alourdirait
  // les imports Lezer). On itère via les méthodes runtime.
  type Cur = { name: string; nextSibling: Cur | null } | null;
  let cur = (node.node as { firstChild: Cur }).firstChild;
  while (cur) {
    if (cur.name === "ArrowFunction" || cur.name === "FunctionExpression") {
      return { kind: "function" };
    }
    if (cur.name === "ClassExpression") {
      return { kind: "class" };
    }
    cur = cur.nextSibling;
  }
  return null;
}

/**
 * Parse le syntax tree de l'état CodeMirror et retourne la liste plate
 * des symboles structurels. Hiérarchie reconstruite : un MethodDeclaration
 * sous un ClassDeclaration devient `children` du class.
 *
 * Complexité : O(n) où n = nombre de noeuds dans l'arbre Lezer (très rapide
 * car Lezer est incremental).
 */
export function parseLezerSymbols(state: EditorState): OutlineSymbol[] {
  const tree = syntaxTree(state);
  const doc = state.doc;
  const stack: OutlineSymbol[][] = [[]]; // pile de listes children
  const stackKinds: Array<SymbolKind | null> = [null];

  tree.iterate({
    enter: (node) => {
      let kind: SymbolKind | undefined = KIND_FOR_NODE[node.name];

      // Cas spécial : VariableDeclaration n'est dans la map que via cette
      // branche, et SEULEMENT si son initializer est une ArrowFunction ou
      // ClassExpression. Ça capture les `export const Foo = () => ...` (React)
      // sans polluer l'outline avec tous les `const q = ...`.
      if (!kind && node.name === "VariableDeclaration") {
        const fnLike = variableDeclIsFunctionLike(node);
        if (fnLike) {
          kind = fnLike.kind;
          // Détection sémantique TanStack — UNIQUEMENT pour const-arrow-functions.
          // Fix critical reviewer : précédemment ce check était hors du bloc
          // VariableDeclaration, donc un composant React `function UserList()
          // { const u = useQuery(...) }` (FunctionDeclaration) était reclassifié
          // "query" à tort. Maintenant : seuls les `const x = useQuery(...)` /
          // `const x = useMutation(...)` arrow-functions sont décorés.
          if (kind === "function") {
            const body = doc.sliceString(node.from, Math.min(node.from + 200, node.to));
            if (/\buseQuery\s*\(/.test(body)) kind = "query";
            else if (/\buseMutation\s*\(/.test(body)) kind = "mutation";
          }
        }
      }

      if (!kind) return;

      // extractSymbolName retourne toujours une string non-vide (fallback
      // "<anonymous>"), donc pas de guard supplémentaire ici.
      const name = extractSymbolName(node, doc);

      const sym: OutlineSymbol = {
        name,
        kind,
        from: node.from,
        to: node.to,
      };
      stack[stack.length - 1].push(sym);

      // Si ce symbole peut avoir des enfants (class, interface), on push
      // un nouveau children-array. Sinon on ne descend pas dans la hiérarchie.
      if (kind === "class" || kind === "interface" || kind === "heading") {
        sym.children = [];
        stack.push(sym.children);
        stackKinds.push(kind);
      }
    },
    leave: (node) => {
      const kind = KIND_FOR_NODE[node.name];
      if (kind === "class" || kind === "interface" || kind === "heading") {
        if (stackKinds[stackKinds.length - 1] === kind) {
          stack.pop();
          stackKinds.pop();
        }
      }
    },
  });

  return stack[0];
}

/**
 * Extrait le nom d'un symbole depuis ses enfants Lezer. Stratégie :
 *   - Cherche un noeud nommé `VariableDefinition`, `PropertyName`, `TypeName`,
 *     ou similaire dans les premiers enfants.
 *   - Sinon : extrait le premier word du contenu du noeud (heading markdown).
 *   - Fallback : `<anonymous>`.
 *
 * NB : on évite de descendre profondément (coûte cher sur les gros blocs) ;
 * on regarde juste les premiers enfants directs.
 */
function extractSymbolName(
  node: { from: number; to: number; node: { firstChild: unknown } },
  doc: { sliceString: (from: number, to: number) => string },
): string {
  // Cas spécial heading markdown : tout le contenu du noeud, sans le #
  const fullText = doc.sliceString(node.from, node.to).trim();

  // Heading markdown : extraire après les #
  if (/^#+\s/.test(fullText)) {
    return fullText.replace(/^#+\s*/, "").split("\n")[0].slice(0, 80);
  }

  // Autre : cherche un identificateur dans les premiers 200 chars
  const head = fullText.slice(0, 200);
  // Pattern : nom après "function", "class", "interface", "type", "enum",
  // "def" (Python), "const/let/var" (JS).
  const match = head.match(
    /\b(?:function|class|interface|type|enum|def)\s+(\w+)/,
  );
  if (match) return match[1];

  // Const/let/var : prendre le 1er identificateur après le keyword.
  const constMatch = head.match(/\b(?:const|let|var)\s+(\w+)/);
  if (constMatch) return constMatch[1];

  // Fallback : 1er word non-keyword
  const firstWord = head.match(/\w+/);
  return firstWord ? firstWord[0] : "<anonymous>";
}

/**
 * Hook React : retourne les symboles outline du fichier ouvert, mis à jour
 * automatiquement quand le doc change (docVersion bumped).
 */
export function useOutline(
  filePath: string | null,
  docVersion: number,
  state: EditorState | null,
): UseQueryResult<OutlineSymbol[]> {
  return useQuery({
    queryKey: outlineKeys.forFile(filePath ?? "", docVersion),
    queryFn: () => {
      if (!state) return [];
      return parseLezerSymbols(state);
    },
    enabled: !!filePath && !!state,
    staleTime: Infinity, // la docVersion fait office d'invalidation key.
  });
}
