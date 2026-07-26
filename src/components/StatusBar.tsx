// Shugu Forge — barre de statut globale du shell.
//
// Manque d'information visuelle identifié vs Cursor / Codex / Claude Desktop :
// hors de l'éditeur (chat, agents, studio…), AUCUN signal permanent ne disait
// où on travaille (projet, branche), ni ce que Shugu fait (réponse en cours,
// agents actifs, indexation). Cette barre rend cet état visible en continu.
//
// Rendue par RootLayout sur toutes les vues SAUF code/git : l'éditeur possède
// déjà sa `.statusbar` (branche, diff, LSP, curseur) ; on y injecte seulement
// <ShellStatusExtras/> pour la continuité (agents / busy / indexation).

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Icon } from "@/components/components";
import { fsGetWorkspaceRoot } from "@/lib/fs";
import { fsKeys } from "@/features/fs/keys";
import { useGitBranches, useGitStatus } from "@/features/git/queries";
import { useAgentsRailDisplay } from "@/features/agents/queries";
import { useChatBusy } from "@/features/chat/chatBusy";
import { useIndexingState } from "@/features/fs/indexingStore";
import { useUnreadNotificationCount } from "@/components/notifications";
import { ProjectTrustBadge } from "@/features/projects/ProjectTrustGate";

function basename(p: string | null | undefined): string | null {
  if (!p) return null;
  return p.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? null;
}

/**
 * Items d'activité partagés : agents actifs, génération chat en cours,
 * progression d'indexation. Utilisés par la barre globale ET injectés dans
 * la `.statusbar` de l'éditeur — même information partout dans l'app.
 * Auto-suffisant : navigue lui-même (useNavigate), aucun prop à threader.
 */
export function ShellStatusExtras() {
  const navigate = useNavigate();
  const agents = useAgentsRailDisplay();
  const busy = useChatBusy();
  const indexing = useIndexingState();
  const running = agents.filter((a) => a.status === "running").length;

  return (
    <>
      <ProjectTrustBadge />
      {running > 0 && (
        <button
          type="button"
          className="sb-item sb-btn sb-agents"
          onClick={() => navigate({ to: "/agents" as any })}
          title={`${running} agent(s) en cours d'exécution — voir les runs`}
        >
          <span className="sb-dot sb-dot-live" aria-hidden="true" />
          {running} agent{running > 1 ? "s" : ""} actif{running > 1 ? "s" : ""}
        </button>
      )}
      {busy && (
        <button
          type="button"
          className="sb-item sb-btn sb-busy"
          onClick={() => navigate({ to: "/chat" as any })}
          title="Shugu génère une réponse — aller au chat"
        >
          <span className="sb-spin" aria-hidden="true" />
          Shugu répond…
        </button>
      )}
      {indexing.status === "running" && (
        <span
          className="sb-item sb-indexing"
          title="Indexation sémantique du code en arrière-plan (recherche & RAG)"
        >
          <span className="sb-spin" aria-hidden="true" />
          Indexation {indexing.done}/{indexing.total}
        </span>
      )}
    </>
  );
}

export function StatusBar({
  navigateTo,
  onOpenRecent,
  onNotifications,
  onPalette,
}: {
  navigateTo: (view: string) => void;
  onOpenRecent: () => void;
  onNotifications: () => void;
  onPalette: () => void;
}) {
  const { data: wsRoot } = useQuery({
    queryKey: fsKeys.workspaceRoot(),
    queryFn: fsGetWorkspaceRoot,
    staleTime: Infinity,
    retry: false,
  });
  const workspace = basename(wsRoot);
  const { data: branches } = useGitBranches();
  const branch = branches?.current ?? null;
  const { data: gitStatus } = useGitStatus();
  const changes = gitStatus?.length ?? 0;
  const unread = useUnreadNotificationCount();

  return (
    <footer className="shell-statusbar" aria-label="Barre de statut">
      <button
        type="button"
        className="sb-item sb-btn"
        onClick={onOpenRecent}
        title="Projet ouvert — cliquer pour changer de dossier (récents)"
      >
        <Icon name="folder" size={11} />
        {workspace ?? "Aucun dossier ouvert"}
      </button>
      {branch && (
        <button
          type="button"
          className="sb-item sb-btn sb-branch"
          onClick={() => navigateTo("git")}
          title={`Branche ${branch}${changes ? ` — ${changes} fichier(s) modifié(s)` : " — arbre propre"} · ouvrir Source Control`}
        >
          <Icon name="branch" size={11} />
          {branch}
          {changes > 0 && <span className="sb-count">{changes}</span>}
        </button>
      )}
      <ShellStatusExtras />
      <span className="sb-spacer" />
      {unread > 0 && (
        <button
          type="button"
          className="sb-item sb-btn"
          onClick={onNotifications}
          title={`${unread} notification(s) non lue(s)`}
        >
          <Icon name="bell" size={11} />
          {unread}
        </button>
      )}
      <button
        type="button"
        className="sb-item sb-btn sb-kbd-hint"
        onClick={onPalette}
        title="Palette de commandes — tout Shugu au clavier"
      >
        <span className="kbd">⌘K</span> commandes
      </button>
    </footer>
  );
}
