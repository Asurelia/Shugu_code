// Shugu Forge — Lot 4 — @-mentions de fichiers dans le chat.
//
// L'utilisateur tape `@src/foo.ts` (ou `@"chemin avec espaces.ts"`) dans le
// composer. À l'envoi, sendChatMessage résout les mentions vers le contenu des
// fichiers et l'INJECTE dans le message envoyé au modèle — SANS polluer le
// message persité (qui garde le texte `@…` propre, visible dans l'UI).
//
// parseMentions est pur (testé) ; resolveMentions fait l'I/O (lecture fichier).

import { fsReadFile } from "@/lib/fs";

// `@` suivi soit d'une chaîne entre guillemets, soit d'un token sans espace.
// Le `g` permet plusieurs mentions ; on filtre ensuite sur "ça ressemble à un
// chemin" pour ne pas capturer les mentions sociales (@quelqu'un).
const MENTION_RE = /@(?:"([^"]+)"|([^\s@"]+))/g;

/** Un token "ressemble à un chemin" s'il porte un slash ou une extension. */
function looksLikeFilePath(token: string): boolean {
  return token.includes("/") || token.includes("\\") || /\.[A-Za-z0-9]+$/.test(token);
}

/**
 * Extrait les chemins de fichiers @-mentionnés d'un texte. Dédupliqué, ordre
 * d'apparition. Ne retient que les tokens qui ressemblent à un chemin (slash
 * ou extension) — `@bob salut` ne matche pas. La ponctuation de fin
 * (`. , ; : )`) est retirée pour gérer "regarde @a.ts." → "a.ts".
 */
export function parseMentions(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  MENTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(text)) !== null) {
    const quoted = m[1] != null;
    let raw = m[1] ?? m[2] ?? "";
    // Ne pas rogner la ponctuation d'un chemin entre guillemets (explicite).
    if (!quoted) raw = raw.replace(/[.,;:)\]]+$/, "");
    const path = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    if (path && looksLikeFilePath(path) && !seen.has(path)) {
      seen.add(path);
      out.push(path);
    }
  }
  return out;
}

export interface ResolvedMention {
  path: string;
  content: string;
  error?: string;
}

/**
 * Lit chaque fichier mentionné (best-effort). Cap par fichier pour ne pas
 * exploser le contexte du modèle ; un fichier illisible devient une entrée
 * `error` (le modèle voit qu'il manque, plutôt qu'un échec silencieux).
 */
export async function resolveMentions(
  paths: string[],
  maxBytesPerFile = 24_000,
): Promise<ResolvedMention[]> {
  const out: ResolvedMention[] = [];
  for (const path of paths) {
    try {
      const file = await fsReadFile(path);
      let content = file.text;
      if (content.length > maxBytesPerFile) {
        content = content.slice(0, maxBytesPerFile) + "\n… [tronqué]";
      }
      out.push({ path, content });
    } catch (err) {
      out.push({ path, content: "", error: String(err) });
    }
  }
  return out;
}

/**
 * Construit le bloc de contexte injecté dans le prompt à partir des fichiers
 * résolus. Pur (testable). Vide → "" (rien à injecter).
 */
export function buildMentionContext(resolved: ResolvedMention[]): string {
  if (resolved.length === 0) return "";
  const parts = resolved.map((r) =>
    r.error
      ? `### @${r.path}\n(impossible de lire ce fichier : ${r.error})`
      : `### @${r.path}\n\`\`\`\n${r.content}\n\`\`\``,
  );
  return `L'utilisateur a référencé ces fichiers du workspace :\n\n${parts.join("\n\n")}`;
}
