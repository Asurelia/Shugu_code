// src/features/cockpit/UnifiedDiff.tsx
// Small unified-diff text parser + renderer for the Révision surface (Lot C2).
//
// Parses the unified-diff text returned by `useGitDiff(path, "worktree")` and
// renders it monospace with old/new line numbers and +/- coloring. Kept
// intentionally minimal — only what's needed for a read-only view in this slice.
// Later slices (hunk actions, Cmd+click→line, hover comment) can layer on top
// without touching the parser logic.
//
// Skipped on purpose (out of scope C2.1):
//   - Syntax highlighting inside diff lines.
//   - Side-by-side vs. unified toggle.
//   - Per-hunk stage/revert controls.

import React, { useMemo, useState } from "react";

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type LineKind = "header" | "hunk" | "add" | "remove" | "context" | "meta" | "nonewline";

interface DiffLine {
  kind: LineKind;
  text: string;       // raw line text (without trailing \n)
  oldLine: number | null;
  newLine: number | null;
}

interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

interface ParsedDiff {
  preamble: string[];  // diff --git / index / --- / +++ lines
  hunks: DiffHunk[];
  isBinary: boolean;
}

// Regex for hunk header: @@ -a[,b] +c[,d] @@ optional text
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/;

// Lines that belong to the diff preamble (before the first hunk).
const PREAMBLE_RE = /^(diff |index |--- |[+]{3} |new file mode|deleted file mode|rename from|rename to|old mode|new mode|similarity index|copy from|copy to)/;

export function parseDiff(raw: string): ParsedDiff {
  const rawLines = raw.split("\n");
  // Drop a trailing empty string caused by a final newline.
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines.pop();
  }

  const preamble: string[] = [];
  const hunks: DiffHunk[] = [];
  let isBinary = false;
  let inPreamble = true;

  let oldLine = 0;
  let newLine = 0;
  let currentHunk: DiffHunk | null = null;

  for (const raw of rawLines) {
    // Binary diff sentinel.
    if (raw.startsWith("Binary files") && raw.includes("differ")) {
      isBinary = true;
      preamble.push(raw);
      continue;
    }

    // Hunk header.
    const hunkMatch = HUNK_RE.exec(raw);
    if (hunkMatch) {
      inPreamble = false;
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[3], 10);
      currentHunk = { header: raw, lines: [] };
      hunks.push(currentHunk);
      continue;
    }

    // Preamble lines (before the first hunk).
    if (inPreamble || PREAMBLE_RE.test(raw)) {
      preamble.push(raw);
      continue;
    }

    if (!currentHunk) {
      // Should not happen on a well-formed diff, but guard defensively.
      preamble.push(raw);
      continue;
    }

    // "\ No newline at end of file"
    if (raw === "\\ No newline at end of file") {
      currentHunk.lines.push({ kind: "nonewline", text: raw, oldLine: null, newLine: null });
      continue;
    }

    const ch = raw[0] ?? " ";
    if (ch === "+") {
      currentHunk.lines.push({ kind: "add", text: raw.slice(1), oldLine: null, newLine: newLine });
      newLine++;
    } else if (ch === "-") {
      currentHunk.lines.push({ kind: "remove", text: raw.slice(1), oldLine: oldLine, newLine: null });
      oldLine++;
    } else {
      // Context line (space) or unexpected.
      const text = ch === " " ? raw.slice(1) : raw;
      currentHunk.lines.push({ kind: ch === " " ? "context" : "meta", text, oldLine: oldLine, newLine: newLine });
      oldLine++;
      newLine++;
    }
  }

  return { preamble, hunks, isBinary };
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const LINE_NUM_W = 42; // px per line-number column

const kindStyle: Record<LineKind, React.CSSProperties> = {
  header:    { background: "transparent", color: "var(--on-surface-muted)" },
  hunk:      { background: "rgba(100,150,255,0.08)", color: "var(--primary)", fontWeight: 600 },
  add:       { background: "rgba(var(--success-rgb, 72,199,116), 0.12)", color: "var(--success)" },
  remove:    { background: "rgba(var(--danger-rgb, 255,82,82), 0.12)", color: "var(--danger)" },
  context:   { background: "transparent", color: "var(--on-surface-variant)" },
  meta:      { background: "transparent", color: "var(--on-surface-muted)" },
  nonewline: { background: "transparent", color: "var(--on-surface-muted)", fontStyle: "italic" },
};

