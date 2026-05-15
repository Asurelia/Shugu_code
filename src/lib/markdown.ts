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
}

export interface ParsedReply {
  /** Everything OUTSIDE the fenced code blocks, joined and trimmed. */
  prose: string;
  /** All extracted blocks in order of appearance. */
  codeBlocks: ParsedCodeBlock[];
}

// Match  ```lang\n  ... up to the next  \n```  (or EOF).
// Language ids allowed: lowercase letters, digits, +, -, _, # (e.g. c#).
// The closing fence must be on its own line OR at EOF — we accept both
// because LLM output sometimes omits the trailing newline before EOS.
const FENCE_RE = /```([a-z0-9+_#-]*)\r?\n([\s\S]*?)```/gi;

export function parseAiReply(raw: string): ParsedReply {
  if (typeof raw !== "string" || raw.length === 0) {
    return { prose: "", codeBlocks: [] };
  }

  const codeBlocks: ParsedCodeBlock[] = [];

  const prose = raw.replace(FENCE_RE, (_match, lang: string, text: string) => {
    codeBlocks.push({
      lang: (lang || "text").toLowerCase(),
      // Trim a single trailing newline that fenced blocks conventionally
      // carry (the `\n` before the closing ```). Leading whitespace inside
      // the block is preserved — that's user-meaningful indentation.
      text: text.replace(/\r?\n$/, ""),
    });
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
