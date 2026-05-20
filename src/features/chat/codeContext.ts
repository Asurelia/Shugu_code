// Shugu Forge — Suite Lot 4 — auto-RAG : contexte code pertinent pour le chat.
//
// Recherche sémantique sur les chunks indexés (collection "code", cf. Lot 4
// chunker + workspaceIndexer), relit le contenu des hits depuis le disque via
// l'id `path#Lstart-end`, et formate un bloc de contexte injectable.
//
// ⚠ La QUALITÉ de la récupération dépend du modèle d'embedding + de l'état de
// l'index (réglage runtime). La RÉSOLUTION id→fichier→lignes est déterministe.
// Opt-in (db.settings "rag.autoCodeContext") car ça consomme des tokens et peut
// injecter du contexte hors-sujet si l'index est pauvre.

import { vecSearch } from "@/lib/vector";
import { fsReadFile } from "@/lib/fs";
import { parseChunkId } from "@/features/fs/chunker";

export interface CodeContextChunk {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

/** Extrait les lignes [startLine, endLine] (1-indexées, inclusives). */
function sliceLines(content: string, startLine: number, endLine: number): string {
  const lines = content.split(/\r?\n/);
  return lines.slice(Math.max(0, startLine - 1), endLine).join("\n");
}

/**
 * Récupère jusqu'à `k` chunks de code sémantiquement proches de `query`, relus
 * depuis le disque. Best-effort : un hit dont l'id est malformé ou le fichier
 * a disparu est ignoré. Une erreur de vecSearch (index absent) → [].
 */
export async function resolveCodeContext(query: string, k = 5): Promise<CodeContextChunk[]> {
  let hits;
  try {
    hits = await vecSearch("code", query, k);
  } catch {
    return [];
  }
  const out: CodeContextChunk[] = [];
  for (const hit of hits) {
    const parsed = parseChunkId(hit.id);
    if (!parsed) continue;
    try {
      const file = await fsReadFile(parsed.path);
      const text = sliceLines(file.text, parsed.startLine, parsed.endLine);
      if (text.trim()) out.push({ ...parsed, text });
    } catch {
      // fichier disparu / illisible → skip
    }
  }
  return out;
}

/** Formate les chunks récupérés en bloc de contexte (pur). Vide → "". */
export function buildCodeContext(chunks: CodeContextChunk[]): string {
  if (chunks.length === 0) return "";
  const parts = chunks.map(
    (c) => `### ${c.path}:${c.startLine}-${c.endLine}\n\`\`\`\n${c.text}\n\`\`\``,
  );
  return `Extraits de code potentiellement pertinents (recherche sémantique du workspace) :\n\n${parts.join(
    "\n\n",
  )}`;
}