function LineNum({ n }: { n: number | null }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: LINE_NUM_W,
        minWidth: LINE_NUM_W,
        textAlign: "right",
        paddingRight: 8,
        color: "var(--on-surface-muted)",
        userSelect: "none",
        flexShrink: 0,
      }}
    >
      {n !== null ? n : ""}
    </span>
  );
}

function HunkHeader({ text }: { text: string }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        padding: "2px 0",
        ...kindStyle.hunk,
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        whiteSpace: "pre",
      }}
    >
      <span style={{ width: LINE_NUM_W * 2 + 8, flexShrink: 0 }} />
      <span>{text}</span>
    </div>
  );
}

interface UnifiedDiffProps {
  /** Raw unified-diff text from `useGitDiff`. */
  text: string;
  /**
   * C2.2 — called when the user Ctrl/Cmd+clicks a diff line that has a
   * new-side line number (add or context lines). Receives the 1-based line
   * number in the new version of the file. Pure-removed lines (newLine === null)
   * are not jump targets.
   */
  onRevealLine?: (newLine: number) => void;
  /**
   * C2.4 — called when the user submits an inline note on a diff line.
   * Only fired for lines that have a new-side line number (add + context).
   * @param line     1-based new-file line number
   * @param snippet  trimmed line text (without diff +/- gutter marker)
   * @param note     user-typed note
   */
  onAddComment?: (line: number, snippet: string, note: string) => void;
}

// ---------------------------------------------------------------------------
// Inline comment input (tiny floating form per line)
// ---------------------------------------------------------------------------

interface InlineNoteInputProps {
  onSubmit: (note: string) => void;
  onCancel: () => void;
}

function InlineNoteInput({ onSubmit, onCancel }: InlineNoteInputProps): JSX.Element {
  const [note, setNote] = useState("");
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        background: "rgba(20,16,38,0.97)",
        border: "1px solid rgba(var(--primary-rgb,130,100,255),0.35)",
        borderRadius: 6,
        padding: "3px 6px",
        marginLeft: 8,
        flexShrink: 0,
        maxWidth: 320,
        boxShadow: "0 4px 16px -4px rgba(0,0,0,0.6)",
      }}
    >
      <input
        autoFocus
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (note.trim()) onSubmit(note.trim());
          }
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder="Note à l'agent… (↵ envoyer)"
        style={{
          background: "transparent",
          border: "none",
          outline: "none",
          color: "var(--on-surface)",
          fontFamily: "var(--font-mono)",
          fontSize: 10,
          width: 200,
          padding: "1px 2px",
        }}
      />
      <button
        type="button"
        disabled={!note.trim()}
        onClick={() => { if (note.trim()) onSubmit(note.trim()); }}
        style={{
          background: "rgba(var(--primary-rgb,130,100,255),0.25)",
          border: "1px solid rgba(var(--primary-rgb,130,100,255),0.4)",
          borderRadius: 4,
          color: "var(--primary)",
          cursor: note.trim() ? "pointer" : "default",
          fontSize: 9,
          padding: "1px 6px",
          lineHeight: "16px",
          opacity: note.trim() ? 1 : 0.4,
        }}
      >
        OK
      </button>
      <button
        type="button"
        onClick={onCancel}
        style={{
          background: "none",
          border: "none",
          cursor: "pointer",
          color: "var(--on-surface-muted)",
          fontSize: 11,
          lineHeight: 1,
          padding: "0 2px",
        }}
      >
        ×
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DiffLineRow — one line of the diff, with hover-visible comment affordance
// ---------------------------------------------------------------------------

interface DiffLineRowProps {
  line: DiffLine;
  isTarget: boolean;
  isCommentable: boolean;
  noteKey: string;
  openNoteKey: string | null;
  setOpenNoteKey: (k: string | null) => void;
  onRevealLine?: (n: number) => void;
  onAddComment?: (line: number, snippet: string, note: string) => void;
}

