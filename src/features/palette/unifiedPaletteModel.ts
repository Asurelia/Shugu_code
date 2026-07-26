import { fuzzyScore } from "@/features/code/QuickOpenPalette";

export type UnifiedPaletteScope =
  | "all"
  | "commands"
  | "files"
  | "conversations";

export interface ParsedPaletteQuery {
  scope: UnifiedPaletteScope;
  query: string;
}

const SCOPE_PREFIXES: Record<string, UnifiedPaletteScope> = {
  ">": "commands",
  "#": "files",
  "@": "conversations",
};

export function parsePaletteQuery(raw: string): ParsedPaletteQuery {
  const trimmedStart = raw.trimStart();
  const scope = SCOPE_PREFIXES[trimmedStart[0]];
  if (!scope) return { scope: "all", query: raw.trim() };
  return { scope, query: trimmedStart.slice(1).trim() };
}

/**
 * Shared ranking for commands, workspace paths and conversation titles.
 * Prefix and contiguous matches intentionally outrank a loose subsequence.
 */
export function paletteMatchScore(
  title: string,
  hint: string,
  query: string,
): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;

  const normalizedTitle = title.toLowerCase();
  const normalizedHint = hint.toLowerCase();
  const searchable = `${hint ? `${hint}/` : ""}${title}`;
  const candidates = [title, hint, searchable].filter(Boolean);
  const scores = candidates.map((candidate) => {
    const normalized = candidate.toLowerCase();
    const fuzzy = fuzzyScore(candidate, needle);
    if (fuzzy < 0) return -1;

    // Long, scattered subsequences make unrelated command descriptions look
    // relevant. Keep compact fuzzy matches (e.g. "vchat" → "views-chat") and
    // reject accidental acronym soup.
    let cursor = 0;
    let first = -1;
    let last = -1;
    for (const char of needle) {
      const at = normalized.indexOf(char, cursor);
      if (at < 0) return -1;
      if (first < 0) first = at;
      last = at;
      cursor = at + 1;
    }
    const spread = last - first + 1;
    const maxSpread = Math.max(needle.length * 4, needle.length + 12);
    return needle.length >= 3 && spread > maxSpread ? -1 : fuzzy;
  });
  const fuzzy = Math.max(...scores);
  if (fuzzy < 0) return -1;

  let bonus = 0;
  if (normalizedTitle === needle) bonus += 2_000;
  else if (normalizedTitle.startsWith(needle)) bonus += 1_200;
  else {
    const contiguousAt = normalizedTitle.indexOf(needle);
    if (contiguousAt >= 0) bonus += 850 - Math.min(contiguousAt, 200);
    else if (normalizedHint.includes(needle)) bonus += 350;
  }
  return fuzzy + bonus;
}
