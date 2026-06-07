// src/features/cockpit/SurfaceHost.tsx
// Hosts the right-panel surfaces with a keep-warm policy: each surface is
// mounted on first activation and then kept mounted (visibility toggled),
// never unmounted while the cockpit lives. Keeping CodeView mounted is what
// keeps editorViewRef alive outside /code.
import { useRef } from "react";
import type { ReactNode } from "react";
import { useShell } from "@/routes/shell-context";
import { CodeView } from "@/features/code/views-code";
import { ReviewSurface } from "./ReviewSurface";
import { SURFACE_META } from "./surfaces";
import { setActiveSurface } from "./layoutStore";
import { useRevealRunner } from "./revealStore";
import { DockTerminal } from "@/features/dock/Dock";
import { SideFiles } from "@/components/components";
import { BrowserSurface } from "./BrowserSurface";
import type { SurfaceId } from "./layout";

function SurfaceFill({ visible, children }: { visible: boolean; children: ReactNode }) {
  return (
    <div style={{ position: "absolute", inset: 0, display: visible ? "block" : "none" }}>
      {children}
    </div>
  );
}

export function SurfaceHost({ active }: { active: SurfaceId }) {
  const shell = useShell();
  // C2.2 — run the reveal-runner: waits for the target file's CodeMirror view
  // to be mounted + loaded, then jumps the cursor to the requested line.
  useRevealRunner(shell.editorViewRef, shell.activeFile, shell.fileContents);
  // Track which surfaces have been opened at least once (keep-warm set).
  const opened = useRef<Set<SurfaceId>>(new Set());
  opened.current.add(active);

  const has = (id: SurfaceId) => opened.current.has(id);

  return (
    <div style={{ position: "relative", flex: 1, minHeight: 0, background: "var(--surface-container-low, #12121e)" }}>
      {has("editor") && (
        <SurfaceFill visible={active === "editor"}>
          <CodeView
            activeFile={shell.activeFile}
            openFiles={shell.openFiles}
            setOpenFiles={shell.setOpenFiles}
            setActiveFile={shell.setActiveFile}
            fileContents={shell.fileContents}
            setFileContents={shell.setFileContents}
            editorViewRef={shell.editorViewRef}
            embedded
          />
        </SurfaceFill>
      )}
      {has("review") && (
        <SurfaceFill visible={active === "review"}>
          <ReviewSurface />
        </SurfaceFill>
      )}
      {/* Terminal surface — DockTerminal is keep-warm: PTY spawns on first reveal,
          survives hide/show cycles (display:none guard inside DockTerminal). */}
      {has("terminal") && (
        <SurfaceFill visible={active === "terminal"}>
          <DockTerminal tabId="cockpit-terminal-1" name="Terminal" />
        </SurfaceFill>
      )}
      {/* Files surface — SideFiles tree browser; picking a file opens it in the
          editor and switches the active surface to "editor". */}
      {has("files") && (
        <SurfaceFill visible={active === "files"}>
          <div style={{ height: "100%", overflowY: "auto" }}>
            <SideFiles
              active={shell.activeFile}
              onPick={(p: string) => {
                void shell.openFile(p);
                setActiveSurface("editor");
              }}
            />
          </div>
        </SurfaceFill>
      )}
      {/* Browser surface — minimal URL bar + iframe for localhost / preview URLs. */}
      {has("browser") && (
        <SurfaceFill visible={active === "browser"}>
          <BrowserSurface />
        </SurfaceFill>
      )}
      {/* Fallback for any future comingSoon surface. */}
      {SURFACE_META[active].comingSoon && (
        <SurfaceFill visible>
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--on-surface-muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
            }}
          >
            {SURFACE_META[active].label} — bientôt.
          </div>
        </SurfaceFill>
      )}
    </div>
  );
}
