// Shugu Forge — FloatShell (generic floating coque).
//
// Phase 5 outcome: the mascot window can render ANY anchor + ANY panel inside
// the same drag/snap/edge machinery that used to be hard-wired to the chat.
//
//     <FloatShell anchor={<ChibiWithMood/>}>
//       <ChatPanel />
//     </FloatShell>
//
// Tomorrow:
//
//     <FloatShell anchor={<TaskMascot/>}>
//       <TaskListPanel />
//     </FloatShell>
//
// The shell owns: pos, edge, side, dragging, mode. It publishes them via
// `useFloatShell()` so subcomponents that LIVE INSIDE the shell can read
// shell state without prop drilling. It does NOT own anything chat- or
// content-specific.
//
// The avatar button click composes two behaviors:
//   1. If the anchor child stopped propagation in a capture-phase handler
//      (e.g. ChibiWithMood intercepts alt+click for cycleMood), this handler
//      never fires — the anchor handled it.
//   2. Otherwise: if edge-tucked → clearEdge + set compact; else toggle
//      closed/compact.
// Double-click toggles compact <-> full.

import { createContext, useContext, type ReactNode } from "react";
import {
  useFloatPosition,
  type FloatEdge,
  type FloatSide,
} from "@/features/floating/useFloatPosition";
import { useFloatMode, type FloatMode } from "@/features/floating/useFloatMode";

export interface FloatShellContextValue {
  mode: FloatMode;
  setMode: (m: FloatMode | ((p: FloatMode) => FloatMode)) => void;
  edge: FloatEdge;
  side: FloatSide;
  dragging: boolean;
}

const FloatShellContext = createContext<FloatShellContextValue | null>(null);

export function useFloatShell(): FloatShellContextValue {
  const v = useContext(FloatShellContext);
  if (!v) throw new Error("useFloatShell must be used inside <FloatShell>");
  return v;
}

export interface FloatShellProps {
  /** Content rendered inside the chibi cluster's avatar button (e.g. <ChibiWithMood/>). */
  anchor: ReactNode;
  /** Content rendered inside the float-body slot (e.g. <ChatPanel/>). */
  children: ReactNode;
  // Host coupling — passed straight through to useFloatPosition. See the
  // hook docs for the exact contract; these names match what mascot.tsx
  // already uses on FloatChat.
  disableInternalDrag?: boolean;
  forceSide?: "left" | "right";
  freezePos?: boolean;
  forceEdge?: FloatEdge | undefined;
}

export function FloatShell({
  anchor,
  children,
  disableInternalDrag,
  forceSide,
  freezePos,
  forceEdge,
}: FloatShellProps) {
  const {
    pos,
    side,
    edge,
    dragging,
    movedRef,
    onAvatarMouseDown,
    onContextMenu,
    clearEdge,
  } = useFloatPosition({ disableInternalDrag, forceSide, freezePos, forceEdge });

  const { mode, setMode, toggleClosed, toggleFull } = useFloatMode("compact");

  // Click / double-click behavior preserved 1:1 from the original FloatChat:
  // no implicit bumpInteract() here. Idle clock is bumped explicitly by the
  // panels on their own interactions (chat send / loadConvo / newConvo) and
  // by ChibiWithMood's mood-cycle path.
  const onAvatarClick = () => {
    if (movedRef.current) return;
    if (edge) {
      clearEdge();
      if (mode === "closed") setMode("compact");
      return;
    }
    toggleClosed();
  };

  const onAvatarDouble = () => {
    toggleFull();
  };

  const shellClass = [
    "float-shell",
    "side-" + side,
    mode === "closed" ? "closed" : "",
    mode === "compact" ? "compact" : "",
    mode === "full" ? "full" : "",
    edge ? "edge-hidden edge-hidden-" + edge : "",
    dragging ? "dragging" : "",
  ].filter(Boolean).join(" ");

  const ctx: FloatShellContextValue = { mode, setMode, edge, side, dragging };

  return (
    <FloatShellContext.Provider value={ctx}>
      <div className={shellClass} style={{ left: pos.x, top: pos.y }}>
        <div className="float-cluster">
          {/* Visual layer — pointer-events disabled so clicks pass through to
              the button below. The orbit/flip chain carries all animations and
              edge-transform rules; keeping them here means existing CSS works
              without changes. */}
          <div className="float-avatar-visual" aria-hidden="true">
            <span className="float-avatar-orbit">
              <span className="float-avatar-flip">
                {anchor}
              </span>
            </span>
            <span className="float-avatar-glow"></span>
          </div>
          {/* Interactive layer — absolutely positioned over the visual layer,
              clipped to a circle so the transparent halo around the chibi PNG
              does NOT capture clicks or drag events. clip-path makes the area
              outside the circle fully uninteractive (pointer-events: none
              would not clip hit-testing alone without the path). */}
          <button
            className="float-avatar-btn"
            aria-label={edge
              ? "Ramener la mascotte"
              : (mode === "closed" ? "Ouvrir" : "Fermer")}
            onMouseDown={onAvatarMouseDown}
            onClick={onAvatarClick}
            onDoubleClick={onAvatarDouble}
            onContextMenu={onContextMenu}
            title={edge
              ? "Cliquer pour ramener"
              : (mode === "closed"
                ? "Cliquer pour ouvrir · drag · alt+clic pour changer d'humeur"
                : "Cliquer pour fermer · double pour étendre · drag pour déplacer · alt+clic pour humeur")}
          />
          {edge && <span className="float-edge-tip">Click to bring back</span>}
        </div>
        <div className="float-body">
          {children}
        </div>
      </div>
    </FloatShellContext.Provider>
  );
}
