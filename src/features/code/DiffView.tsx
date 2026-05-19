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
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { useFileContent } from "@/features/fs/queries";

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
// Component
// ---------------------------------------------------------------------------

export function DiffView({ left, right, onClose }: DiffViewProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const mergeViewRef = useRef<MergeView | null>(null);

  const leftContent = useFileContent(left);
  const rightContent = useFileContent(right);

  // Build a minimal extension list for the read-only side panels.
  const baseExtensions = [
    lineNumbers(),
    highlightActiveLine(),
    syntaxHighlighting(defaultHighlightStyle),
    EditorView.lineWrapping,
    EditorView.editable.of(false),
  ];

  useEffect(() => {
    if (!containerRef.current) return;
    // Wait until both files are loaded.
    if (leftContent === null || rightContent === null) return;

    // Destroy previous MergeView if any (e.g. different file pair).
    mergeViewRef.current?.destroy();

    mergeViewRef.current = new MergeView({
      parent: containerRef.current,
      a: {
        doc: leftContent.text,
        extensions: baseExtensions,
      },
      b: {
        doc: rightContent.text,
        extensions: baseExtensions,
      },
      // highlight changed character ranges within modified lines.
      highlightChanges: true,
      // Show a unified diff gutter.
      gutter: true,
      // Do not show revert controls — this is a read-only compare.
      // (MergeConfig uses `revertControls`, not `mergeControls`)
      // Omitting revertControls defaults to undefined = no revert buttons.
    });

    return () => {
      mergeViewRef.current?.destroy();
      mergeViewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftContent?.text, rightContent?.text]);

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