function DiffLineRow({
  line,
  isTarget,
  isCommentable,
  noteKey,
  openNoteKey,
  setOpenNoteKey,
  onRevealLine,
  onAddComment,
}: DiffLineRowProps): JSX.Element {
  const [hovered, setHovered] = useState(false);
  const noteOpen = openNoteKey === noteKey;

  return (
    <div
      onClick={isTarget ? (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          onRevealLine!(line.newLine!);
        }
      } : undefined}
      title={isTarget ? "Ctrl+clic → ouvrir dans l'éditeur à cette ligne" : undefined}
      onMouseEnter={isCommentable ? () => setHovered(true) : undefined}
      onMouseLeave={isCommentable ? () => setHovered(false) : undefined}
      style={{
        display: "flex",
        alignItems: "baseline",
        minHeight: 18,
        cursor: isTarget ? "pointer" : undefined,
        position: "relative",
        ...kindStyle[line.kind],
      }}
    >
      <LineNum n={line.oldLine} />
      <LineNum n={line.newLine} />
      {/* +/- gutter indicator */}
      <span
        style={{
          width: 14,
          minWidth: 14,
          textAlign: "center",
          userSelect: "none",
          flexShrink: 0,
          color: line.kind === "add" ? "var(--success)" : line.kind === "remove" ? "var(--danger)" : "transparent",
        }}
      >
        {line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}
      </span>
      <span
        style={{
          flex: 1,
          whiteSpace: "pre",
          paddingRight: 16,
          overflowX: "auto",
        }}
      >
        {line.text}
      </span>
      {/* C2.4 — comment affordance */}
      {isCommentable && (
        noteOpen ? (
          <InlineNoteInput
            onSubmit={(note) => {
              onAddComment!(line.newLine!, line.text.trim(), note);
              setOpenNoteKey(null);
              setHovered(false);
            }}
            onCancel={() => { setOpenNoteKey(null); setHovered(false); }}
          />
        ) : (
          <button
            type="button"
            title="Ajouter une note à l'agent pour cette ligne"
            onClick={(e) => {
              e.stopPropagation();
              setOpenNoteKey(noteKey);
            }}
            style={{
              flexShrink: 0,
              marginRight: 8,
              padding: "0 5px",
              height: 14,
              lineHeight: "13px",
              fontSize: 10,
              fontWeight: 700,
              borderRadius: 4,
              border: "1px solid rgba(var(--primary-rgb,130,100,255),0.4)",
              background: "rgba(var(--primary-rgb,130,100,255),0.18)",
              color: "var(--primary)",
              cursor: "pointer",
              // Shown only on row hover — avoids cluttering the diff view.
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? "auto" : "none",
              transition: "opacity 0.1s",
            }}
          >
            +
          </button>
        )
      )}
    </div>
  );
}

export function UnifiedDiff({ text, onRevealLine, onAddComment }: UnifiedDiffProps): JSX.Element {
  const parsed = useMemo(() => parseDiff(text), [text]);
  // C2.4 — track which line has an open note input (null = none open).
  // Key is `hunkIndex:lineIndex` — stable for the lifetime of this render.
  const [openNoteKey, setOpenNoteKey] = useState<string | null>(null);

  if (parsed.isBinary) {
    return (
      <div
        style={{
          padding: "16px 20px",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--on-surface-muted)",
          fontStyle: "italic",
        }}
      >
        {parsed.preamble[parsed.preamble.length - 1] ?? "Binary file changed"}
      </div>
    );
  }

  if (parsed.hunks.length === 0 && parsed.preamble.length === 0) {
    return (
      <div
        style={{
          padding: "16px 20px",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--on-surface-muted)",
          fontStyle: "italic",
        }}
      >
        (no textual diff)
      </div>
    );
  }

  return (
    <div
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        lineHeight: "18px",
        overflow: "auto",
        position: "absolute",
        inset: 0,
        padding: "8px 0",
      }}
    >
      {parsed.hunks.map((hunk, hi) => (
        <div key={hi} data-hunk={hi}>
          <HunkHeader text={hunk.header} />
          {hunk.lines.map((line, li) => {
            // C2.2 — a line is a jump target if it has a new-side number AND
            // onRevealLine is wired (cockpit context). Pure-removed lines
            // (newLine === null) have no position in the new file → skip.
            const isTarget = onRevealLine != null && line.newLine !== null;
            // C2.4 — a line is a comment target if onAddComment is wired AND
            // it has a new-side line number (add + context lines only).
            const isCommentable = onAddComment != null && line.newLine !== null;
            const noteKey = `${hi}:${li}`;
            return (
              <DiffLineRow
                key={li}
                line={line}
                isTarget={isTarget}
                isCommentable={isCommentable}
                noteKey={noteKey}
                openNoteKey={openNoteKey}
                setOpenNoteKey={setOpenNoteKey}
                onRevealLine={onRevealLine}
                onAddComment={onAddComment}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
