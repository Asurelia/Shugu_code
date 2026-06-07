// src/features/cockpit/revealStore.ts
// Cockpit C2.2 — "saut diff → éditeur à une ligne précise".
//
// Tiny store (React Query idiom, same as editorSelectionStore / layoutStore)
// holding a pending reveal request: the line the user Ctrl/Cmd-clicked in the
// Révision diff. useRevealRunner (mounted in SurfaceHost) consumes and
// executes it once the target file's CodeMirror view is mounted + loaded.
//
// Design notes:
//   - Store idiom: queryClient.setQueryData (same as every other store in the
//     project — applyController, editorSelectionStore, layoutStore).
//   - Async timing: bounded-rAF poll (≤ MAX_WAIT_FRAMES ≈ 2 s at 60 fps),
//     cancelled on unmount. Modelled on useApplyRunner.
//   - Readiness gate combines TWO checks from the codebase's prior art:
//     (a) handle.getPath() === pending.path (FindPanel fix — avoids dispatching
//         on a stale view from the previous file during async remount).
//     (b) view.state.doc.toString() === fileContents[path]?.text (applyController
//         fix — avoids dispatching before the file content has loaded, which
//         would jump to an empty doc).
//   - Cancellation re-read inside the tick (getReveal() !== pending) handles a
//     second click overwriting the store mid-rAF.

import { useEffect, useRef, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import type { CodeMirrorEditorHandle } from "@/features/code/CodeMirrorEditor";
import { EditorView } from "@codemirror/view";
import type { FileContent } from "@/lib/types";

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface RevealRequest {
  /** Workspace-relative path (forward-slash). */
  path: string;
  /** 1-based line number in the NEW version of the file. */
  line: number;
}

const KEY = ["cockpit", "reveal"] as const;

/** Post a reveal request (or clear with null). */
export function requestReveal(req: RevealRequest | null): void {
  queryClient.setQueryData<RevealRequest | null>(KEY, req ?? null);
}

/** Imperative read (used inside the rAF tick). */
function getReveal(): RevealRequest | null {
  return queryClient.getQueryData<RevealRequest | null>(KEY) ?? null;
}

/** Reactive hook (for the runner's effect dep). */
export function useReveal(): RevealRequest | null {
  const { data = null } = useQuery<RevealRequest | null>({
    queryKey: KEY,
    queryFn: () => getReveal(),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

// ~2 s at 60 fps — covers openFile (disk read) + CodeMirror mount.
const MAX_WAIT_FRAMES = 120;

/**
 * Mount once in SurfaceHost (which has access to useShell()). Watches for
 * a pending RevealRequest, waits until the target file is active and its
 * CodeMirror view is mounted + loaded, then places the cursor at the
 * requested line and scrolls it into view.
 */
export function useRevealRunner(
  editorViewRef: RefObject<CodeMirrorEditorHandle> | undefined,
  activeFile: string | null,
  fileContents: Record<string, FileContent | undefined>,
): void {
  const pending = useReveal();
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!pending) return;
    // Wait until the target file is active (openFile + setActiveFile happened).
    if (pending.path !== activeFile) return;

    let frames = 0;

    const tick = () => {
      rafRef.current = null;
      // Guard: store could have been updated/cleared between frames.
      if (getReveal() !== pending) return;

      const handle = editorViewRef?.current ?? null;
      const view = handle?.getView() ?? null;
      const loaded = fileContents[pending.path];

      // Readiness gate (combines two prior-art checks):
      //   1. getPath() === pending.path — ensures this is the NEW view for the
      //      correct file, not a stale view from the previous file still alive
      //      during async remount (FindPanel fix).
      //   2. doc content === loaded text — ensures the view has received the
      //      file's content (not still an empty doc), matching applyController.
      const pathReady = view != null && handle?.getPath() === pending.path;
      const contentReady = loaded != null && view != null && view.state.doc.toString() === loaded.text;
      const ready = pathReady && contentReady;

      if (ready && view) {
        // Clamp line to valid range (1-based).
        const lineCount = view.state.doc.lines;
        const targetLine = Math.min(Math.max(1, pending.line), lineCount);
        const pos = view.state.doc.line(targetLine).from;

        view.dispatch({
          selection: { anchor: pos },
          effects: EditorView.scrollIntoView(pos, { y: "center" }),
        });
        view.focus();
        requestReveal(null);
        return;
      }

      if (frames++ < MAX_WAIT_FRAMES) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        console.warn(
          "[useRevealRunner] view for",
          pending.path,
          "never became ready — dropping reveal to line",
          pending.line,
        );
        requestReveal(null);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [pending, activeFile, editorViewRef, fileContents]);
}
