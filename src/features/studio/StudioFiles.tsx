// Shugu Forge — Design Studio · Files pane (Phase I + H).
//
// The "Design Files" tab of the right pane: the generated project's file tree
// (.shugu-forge/preview/), sourced from useScopedTree(PREVIEW_DIR) — reads ONLY
// that subtree (fs_read_dir_scoped, no 5000-entry cap), disk-backed and live
// (the Rust watcher invalidates it via fs://changed), so it stays correct even
// after an app reload AND on huge workspaces. Clicking a file opens it in
// Shugu's CodeMirror editor (parent wires onOpen → openFile + /code).
//
// Phase H — an export footer copies the disposable preview into a real, named,
// git-trackable folder in the workspace (studioExport.exportToWorkspace).

import { useMemo, useState } from "react";
import { Icon } from "@/components/components";
import { useScopedTree } from "@/features/fs/queries";
import type { FileNode } from "@/lib/types";
import { exportToWorkspace, flattenLeaves, slugifyName } from "./studioExport";

const PREVIEW_DIR = ".shugu-forge/preview";

function FileRows({
  nodes,
  depth,
  onOpen,
}: {
  nodes: FileNode[];
  depth: number;
  onOpen: (path: string) => void;
}) {
  const sorted = [...nodes].sort((a, b) => {
    const ad = a.children ? 0 : 1;
    const bd = b.children ? 0 : 1;
    return ad - bd || a.name.localeCompare(b.name);
  });
  return (
    <>
      {sorted.map((n) =>
        n.children ? (
          <div key={n.path}>
            <div className="studio-file-row studio-file-dir" style={{ paddingLeft: 8 + depth * 12 }}>
              <Icon name="folder" size={12} /> {n.name}
            </div>
            <FileRows nodes={n.children} depth={depth + 1} onOpen={onOpen} />
          </div>
        ) : (
          <button
            key={n.path}
            className="studio-file-row"
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => onOpen(n.path)}
            title={`Ouvrir ${n.path} dans l'éditeur`}
          >
            <Icon name="file" size={12} /> {n.name}
          </button>
        ),
      )}
    </>
  );
}

type ExportStatus =
  | { phase: "idle" }
  | { phase: "busy" }
  | { phase: "done"; count: number; dir: string }
  | { phase: "error"; msg: string };

export function StudioFiles({
  onOpen,
  defaultName = "design-export",
}: {
  onOpen: (path: string) => void;
  defaultName?: string;
}) {
  // Read ONLY the preview subtree (recursive, no cap) — `useScopedTree`
  // returns the children of `.shugu-forge/preview/` directly, so no whole-tree
  // walk and no findByPath. flattenLeaves still recurses for the export.
  const { data: files = [] } = useScopedTree(PREVIEW_DIR);
  const leaves = useMemo(() => flattenLeaves(files), [files]);

  const [name, setName] = useState(defaultName);
  const [status, setStatus] = useState<ExportStatus>({ phase: "idle" });
  const busy = status.phase === "busy";

  const doExport = async () => {
    if (busy || leaves.length === 0) return;
    const dir = slugifyName(name);
    setStatus({ phase: "busy" });
    try {
      const count = await exportToWorkspace(leaves, dir);
      setStatus({ phase: "done", count, dir });
    } catch (err) {
      setStatus({ phase: "error", msg: String(err) });
    }
  };

  return (
    <div className="studio-files">
      <div className="studio-files-head">
        <Icon name="folder" size={13} /> <code>{PREVIEW_DIR}/</code>
      </div>

      {files.length === 0 ? (
        <div className="studio-files-empty">
          <Icon name="folder" size={24} />
          <div>Aucun fichier généré pour l'instant.</div>
        </div>
      ) : (
        <>
          <div className="studio-files-list scroll">
            <FileRows nodes={files} depth={0} onOpen={onOpen} />
          </div>

          <div className="studio-export">
            <span className="studio-disco-label">Exporter vers le workspace</span>
            <div className="studio-export-row">
              <input
                className="studio-disco-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="nom-du-dossier"
                disabled={busy}
                aria-label="Nom du dossier d'export"
              />
              <button className="lgb lgb-primary" onClick={doExport} disabled={busy || leaves.length === 0}>
                {busy ? <span className="studio-ring" /> : <Icon name="download" size={13} />} Exporter
              </button>
            </div>
            {status.phase === "done" && (
              <div className="studio-export-done">
                <Icon name="check" size={12} /> {status.count} fichier{status.count > 1 ? "s" : ""} →{" "}
                <code>{status.dir}/</code>
                <button className="lgb lgb-sm" onClick={() => onOpen(`${status.dir}/index.html`)}>
                  Ouvrir
                </button>
              </div>
            )}
            {status.phase === "error" && (
              <div className="studio-turn-err">
                <Icon name="x" size={12} /> Échec de l'export : {status.msg}
              </div>
            )}
            <p className="studio-hint studio-hint-sm">
              Copie le projet hors de <code>.shugu-forge/</code> (jetable) vers un dossier réel,
              suivi par git et éditable.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
