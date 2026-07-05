// Shugu Forge — the project switcher (V18). The dead `projects` table's
// color/sort_order columns finally drive a real, visible switcher: pick a
// project to open its folder, or scope the sidebar to the current project /
// all projects / global (unassigned) conversations.

import type { ProjectRow } from "@/lib/db";
import { GLOBAL_BUCKET } from "@/lib/db";

export type ProjectViewMode = "project" | "all" | "global";

interface Props {
  projects: ProjectRow[];
  counts: Record<string, number>;
  currentProjectId: string | null;
  viewMode: ProjectViewMode;
  onOpenProject: (rootPath: string) => void;
  onSetMode: (mode: ProjectViewMode) => void;
}

const MUTED = "var(--on-surface-variant, #8b8b93)";
const HAIRLINE = "1px solid rgba(255,255,255,0.06)";

function rowStyle(active: boolean): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    textAlign: "left",
    padding: "6px 12px",
    border: "none",
    borderLeft: active ? "2px solid var(--primary, #7f77dd)" : "2px solid transparent",
    background: active ? "rgba(127,119,221,0.10)" : "transparent",
    color: "inherit",
    cursor: "pointer",
    font: "inherit",
  };
}

export function ProjectSwitcher({
  projects,
  counts,
  currentProjectId,
  viewMode,
  onOpenProject,
  onSetMode,
}: Props) {
  const globalCount = counts[GLOBAL_BUCKET] ?? 0;

  return (
    <div style={{ borderBottom: HAIRLINE, paddingBottom: 6 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 12px 6px",
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 500, color: MUTED, flex: 1 }}>
          Projets
        </span>
        <button
          onClick={() => onSetMode("project")}
          style={chipStyle(viewMode === "project")}
          title="Conversations du projet ouvert"
        >
          Projet courant
        </button>
        <button
          onClick={() => onSetMode("all")}
          style={chipStyle(viewMode === "all")}
          title="Toutes les conversations, tous projets"
        >
          Tous
        </button>
      </div>

      <div style={{ maxHeight: 176, overflowY: "auto" }}>
        {projects.length === 0 && (
          <div style={{ padding: "4px 12px 8px", fontSize: 11, color: MUTED }}>
            Ouvre un dossier pour créer un projet.
          </div>
        )}
        {projects.map((p) => {
          const active = viewMode === "project" && p.id === currentProjectId;
          return (
            <button
              key={p.id}
              onClick={() => p.root_path && onOpenProject(p.root_path)}
              style={rowStyle(active)}
              title={p.root_path ?? p.name}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 999,
                  background: p.color ?? "#888780",
                  flex: "none",
                }}
              />
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: 13,
                }}
              >
                {p.name}
              </span>
              <span style={{ fontSize: 11, color: MUTED }}>{counts[p.id] ?? 0}</span>
            </button>
          );
        })}

        <button
          onClick={() => onSetMode("global")}
          style={{ ...rowStyle(viewMode === "global"), borderTop: HAIRLINE }}
          title="Conversations sans projet (dont l'historique d'avant les projets)"
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: 999,
              background: "#888780",
              flex: "none",
            }}
          />
          <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: MUTED }}>
            Global · sans projet
          </span>
          <span style={{ fontSize: 11, color: MUTED }}>{globalCount}</span>
        </button>
      </div>
    </div>
  );
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    border: HAIRLINE,
    borderRadius: 999,
    padding: "2px 9px",
    fontSize: 11,
    cursor: "pointer",
    background: active ? "var(--primary, #7f77dd)" : "transparent",
    color: active ? "#fff" : MUTED,
    font: "inherit",
    lineHeight: 1.6,
  };
}
