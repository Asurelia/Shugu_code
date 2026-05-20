// Shugu Forge — minimal markdown-fence parser for AI replies.
//
// The chat_send command (and the upstream LLM providers Anthropic / OpenAI
// / Ollama) return plain prose with embedded ```lang fenced code blocks.
// The UI's CodeBlock component (views-chat.tsx:148) already knows how to
// highlight + offer "Open in editor" — but only if the message arrives in
// the structured shape { body, code: { lang, text } }. This parser bridges
// the two: it scans the raw reply, lifts fenced blocks out into a typed
// array, and returns whatever prose remained around them.
//
// Why regex instead of a real markdown lib (remark / marked / unified):
//   - Zero new deps, ~10 lines of logic, bundles to nothing.
//   - We only care about ONE markdown feature (fenced code blocks). Full
//     markdown parsing isn't needed; the prose passes through as-is and
//     renders inside a <p> tag.
//   - Adding remark would pull in ~50 KB of micromark for a single regex.
//
// V1 limitation: nested fences (a code block whose content itself contains
// triple-backticks) aren't supported — they're rare in practice (LLMs use
// quadruple-backticks or indented blocks when they need to escape). Lazy
// match `*?` ensures we stop at the first closing ``` on its own.

export interface ParsedCodeBlock {
  lang: string;
  text: string;
  /** Target file path declared by the block — either a token in the fence
   *  info-string (```` ```ts src/foo.ts ````) or a first-line path comment
   *  (`// path: src/foo.ts`, `# filepath: a/b.py`, `// src/bare.ts`). Drives
   *  the chat "Apply" button (Lot 2). Forward-slashed, workspace-relative as
   *  written by the model; the caller resolves it against the workspace root.
   *  NOTE: the comment is intentionally LEFT in `text` so the path stays
   *  re-detectable after the message round-trips through SQLite (which only
   *  persists lang+text). It is stripped at apply time via stripPathComment. */
  path?: string;
}

export interface ParsedReply {
  /** Everything OUTSIDE the fenced code blocks, joined and trimmed. */
  prose: string;
  /** All extracted blocks in order of appearance. */
  codeBlocks: ParsedCodeBlock[];
}

// ---------------------------------------------------------------------------
// Path detection (Lot 2 — apply-to-file)
// ---------------------------------------------------------------------------

/**
 * A token "looks like a path" if it carries a directory separator or a file
 * extension and isn't a URL or an attribute. Used to (a) tell a language id
 * (`ts`, `c#`) from a path (`src/foo.ts`) inside a fence info-string, and
 * (b) validate the capture of a first-line path comment.
 */
function looksLikePath(token: string): boolean {
  if (!token) return false;
  const t = token.replace(/^['"`]+|['"`]+$/g, ""); // unwrap outer quotes
  if (!t || /["'`=]/.test(t)) return false; // leftover quote / attr (title="x.js")
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return false; // URL (http://, file://)
  return t.includes("/") || t.includes("\\") || /\.[A-Za-z0-9]+$/.test(t);
}

/** Unwrap outer quotes, forward-slash, drop a leading "./". */
function normalizePath(raw: string): string {
  return raw
    .trim()
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim();
}

/** Split a fence info-string into a language id + an optional path token. */
function parseInfoString(info: string): { lang: string; path?: string } {
  const trimmed = info.trim();
  if (!trimmed) return { lang: "text" };
  const tokens = trimmed.split(/\s+/);
  const first = tokens[0];
  const firstIsLang = /^[a-zA-Z0-9+_#-]+$/.test(first) && !looksLikePath(first);
  const lang = (firstIsLang ? first : "text").toLowerCase();
  const rest = firstIsLang ? tokens.slice(1) : tokens;
  const pathTok = rest.find(looksLikePath);
  return pathTok ? { lang, path: normalizePath(pathTok) } : { lang };
}

// First-line path-declaration comment conventions emitted by assistants:
//   // path: src/x.ts     // filepath: src/x.ts     # path: src/x.py
//   <!-- path: a/b.html -->   /* path: a/b.css */   // src/bare/path.ts
const PATH_KEYWORD_LINE_RE =
  /^[ \t]*(?:\/\/|#|;|--)[ \t]*(?:file ?path|path|file)[ \t]*[:=][ \t]*(.+?)[ \t]*$/i;
const PATH_KEYWORD_BLOCK_RE =
  /^[ \t]*(?:<!--|\/\*)[ \t]*(?:file ?path|path|file)[ \t]*[:=][ \t]*(.+?)[ \t]*(?:-->|\*\/)[ \t]*$/i;
const PATH_BARE_LINE_RE = /^[ \t]*(?:\/\/|#)[ \t]*(\S+)[ \t]*$/;

/**
 * Detect a declared target path from a code block's first line. Returns the
 * normalised path, or undefined when the first line isn't a path declaration.
 * Pure + idempotent: runs at parse time, at render time (after the SQLite
 * round-trip drops the parsed `path`), and before apply.
 */
export function detectBlockPath(text: string): string | undefined {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const kw =
    firstLine.match(PATH_KEYWORD_LINE_RE) ?? firstLine.match(PATH_KEYWORD_BLOCK_RE);
  if (kw && kw[1] && looksLikePath(kw[1])) return normalizePath(kw[1]);
  const bare = firstLine.match(PATH_BARE_LINE_RE);
  if (bare && looksLikePath(bare[1])) return normalizePath(bare[1]);
  return undefined;
}

/**
 * Strip the leading path-declaration comment (and one trailing blank line)
 * so the applied file doesn't receive the metadata comment. No-op when the
 * first line isn't a path declaration.
 */
export function stripPathComment(text: string): string {
  if (detectBlockPath(text) === undefined) return text;
  const lines = text.split(/\r?\n/);
  lines.shift();
  if (lines.length && lines[0].trim() === "") lines.shift();
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Fence extraction
// ---------------------------------------------------------------------------

// Match  ```<info>\n ... up to the next  \n```  (or EOF). The info-string is
// captured whole ([^\n\r]*) — not just a lang id — so blocks that annotate the
// fence with a path or attributes (```` ```ts src/foo.ts ````) still match
// (the old `[a-z0-9+_#-]*` pattern silently DROPPED such blocks). lang + path
// are split out of the info-string by parseInfoString.
const FENCE_RE = /```([^\n\r]*)\r?\n([\s\S]*?)```/gi;

export function parseAiReply(raw: string): ParsedReply {
  if (typeof raw !== "string" || raw.length === 0) {
    return { prose: "", codeBlocks: [] };
  }

  const codeBlocks: ParsedCodeBlock[] = [];

  const prose = raw.replace(FENCE_RE, (_match, info: string, body: string) => {
    // Trim a single trailing newline that fenced blocks conventionally carry
    // (the `\n` before the closing ```). Leading whitespace is preserved —
    // that's user-meaningful indentation.
    const text = body.replace(/\r?\n$/, "");
    const { lang, path: pathFromInfo } = parseInfoString(info);
    const path = pathFromInfo ?? detectBlockPath(text);
    const block: ParsedCodeBlock = { lang, text };
    if (path) block.path = path;
    codeBlocks.push(block);
    return ""; // remove from prose
  });

  // Collapse runs of blank lines left behind by extraction and trim edges.
  // A reply that opened with "Here is the code:\n\n```...\n```\n" would
  // otherwise leave a trailing "\n\n" that renders as visible whitespace.
  const cleanedProse = prose
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { prose: cleanedProse, codeBlocks };
}
