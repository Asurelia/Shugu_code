// Shugu Forge — infinite canvas surface (pan / zoom / node chrome).
// Live frames reuse ProjectPreview (embedded). Exploration frames use srcDoc.
// Brand node is a compact board card — edits live in the dock inspector.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { Icon } from "@/components/components";
import { ProjectPreview } from "../ProjectPreview";
import type { SelectedElement } from "../studioChat";
import { useStudioBrandBoard } from "../brandBoard";
import {
  bringToFront,
  moveNode,
  selectNode,
  zoomAt,
  type CanvasNode,
  type StudioCanvasDoc,
} from "./studioCanvasDoc";
import { setStudioCanvasDoc } from "./studioCanvasStore";
import { isWorkspaceHtmlRoute, workspacePreviewPath } from "./workspaceUiAtlas";
import { LazyFrame } from "./LazyFrame";

type Drag =
  | { kind: "pan"; px: number; py: number; camX: number; camY: number }
  | { kind: "node"; id: string; px: number; py: number; ox: number; oy: number };

export function StudioCanvas({
  doc,
  reloadKey,
  /** Optional localhost URL if a dev server is already up (never required). */
  liveUrl,
  hasAtlas,
  selecting,
  onSelectElement,
  onSelectingChange,
  onBakeTokens,
}: {
  doc: StudioCanvasDoc;
  reloadKey: number;
  liveUrl: string | null;
  /** True when workspace scan found pages/components to show. */
  hasAtlas: boolean;
  selecting: boolean;
  onSelectElement?: (el: SelectedElement) => void;
  onSelectingChange?: (on: boolean) => void;
  onBakeTokens?: (overrides: Record<string, string>) => void;
}) {
  const brand = useStudioBrandBoard();
  const stageRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [spacePan, setSpacePan] = useState(false);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        setSpacePan(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpacePan(false);
    };
    window.addEventListener("keydown", down, { passive: false });
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const onWheel = useCallback(
    (e: ReactWheelEvent) => {
      e.preventDefault();
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const factor = e.deltaY > 0 ? 0.92 : 1.08;
      setStudioCanvasDoc(zoomAt(doc, doc.camera.zoom * factor, sx, sy));
    },
    [doc],
  );

  const onPointerDownStage = (e: ReactPointerEvent) => {
    const isPan = e.button === 1 || spacePan || (e.button === 0 && e.target === e.currentTarget);
    if (!isPan) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ kind: "pan", px: e.clientX, py: e.clientY, camX: doc.camera.x, camY: doc.camera.y });
    setStudioCanvasDoc(selectNode(doc, null));
  };

  const onPointerDownNode = (e: ReactPointerEvent, node: CanvasNode) => {
    if (e.button !== 0 || spacePan) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    let next = selectNode(doc, node.id);
    next = bringToFront(next, node.id);
    setStudioCanvasDoc(next);
    setDrag({ kind: "node", id: node.id, px: e.clientX, py: e.clientY, ox: node.x, oy: node.y });
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    if (!drag) return;
    if (drag.kind === "pan") {
      setStudioCanvasDoc({
        ...doc,
        camera: {
          ...doc.camera,
          x: drag.camX + (e.clientX - drag.px),
          y: drag.camY + (e.clientY - drag.py),
        },
      });
      return;
    }
    const z = doc.camera.zoom || 1;
    setStudioCanvasDoc(
      moveNode(doc, drag.id, drag.ox + (e.clientX - drag.px) / z, drag.oy + (e.clientY - drag.py) / z),
    );
  };

  const onPointerUp = () => setDrag(null);
  const sorted = [...doc.nodes].sort((a, b) => a.zIndex - b.zIndex);

  return (
    <div
      ref={stageRef}
      className={"studio-canvas" + (drag?.kind === "pan" || spacePan ? " is-panning" : "")}
      onWheel={onWheel}
      onPointerDown={onPointerDownStage}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        className="studio-canvas-world"
        style={{
          transform: `translate(${doc.camera.x}px, ${doc.camera.y}px) scale(${doc.camera.zoom})`,
        }}
      >
        {sorted.map((node) => {
          const selected = doc.selectedId === node.id;
          return (
            <div
              key={node.id}
              className={"studio-cnode" + (selected ? " is-selected" : "") + ` is-${node.kind}`}
              style={{
                left: node.x,
                top: node.y,
                width: node.width,
                height: node.height,
                zIndex: node.zIndex,
              }}
            >
              <div className="studio-cnode-hd" onPointerDown={(e) => onPointerDownNode(e, node)}>
                <Icon
                  name={
                    node.kind === "brand"
                      ? "palette"
                      : node.kind === "live"
                        ? "image"
                        : node.kind === "component"
                          ? "gallery"
                          : "sparkle"
                  }
                  size={12}
                />
                <span>{node.name}</span>
                {node.kind === "live" && (
                  <span className="studio-cnode-tag">
                    {liveUrl && node.id === "live-home" ? "live" : node.html ? "extrait" : "page"}
                  </span>
                )}
                {node.kind === "component" && <span className="studio-cnode-tag is-comp">composant</span>}
              </div>
              <div
                className="studio-cnode-body"
                onPointerDown={(e) => {
                  // Select without starting a drag when interacting with preview.
                  if (e.button !== 0 || spacePan) return;
                  if (!selected) {
                    e.stopPropagation();
                    let next = selectNode(doc, node.id);
                    next = bringToFront(next, node.id);
                    setStudioCanvasDoc(next);
                  }
                }}
              >
                {node.kind === "live" && (
                  <LazyFrame active={selected} title={node.name} placeholder={node.name}>
                    {(() => {
                      if (liveUrl && node.id === "live-home" && !node.html && !isWorkspaceHtmlRoute(node.route)) {
                        return (
                          <ProjectPreview
                            embedded
                            externalUrl={liveUrl}
                            reloadKey={reloadKey}
                            onSelectElement={onSelectElement}
                            selecting={selected ? selecting : false}
                            onSelectingChange={onSelectingChange}
                            onBakeTokens={onBakeTokens}
                          />
                        );
                      }
                      if (node.html) {
                        return (
                          <iframe
                            className="studio-cnode-iframe"
                            title={node.name}
                            sandbox="allow-scripts"
                            srcDoc={node.html}
                          />
                        );
                      }
                      if (isWorkspaceHtmlRoute(node.route)) {
                        return (
                          <ProjectPreview
                            embedded
                            route={workspacePreviewPath(node.route!)}
                            reloadKey={reloadKey}
                            onSelectElement={onSelectElement}
                            selecting={selected ? selecting : false}
                            onSelectingChange={onSelectingChange}
                            onBakeTokens={onBakeTokens}
                          />
                        );
                      }
                      if (hasAtlas) {
                        return (
                          <div className="studio-cnode-empty">
                            <Icon name="image" size={22} />
                            <strong>{node.name}</strong>
                            <span>Page du projet — détails dans la bibliothèque.</span>
                          </div>
                        );
                      }
                      return (
                        <div className="studio-cnode-empty">
                          <Icon name="image" size={22} />
                          <strong>Aucune UI détectée</strong>
                          <span>Ouvre un projet avec HTML, CSS ou composants.</span>
                        </div>
                      );
                    })()}
                  </LazyFrame>
                )}
                {node.kind === "component" &&
                  (node.html ? (
                    <LazyFrame active={selected} title={node.name} placeholder={node.name}>
                      <iframe
                        className="studio-cnode-iframe"
                        title={node.name}
                        sandbox="allow-scripts"
                        srcDoc={node.html}
                      />
                    </LazyFrame>
                  ) : (
                    <div className="studio-cnode-empty">
                      <span>Composant vide.</span>
                    </div>
                  ))}
                {node.kind === "exploration" &&
                  (node.html ? (
                    <LazyFrame active={selected} title={node.name} placeholder={node.name}>
                      <iframe
                        className="studio-cnode-iframe"
                        title={node.name}
                        sandbox="allow-scripts"
                        srcDoc={node.html}
                      />
                    </LazyFrame>
                  ) : (
                    <div className="studio-cnode-empty">
                      <span>Variante vide — le modèle peut y déposer une exploration.</span>
                    </div>
                  ))}
                {node.kind === "brand" && (
                  <div className="studio-cnode-brand">
                    <div className="studio-cnode-brand-row">
                      <b>Audience</b>
                      <span>{brand.audience.trim() || "—"}</span>
                    </div>
                    <div className="studio-cnode-brand-row">
                      <b>Voix</b>
                      <span>{brand.voice.trim() || "—"}</span>
                    </div>
                    <div className="studio-cnode-brand-row">
                      <b>Notes</b>
                      <span>{brand.notes.trim() || "—"}</span>
                    </div>
                    <div className="studio-cnode-brand-meta">
                      {brand.pinnedAssetIds.length} réf. image · clic → inspector
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="studio-canvas-hint">
        molette = zoom · espace / milieu = pan · glisser l’en-tête = déplacer
      </div>
    </div>
  );
}
