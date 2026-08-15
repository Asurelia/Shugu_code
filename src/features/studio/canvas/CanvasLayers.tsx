import { useMemo, useState } from "react";
import { Icon } from "@/components/components";
import { selectNode, type CanvasNode, type StudioCanvasDoc } from "./studioCanvasDoc";
import { setStudioCanvasDoc } from "./studioCanvasStore";

type FolderId = "pages" | "components" | "icons" | "explorations" | "brand";

const FOLDERS: { id: FolderId; label: string; match: (n: CanvasNode) => boolean }[] = [
  { id: "pages", label: "Pages", match: (n) => n.kind === "live" },
  {
    id: "components",
    label: "Composants",
    match: (n) => n.kind === "component" && n.id !== "comp-icons-sheet" && !n.id.startsWith("comp-icon-") && !n.id.startsWith("comp-svg-"),
  },
  {
    id: "icons",
    label: "Icônes",
    match: (n) =>
      n.kind === "component" &&
      (n.id === "comp-icons-sheet" || n.id.startsWith("comp-icon-") || n.id.startsWith("comp-svg-")),
  },
  { id: "explorations", label: "Explorations", match: (n) => n.kind === "exploration" },
  { id: "brand", label: "Marque", match: (n) => n.kind === "brand" },
];

const LS_KEY = "studio.ui.layersFolders";

function readOpen(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw) as Record<string, boolean>;
  } catch {
    /* ignore */
  }
  return { pages: true, components: true, icons: false, explorations: true, brand: true };
}

export function CanvasLayers({ doc }: { doc: StudioCanvasDoc }) {
  const [open, setOpen] = useState<Record<string, boolean>>(readOpen);
  const [filter, setFilter] = useState<FolderId | "all">("all");

  const groups = useMemo(() => {
    const sorted = [...doc.nodes].sort((a, b) => b.zIndex - a.zIndex);
    return FOLDERS.map((f) => ({
      ...f,
      nodes: sorted.filter(f.match),
    })).filter((g) => g.nodes.length > 0);
  }, [doc.nodes]);

  const toggle = (id: string) => {
    setOpen((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  return (
    <aside className="studio-layers">
      <div className="studio-layers-hd">
        <Icon name="folderTree" size={13} />
        <span>Bibliothèque</span>
      </div>

      <div className="studio-layers-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          className={"studio-layers-tab" + (filter === "all" ? " is-active" : "")}
          onClick={() => setFilter("all")}
        >
          Tout
        </button>
        {groups.map((g) => (
          <button
            key={g.id}
            type="button"
            role="tab"
            className={"studio-layers-tab" + (filter === g.id ? " is-active" : "")}
            onClick={() => setFilter(g.id)}
            title={g.label}
          >
            {g.label}
            <span className="studio-layers-count">{g.nodes.length}</span>
          </button>
        ))}
      </div>

      <ul className="studio-layers-list scroll">
        {groups
          .filter((g) => filter === "all" || filter === g.id)
          .map((g) => {
            const isOpen = filter !== "all" ? true : open[g.id] !== false;
            return (
              <li key={g.id} className="studio-layers-folder">
                {filter === "all" && (
                  <button
                    type="button"
                    className="studio-layers-folder-hd"
                    onClick={() => toggle(g.id)}
                    aria-expanded={isOpen}
                  >
                    <Icon name={isOpen ? "down" : "chevron-right"} size={11} />
                    <span>{g.label}</span>
                    <span className="studio-layers-count">{g.nodes.length}</span>
                  </button>
                )}
                {isOpen && (
                  <ul className="studio-layers-folder-list">
                    {g.nodes.map((n) => (
                      <li key={n.id}>
                        <button
                          type="button"
                          className={
                            "studio-layers-item" + (doc.selectedId === n.id ? " is-active" : "")
                          }
                          onClick={() => setStudioCanvasDoc(selectNode(doc, n.id))}
                        >
                          <Icon
                            name={
                              n.kind === "brand"
                                ? "palette"
                                : n.kind === "live"
                                  ? "image"
                                  : n.kind === "component"
                                    ? "gallery"
                                    : "sparkle"
                            }
                            size={12}
                          />
                          <span className="studio-layers-name">{n.name}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
      </ul>
    </aside>
  );
}
