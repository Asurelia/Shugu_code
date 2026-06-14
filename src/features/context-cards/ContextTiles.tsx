// src/features/context-cards/ContextTiles.tsx
// Grille de TUILES redimensionnables (façon Claude Code) pour le panneau droit.
// Modèle : la liste ordonnée des tuiles ouvertes est découpée en COLONNES de 2
// (chunk de 2) ; colonnes côte à côte (PanelGroup horizontal), tuiles empilées
// dans chaque colonne (PanelGroup vertical). Chaque séparation est une
// PanelResizeHandle → tout est redimensionnable au drag. Ouvrir Aperçu, Révision,
// Terminal, Fichiers, Tâches, Plan → 3 colonnes × 2 lignes (cf. capture user).
import { Fragment } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Icon, SideFiles } from "@/components/components";
import { DockTerminal } from "@/features/dock/Dock";
import { ContextCard, CTX_TABS, type CtxTabId, type EditorBridge } from "./cards";
import { useOpenTiles, closeTile, type TileId } from "./tilesStore";

interface TileMeta { label: string; icon: string }
const EXTRA_META: Record<"files" | "terminal", TileMeta> = {
  files: { label: "Fichiers", icon: "folderTree" },
  terminal: { label: "Terminal", icon: "term" },
};
function tileMeta(id: TileId): TileMeta {
  const card = CTX_TABS.find((t) => t.id === (id as CtxTabId));
  if (card) return { label: card.label, icon: card.icon };
  return EXTRA_META[id as "files" | "terminal"];
}

function chunk2<T>(arr: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += 2) out.push(arr.slice(i, i + 2));
  return out;
}

export function ContextTiles({
  convId,
  onOpenFile,
  editor = {},
}: {
  convId: string;
  onOpenFile: (path: string) => void;
  editor?: EditorBridge;
}) {
  const tiles = useOpenTiles();

  if (tiles.length === 0) {
    return (
      <div className="ctx-tiles-empty">
        <Icon name="sparkle" size={22} />
        <p>Ouvre un panneau depuis le bouton « Contexte ». Tu peux en empiler plusieurs — ils se tuilent ici et se redimensionnent au glisser.</p>
      </div>
    );
  }

  const cols = chunk2(tiles);

  return (
    <PanelGroup direction="horizontal" className="ctx-tiles">
      {cols.map((col, ci) => (
        <Fragment key={"col-" + col.join("-")}>
          {ci > 0 && <PanelResizeHandle className="dock-rrp-handle v" />}
          <Panel id={"ctxcol-" + ci} order={ci} minSize={12}>
            <PanelGroup direction="vertical" className="ctx-tiles-col">
              {col.map((tid, ri) => (
                <Fragment key={tid}>
                  {ri > 0 && <PanelResizeHandle className="dock-rrp-handle h" />}
                  <Panel id={"ctxtile-" + tid} order={ri} minSize={12}>
                    <Tile id={tid} convId={convId} onOpenFile={onOpenFile} editor={editor} />
                  </Panel>
                </Fragment>
              ))}
            </PanelGroup>
          </Panel>
        </Fragment>
      ))}
    </PanelGroup>
  );
}

function Tile({
  id,
  convId,
  onOpenFile,
  editor,
}: {
  id: TileId;
  convId: string;
  onOpenFile: (path: string) => void;
  editor: EditorBridge;
}) {
  const meta = tileMeta(id);
  return (
    <div className="ctx-tile">
      <div className="ctx-tile-head">
        <span className="ctx-tile-title">
          <Icon name={meta.icon} size={12} /> {meta.label}
        </span>
        <button className="ctx-tile-close" onClick={() => closeTile(id)} title="Fermer la tuile">
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className={"ctx-tile-body" + (id === "terminal" || id === "files" ? " flush" : "")}>
        {id === "terminal" ? (
          <DockTerminal tabId="ctx-tile-terminal" name="Terminal" />
        ) : id === "files" ? (
          <div className="ctx-tile-files">
            <SideFiles active={editor.activeFile ?? null} onPick={(p: string) => onOpenFile(p)} />
          </div>
        ) : (
          <ContextCard tab={id} convId={convId} onOpenFile={onOpenFile} editor={editor} />
        )}
      </div>
    </div>
  );
}
