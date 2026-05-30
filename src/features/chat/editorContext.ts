// src/features/chat/editorContext.ts
// Shugu Forge — Lot A — contexte éditeur auto pour le chat.
//
// Construit un bloc markdown injectable (fichier actif + sélection) ajouté au
// dernier message user ENVOYÉ au modèle (jamais persisté), comme @-mentions/RAG
// dans chat-sync.ts. Pur (testable). Cap par fichier identique aux mentions.

const MAX_BYTES = 24_000;

export interface EditorContextInput {
  /** Chemin workspace-relatif du fichier de l'onglet actif ("" si aucun). */
  path: string;
  /** Contenu du fichier actif. */
  content: string;
  /** Sélection courante dans l'éditeur, si non vide. */
  selection?: { text: string; startLine: number; endLine: number };
}

export interface EditorContextOpts {
  /** Chemins déjà fournis ailleurs (@-mentions) — on ne réinjecte pas le fichier. */
  skipPaths?: string[];
}

function truncate(s: string): string {
  return s.length > MAX_BYTES ? s.slice(0, MAX_BYTES) + "\n… [tronqué]" : s;
}

/** Bloc de contexte éditeur. "" si rien à injecter. */
export function buildEditorContext(
  input: EditorContextInput,
  opts: EditorContextOpts = {},
): string {
  const path = (input.path ?? "").trim();
  const skip = new Set(opts.skipPaths ?? []);
  const parts: string[] = [];

  // Sélection d'abord (plus prioritaire que le fichier entier).
  const sel = input.selection;
  if (sel && sel.text.trim()) {
    parts.push(
      `Sélection courante dans \`${path || "le fichier actif"}\` (L${sel.startLine}-${sel.endLine}) :\n\`\`\`\n${truncate(sel.text)}\n\`\`\``,
    );
  }

  // Fichier actif (sauf s'il est déjà @-mentionné).
  if (path && !skip.has(path) && (input.content ?? "").length > 0) {
    parts.push(`Fichier ouvert \`${path}\` :\n\`\`\`\n${truncate(input.content)}\n\`\`\``);
  }

  if (parts.length === 0) return "";
  return `Contexte de l'éditeur (l'utilisateur travaille dessus) :\n\n${parts.join("\n\n")}`;
}
