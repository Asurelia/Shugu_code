// Shugu Forge — DiffView: 2-pane side-by-side file comparison.
//
// Rendered by views-code.tsx when `compareFile` is set in ShellContext.
// Uses `MergeView` from @codemirror/merge (NOT `unifiedMergeView` — that is
// an Extension for a single editor; MergeView creates its own DOM).
//
// The view is destroyed and recreated whenever the file pair changes (both
// paths are stable React keys driving the useEffect deps).

import { useEffect, useRef } from "react";
import { MergeView } from "@codemirror/merge";
import type { Extension } from "@codemirror/state";
import { EditorView, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import { useFileContent } from "@/features/fs/queries";
import { useGitHead } from "@/features/git/queries";
import { langFromPath } from "@/lib/fs";
import { diag } from "@/lib/diag";
import { langExtensionFor } from "./languages";
import { veilHighlight, veilTheme } from "./theme";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface DiffViewProps {
  /** Workspace-relative path of the left (original / base) file. */
  left: string;
  /** Workspace-relative path of the right (modified) file. */
  right: string;
  /** Called when the user clicks the Close button. */
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Per-pane extension builder
// ---------------------------------------------------------------------------

/**
 * Builds the extension list for one DiffView pane. Each pane gets its own
 * language extension based on its file path (left and right may be different
 * langs). Uses the same Celestial Veil theme + highlight as the main editor
 * (Reviewer A/B LOT 3 MAJOR — defaultHighlightStyle was visually inconsistent
 * with the main editor view).
 */
function paneExtensions(path: string): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLine(),
    syntaxHighlighting(veilHighlight),
    veilTheme,
    langExtensionFor(langFromPath(path)),
    EditorView.lineWrapping,
    EditorView.editable.of(false),
  ];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DiffView({ left, right, onClose }: DiffViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const mergeViewRef = useRef<MergeView | null>(null);

  const leftContent = useFileContent(left);
  const rightContent = useFileContent(right);

  useEffect(() => {
    if (!containerRef.current) return;
    // Wait until both files are loaded.
    if (leftContent === null || rightContent === null) return;

    // Destroy previous MergeView if any (e.g. different file pair).
    mergeViewRef.current?.destroy();

    // Wrap construction in try/catch — malformed docs, theme conflicts, or
    // a transient @codemirror/merge bug could throw, and silent failure
    // (the loading spinner staying forever) is worse than a diag log.
    // Reviewer B LOT 3 MINOR finding.
    try {
      mergeViewRef.current = new MergeView({
        parent: containerRef.current,
        a: {
          doc: leftContent.text,
          extensions: paneExtensions(left),
        },
        b: {
          doc: rightContent.text,
          extensions: paneExtensions(right),
        },
        highlightChanges: true,
        gutter: true,
        // No revertControls — read-only compare, not a merge resolver.
      });
    } catch (err) {
      diag("diff-view", `MergeView construction failed for ${left} ↔ ${right}: ${String(err)}`);
    }

    return () => {
      mergeViewRef.current?.destroy();
      mergeViewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftContent?.text, rightContent?.text, left, right]);

  const isLoading = leftContent === null || rightContent === null;

  return (
    <div className="diff-view">
      <div className="diff-view__header">
        <div className="diff-view__header-left">
          <span className="diff-view__path">{left}</span>
          <span className="diff-view__separator">↔</span>
          <span className="diff-view__path">{right}</span>
        </div>
        <button
          className="diff-view__close"
          onClick={onClose}
          aria-label="Close compare view"
          title="Close (Esc)"
        >
          x
        </button>
      </div>

      {isLoading ? (
        <div className="diff-view__loading">
          <div className="ring" />
        </div>
      ) : (
        <div className="diff-view__container" ref={containerRef} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Git diff — working tree vs HEAD
// ---------------------------------------------------------------------------

/**
 * Read-only 2-pane git diff for a single workspace-relative `path`: its HEAD
 * (committed) content on the left, its working-tree content on the right.
 * Reuses the same MergeView + per-pane extensions as DiffView.
 *
 * Sources: useGitHead (HEAD, LF-normalized; null when untracked / no commits)
 * and useFileContent (working tree). An untracked file has no HEAD → the left
 * pane is empty and every line renders as an addition, which is correct.
 */
export function GitDiffView({ path, onClose }: { path: string; onClose: () => void }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const mergeViewRef = useRef<MergeView | null>(null);

  const working = useFileContent(path); // FileContent | null (null = loading)
  const head = useGitHead(path);        // string | null (null = untracked / loading)

  const ready = working !== null;
  const headText = head ?? "";
  const workText = working?.text ?? "";

  useEffect(() => {
    if (!containerRef.current || !ready) return;
    mergeViewRef.current?.destroy();
    try {
      mergeViewRef.current = new MergeView({
        parent: containerRef.current,
        a: { doc: headText, extensions: paneExtensions(path) }, // original = HEAD
        b: { doc: workText, extensions: paneExtensions(path) }, // modified = working tree
        highlightChanges: true,
        gutter: true,
      });
    } catch (err) {
      diag("diff-view", `git MergeView construction failed for ${path}: ${String(err)}`);
    }
    return () => {
      mergeViewRef.current?.destroy();
      mergeViewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headText, workText, path, ready]);

  return (
    <div className="diff-view">
      <div className="diff-view__header">
        <div className="diff-view__header-left">
          <span className="diff-view__path">{head === null ? "(nouveau)" : "HEAD"}</span>
          <span className="diff-view__separator">↔</span>
          <span className="diff-view__path">{path}</span>
        </div>
        <button
          className="diff-view__close"
          onClick={onClose}
          aria-label="Fermer le diff"
          title="Fermer (Esc)"
        >
          x
        </button>
      </div>

      {!ready ? (
        <div className="diff-view__loading">
          <div className="ring" />
        </div>
      ) : (
        <div className="diff-view__container" ref={containerRef} />
      )}
    </div>
  );
}
