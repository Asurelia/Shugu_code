// Shugu Forge — ConflictResolver (LOT 3 git-ui).
//
// VSCode-inspired inline conflict resolution. Parses the active file
// buffer for `<<<<<<<`, `=======`, `>>>>>>>` markers and renders a list
// of conflict blocks with action buttons (Accept Current / Accept
// Incoming / Accept Both / Compare). When all blocks are resolved, the
// "Mark resolved" button stages the file via `useStageFiles`.
//
// This component does NOT modify the live CodeMirror buffer — it works
// off `useShell().fileContents[activeFile].text`, parses conflicts, and
// writes resolutions back via `setFileContents` (the editor remounts on
// the new text via its `path` key in views-code.tsx).
//
// Pure-function `parseConflicts` is exported for vitest coverage.

import { useMemo } from "react";
import { useShell } from "@/routes/shell-context";
import { useStageFiles } from "@/features/git/mutations";

export interface ConflictBlock {
  /** Line index (0-based) of the `<<<<<<<` marker line. */
  startLine: number;
  /** Line index (0-based) of the `=======` separator line. */
  separatorLine: number;
  /** Line index (0-based) of the `>>>>>>>` marker line. */
  endLine: number;
  /** Body of the "ours" side (between `<<<<<<<` and `=======`). */
  current: string;
  /** Body of the "theirs" side (between `=======` and `>>>>>>>`). */
  incoming: string;
}

export function parseConflicts(text: string): ConflictBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: ConflictBlock[] = [];
  let start = -1;
  let sep = -1;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("<<<<<<<")) {
      start = i;
      sep = -1;
    } else if (l.startsWith("=======") && start !== -1) {
      sep = i;
    } else if (l.startsWith(">>>>>>>") && start !== -1 && sep !== -1) {
      blocks.push({
        startLine: start,
        separatorLine: sep,
        endLine: i,
        current: lines.slice(start + 1, sep).join("\n"),
        incoming: lines.slice(sep + 1, i).join("\n"),
      });
      start = -1;
      sep = -1;
    }
  }
  return blocks;
}

/** Returns a new text with the given conflict block replaced by `replacement`. */
export function applyResolution(
  text: string,
  block: ConflictBlock,
  replacement: string,
): string {
  const lines = text.split(/\r?\n/);
  const before = lines.slice(0, block.startLine);
  const after = lines.slice(block.endLine + 1);
  const repl = replacement.length > 0 ? replacement.split(/\r?\n/) : [];
  return [...before, ...repl, ...after].join("\n");
}

export function ConflictResolver(): JSX.Element | null {
  const { activeFile, fileContents, setFileContents } = useShell();
  const stage = useStageFiles();

  const text = activeFile ? (fileContents[activeFile]?.text as string | undefined) : undefined;
  const conflicts = useMemo<ConflictBlock[]>(
    () => (text ? parseConflicts(text) : []),
    [text],
  );

  if (!activeFile || !text || conflicts.length === 0) return null;

  const resolve = (block: ConflictBlock, replacement: string) => {
    if (!activeFile) return;
    const next = applyResolution(text, block, replacement);
    setFileContents((c: Record<string, { lang: string; text: string; dirty?: boolean }>) => ({
      ...c,
      [activeFile]: { ...c[activeFile], text: next, dirty: true },
    }));
  };

  const compare = (block: ConflictBlock) => {
    // Lightweight inline compare : alert with the two sides. The full
    // 2-pane MergeView (DiffView) is reserved for whole-file compare
    // (already wired in views-code via ShellContext.compareFile). We
    // could open a transient temp pair here in a follow-up.
    console.info("[ConflictResolver] compare", { block });
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: 8,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: "var(--warn)",
          fontFamily: "var(--font-mono)",
          padding: "4px 8px",
        }}
      >
        {conflicts.length} conflict{conflicts.length !== 1 ? "s" : ""} in {activeFile}
      </div>
      {conflicts.map((c, i) => (
        <div
          key={`${c.startLine}-${c.endLine}`}
          style={{
            border: "1px solid rgba(255,207,107,0.28)",
            borderRadius: 8,
            padding: 8,
            background: "rgba(255,207,107,0.05)",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 10,
              color: "var(--on-surface-muted)",
            }}
          >
            #{i + 1} · L{c.startLine + 1}–L{c.endLine + 1}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            <button
              className="lgb lgb-sm"
              onClick={() => resolve(c, c.current)}
              title="Accept Current Change (ours)"
            >
              Accept Current
            </button>
            <button
              className="lgb lgb-sm"
              onClick={() => resolve(c, c.incoming)}
              title="Accept Incoming Change (theirs)"
            >
              Accept Incoming
            </button>
            <button
              className="lgb lgb-sm"
              onClick={() => resolve(c, `${c.current}\n${c.incoming}`)}
              title="Keep both sides"
            >
              Accept Both
            </button>
            <button className="lgb lgb-sm" onClick={() => compare(c)} title="Side-by-side compare">
              Compare
            </button>
          </div>
        </div>
      ))}
      <button
        className="lgb lgb-sm lgb-primary"
        disabled={conflicts.length > 0 || stage.isPending}
        onClick={() => {
          if (!activeFile) return;
          stage.mutate([activeFile]);
        }}
        title="Stage the resolved file"
      >
        Mark resolved
      </button>
    </div>
  );
}
