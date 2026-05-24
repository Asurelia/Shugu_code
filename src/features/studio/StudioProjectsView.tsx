// Shugu Forge — Studio · Projets tab (saved-projects grid).
//
// A Claude-Design-style "Recent" grid of saved/auto design projects, sourced
// from useStudioProjects() (TanStack → Rust → SQLite). Opening a project
// restores its snapshot into the live preview AND rebuilds the conversation
// thread from its agents (turnsFromAgents), then lands on "Créer". Rename is
// inline (click the name); delete is a soft-delete (the folder is kept).
//
// Named *View (not StudioProjects) to avoid a Windows case-collision with the
// data module `studioProjects.ts` — the repo convention pairs camelCase data
// modules with differently-named PascalCase components (studioChat ↔
// StudioConversation, studioDraft ↔ StudioView).

import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Icon } from "@/components/components";
import {
  useStudioProjects,
  invalidateStudioProjects,
  setStudioCurrentProject,
  studioProjectLoad,
  studioProjectRename,
  studioProjectDelete,
  type StudioProject,
} from "./studioProjects";
import { setStudioChat, clearStudioChat, turnsFromAgents } from "./studioChat";
import { setStudioDraft } from "./studioDraft";
import { listAgentsByConversation } from "@/lib/agents";

function fmtDate(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

export function StudioProjectsView() {
  const navigate = useNavigate();
  const { data: projects = [], isLoading } = useStudioProjects();
  const [opening, setOpening] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");

  const openProject = async (p: StudioProject) => {
    if (opening) return;
    setOpening(p.id);
    try {
      await studioProjectLoad(p.id); // snapshot → preview (fs://changed reloads the iframe)
      setStudioCurrentProject(p.id);
      // Continue THIS project's conversation; show the chat (not the wizard).
      setStudioDraft({ convId: p.conversationId ?? null, startingNew: false });
      if (p.conversationId) {
        const agents = await listAgentsByConversation(p.conversationId);
        setStudioChat(turnsFromAgents(agents));
      } else {
        clearStudioChat();
      }
      navigate({ to: "/studio" });
    } catch (err) {
      console.warn("[StudioProjects] open failed:", err);
      setOpening(null);
    }
  };

  const startRename = (p: StudioProject) => {
    setRenaming(p.id);
    setDraftName(p.name);
  };
  const commitRename = async (p: StudioProject) => {
    const name = draftName.trim();
    setRenaming(null);
    if (name && name !== p.name) {
      try {
        await studioProjectRename(p.id, name);
        invalidateStudioProjects();
      } catch (err) {
        console.warn("[StudioProjects] rename failed:", err);
      }
    }
  };
  const removeProject = async (p: StudioProject) => {
    try {
      await studioProjectDelete(p.id); // soft-delete — the folder stays on disk
      invalidateStudioProjects();
    } catch (err) {
      console.warn("[StudioProjects] delete failed:", err);
    }
  };

  return (
    <div className="studio-projects">
      <div className="studio-projects-head">
        <span className="studio-disco-label">Projets récents</span>
      </div>

      {isLoading ? (
        <div className="studio-projects-empty">
          <span className="studio-ring" /> Chargement…
        </div>
      ) : projects.length === 0 ? (
        <div className="studio-projects-empty">
          <Icon name="folder" size={28} />
          <div className="studio-projects-empty-title">Aucun projet enregistré</div>
          <p>Génère un projet dans « Créer » — il apparaîtra ici automatiquement.</p>
        </div>
      ) : (
        <div className="studio-projects-grid scroll">
          {projects.map((p) => (
            <div key={p.id} className="studio-project-card">
              <button
                className="studio-project-thumb"
                onClick={() => openProject(p)}
                disabled={!!opening}
                title={`Ouvrir « ${p.name} »`}
              >
                {opening === p.id ? <span className="studio-ring" /> : <Icon name="folder" size={36} />}
              </button>
              <button
                className="studio-project-del"
                onClick={() => void removeProject(p)}
                title="Supprimer (corbeille douce)"
              >
                <Icon name="x" size={12} />
              </button>
              <div className="studio-project-meta">
                {renaming === p.id ? (
                  <input
                    className="studio-project-rename"
                    value={draftName}
                    autoFocus
                    spellCheck={false}
                    onChange={(e) => setDraftName(e.target.value)}
                    onBlur={() => void commitRename(p)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void commitRename(p);
                      if (e.key === "Escape") setRenaming(null);
                    }}
                  />
                ) : (
                  <button
                    className="studio-project-name"
                    onClick={() => startRename(p)}
                    title="Cliquer pour renommer"
                  >
                    {p.name}
                  </button>
                )}
                <div className="studio-project-sub">
                  {p.kind === "saved" && <span className="studio-project-badge">sauvé</span>}
                  <span>{fmtDate(p.updatedAt)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
