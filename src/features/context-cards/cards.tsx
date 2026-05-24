// Shugu Forge — contextual cards (Plan / Tâches / Git / Prévisu / Sources / Env).
//
// Shared between the main chat's ContextBubble and the mascot FloatChat
// (Phase 4) — exigence mémoire "pas de duplication, logique data partagée".
// Every card is wired to REAL data via existing TanStack hooks; none mock.
//
//   Plan     → useAgentsByConversation  (the orchestrator + its sub-agents,
//              rendered as the design's checkbox step list)
//   Tâches   → useActiveAgents          (active agents as background-task
//              cards; no fake progress — indeterminate sweep + real elapsed)
//   Git      → <SideGit/>               (the full Source Control panel)
//   Env      → git branch + worktree changes + remotes
//   Sources  → vecSearch("code", …)     (semantic file retrieval for the conv)
//   Prévisu  → live web iframe (editable URL)

import { useMemo, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@/components/components";
import { SideGit } from "@/features/git/SideGit";
import { useAgentsByConversation, useActiveAgents } from "@/features/agents/queries";
import { useGitBranches, useGitRemotes } from "@/features/git/queries";
import { useWorkspaceChanges } from "@/features/git/useWorkspaceChanges";
import { useMessages } from "@/features/chat/chat-sync";
import { vecSearch } from "@/lib/vector";
import type { AgentRow } from "@/lib/agents";

// ─── Tab registry (shared with ContextBubble + FloatChat) ───
export const CTX_TABS = [
  { id: "plan",    label: "Plan",    icon: "commit" },
  { id: "tasks",   label: "Tâches",  icon: "agent" },
  { id: "git",     label: "Git",     icon: "git" },
  { id: "preview", label: "Prévisu", icon: "image" },
  { id: "sources", label: "Sources", icon: "folderTree" },
  { id: "env",     label: "Env",     icon: "shield" },
] as const;

export type CtxTabId = (typeof CTX_TABS)[number]["id"];

/** Live per-tab badge counts. */
export function useCtxCounts(convId: string): Record<CtxTabId, number> {
  const { data: convAgents = [] } = useAgentsByConversation(convId);
  const { data: activeAgents = [] } = useActiveAgents();
  const { count: changes } = useWorkspaceChanges();
  return {
    plan: convAgents.length,
    tasks: activeAgents.length,
    git: changes,
    preview: 0,
    sources: 0,
    env: 0,
  };
}

// ─── Dispatcher ─────────────────────────────────────────────
export function ContextCard({
  tab,
  convId,
  onOpenFile,
}: {
  tab: CtxTabId;
  convId: string;
  onOpenFile: (path: string) => void;
}) {
  switch (tab) {
    case "plan":    return <PlanCard convId={convId} />;
    case "tasks":   return <TasksCard />;
    case "git":     return <div className="ctx-embed"><SideGit /></div>;
    case "preview": return <PreviewCard />;
    case "sources": return <SourcesCard convId={convId} onOpenFile={onOpenFile} />;
    case "env":     return <EnvCard onOpenFile={onOpenFile} />;
    default:        return null;
  }
}

// ─── Shared helpers ─────────────────────────────────────────
function agentStepStatus(s: string): "done" | "running" | "pending" | "error" {
  if (s === "complete") return "done";
  if (s === "running") return "running";
  if (s === "pending") return "pending";
  return "error";
}

/** Compact duration: <60s → "0.4s", else "2m 13s". */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/** Re-render every `ms` while `active` so live elapsed counters keep moving
 *  between query invalidations. Pure UI ticker — local state, not TanStack. */
function useTick(ms: number, active: boolean): void {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setN((n) => n + 1), ms);
    return () => window.clearInterval(id);
  }, [ms, active]);
}

const CheckGlyph = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

// ─── Plan ───────────────────────────────────────────────────
// The conversation's orchestrator plan as the design's checkbox step list.
// Real source: useAgentsByConversation → the root orchestrator (parentId ===
// null) and its child sub-agents are the ordered steps. No mock data: status
// drives the checkbox, role the sub-line, finishedAt−createdAt the timer.
function PlanCard({ convId }: { convId: string }) {
  const { data: agents = [] } = useAgentsByConversation(convId);

  const { title, steps } = useMemo(() => {
    const orchestrator = agents.find((a) => a.parentId === null) ?? null;
    const children = orchestrator ? agents.filter((a) => a.parentId === orchestrator.id) : [];
    const list = (children.length > 0 ? children : agents).slice().sort((a, b) => a.createdAt - b.createdAt);
    return { title: orchestrator?.task ?? "Plan", steps: list };
  }, [agents]);

  const hasRunning = steps.some((s) => s.status === "running");
  useTick(1000, hasRunning);

  if (steps.length === 0) {
    return <CardEmpty icon="commit" text="Aucun plan pour cette conversation. Délègue une tâche à l'orchestrateur pour le voir apparaître ici." />;
  }

  const doneCount = steps.filter((s) => s.status === "complete").length;
  const minStart = Math.min(...steps.map((s) => s.createdAt));
  const maxEnd = Math.max(...steps.map((s) => s.finishedAt ?? Date.now()));

  return (
    <div className="ctx-plan">
      <div className="ctx-card-head">
        <div className="ctx-card-title" title={title}>{title}</div>
        <span className="ctx-card-sub">{doneCount}/{steps.length} · {fmtElapsed(maxEnd - minStart)}</span>
      </div>
      {steps.map((a: AgentRow) => {
        const st = agentStepStatus(a.status);
        const cls = st === "done" ? "done" : st === "running" ? "run" : st === "error" ? "error" : "";
        const timer =
          st === "done" && a.finishedAt ? fmtElapsed(a.finishedAt - a.createdAt)
          : st === "running" ? "en cours · " + fmtElapsed(Date.now() - a.createdAt)
          : "";
        return (
          <div key={a.id} className={"plan-step " + cls}>
            <div className="box">
              {st === "done" && <CheckGlyph />}
              {st === "error" && <span className="x">✕</span>}
            </div>
            <div className="content">
              <div className="label">{a.task || a.role}</div>
              {(a.role || timer) && (
                <div className="meta">
                  {a.role && <span className="file">{a.role}</span>}
                  {timer && <span className="timer">{timer}</span>}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Tâches ─────────────────────────────────────────────────
// Active background work in the design's task-card aesthetic. Real source:
// useActiveAgents (status pending|running). The design's progress percentages
// have NO real source (agents carry no %), so running tasks show an
// indeterminate sweep + real elapsed instead of a fabricated bar; pending
// tasks read "en file". Concise by design — respects the AgentsPanel UX rule
// (no live per-event streaming dump here).
function TasksCard() {
  const { data: agents = [] } = useActiveAgents();
  const hasRunning = agents.some((a) => a.status === "running");
  useTick(1000, hasRunning);

  if (agents.length === 0) {
    return <CardEmpty icon="agent" text="Pas de tâche active. Les agents de l'orchestrateur apparaîtront ici pendant qu'ils travaillent." />;
  }

  return (
    <div className="ctx-tasks">
      <div className="ctx-card-head">
        <div className="ctx-card-title">Tâches en arrière-plan</div>
        <span className="ctx-card-sub">{agents.length} active{agents.length > 1 ? "s" : ""}</span>
      </div>
      {agents.map((a: AgentRow) => {
        const running = a.status === "running";
        return (
          <div key={a.id} className={"task-card" + (running ? " run" : "")}>
            <div className="task-row1">
              <span className="task-name" title={a.task}>{a.task || a.role}</span>
              <span className={"task-badge " + (running ? "running" : "queued")}>
                {running ? "en cours" : "en file"}
              </span>
            </div>
            <div className="task-stream">{a.role} · {a.model}</div>
            <div className="task-foot">
              {running && <div className="task-bar"><span /></div>}
              <span className="task-time">{running ? fmtElapsed(Date.now() - a.createdAt) : "en attente"}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Env ────────────────────────────────────────────────────
function EnvCard({ onOpenFile }: { onOpenFile: (path: string) => void }) {
  const { data: branches } = useGitBranches();
  const { data: remotes = [] } = useGitRemotes();
  const { files, isRepo } = useWorkspaceChanges();

  if (!isRepo) {
    return <CardEmpty icon="git" text="L'espace de travail n'est pas un dépôt git." />;
  }
  const current = branches?.current ?? "(detached)";
  const curBranch = branches?.local.find((b) => b.name === current);

  return (
    <div className="ctx-env">
      <div className="ctx-env-section">
        <div className="ctx-env-label">Branche</div>
        <div className="ctx-env-row">
          <span className="ctx-tag branch"><Icon name="branch" size={11} /> {current}</span>
          {curBranch && (curBranch.ahead > 0 || curBranch.behind > 0) && (
            <span className="ctx-env-aheadbehind">↑{curBranch.ahead} ↓{curBranch.behind}</span>
          )}
        </div>
        {curBranch?.upstream && <div className="ctx-env-sub">suit {curBranch.upstream}</div>}
      </div>

      <div className="ctx-env-section">
        <div className="ctx-env-label">Modifications ({files.length})</div>
        {files.length === 0 ? (
          <div className="ctx-env-sub">espace de travail propre</div>
        ) : (
          <div className="ctx-env-files">
            {files.slice(0, 8).map((f) => (
              <div key={f.name} className="ctx-env-file" onClick={() => onOpenFile(f.name)} title="Ouvrir">
                <span className={"dot " + f.st} />
                <span className="name">{f.name}</span>
              </div>
            ))}
            {files.length > 8 && <div className="ctx-env-sub">+{files.length - 8} de plus…</div>}
          </div>
        )}
      </div>

      <div className="ctx-env-section">
        <div className="ctx-env-label">Remotes</div>
        {remotes.length === 0 ? (
          <div className="ctx-env-sub">aucun remote configuré</div>
        ) : (
          remotes.map((r) => (
            <div key={r.name} className="ctx-env-remote">
              <span className="ctx-tag"><Icon name="push" size={11} /> {r.name}</span>
              <span className="ctx-env-url" title={r.url}>{r.url}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Sources ────────────────────────────────────────────────
// Semantic file retrieval for the conversation. The query is the latest user
// message (the conversation's current intent); results come from the "code"
// vector collection populated by the workspace indexer.
function SourcesCard({ convId, onOpenFile }: { convId: string; onOpenFile: (path: string) => void }) {
  const { data: messages = [] } = useMessages(convId);
  const query = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "user" && (m.text || "").trim()) return (m.text as string).trim().slice(0, 400);
    }
    return "";
  }, [messages]);

  const { data: hits = [], isFetching } = useQuery({
    queryKey: ["ctx-sources", convId, query],
    queryFn: () => vecSearch("code", query, 8),
    enabled: query.length > 0,
    staleTime: 30_000,
    retry: false,
  });

  if (!query) {
    return <CardEmpty icon="folderTree" text="Envoie un message pour retrouver les fichiers pertinents de l'espace de travail." />;
  }
  return (
    <div className="ctx-sources">
      <div className="ctx-sources-meta">
        <span className="ctx-tag"><Icon name="sparkle" size={10} /> vectoriel</span>
        <span className="ctx-sources-hint">{isFetching ? "recherche…" : `${hits.length} fichier${hits.length > 1 ? "s" : ""} · top-k 8`}</span>
      </div>
      {hits.length === 0 && !isFetching ? (
        <div className="ctx-env-sub" style={{ padding: "8px 4px" }}>aucune source pertinente trouvée.</div>
      ) : (
        <div className="ctx-sources-list">
          {hits.map((h) => {
            const seg = h.id.split("/");
            const name = seg.pop() ?? h.id;
            const dir = seg.join("/");
            return (
              <div key={h.id} className="ctx-source" onClick={() => onOpenFile(h.id)} title={"Ouvrir " + h.id}>
                <Icon name="file" size={12} />
                <span className="ctx-source-name">{name}</span>
                {dir && <span className="ctx-source-dir">{dir}</span>}
                <span className="ctx-source-sim">{(1 - h.distance).toFixed(2)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Prévisu ────────────────────────────────────────────────
// Live web preview. Defaults to the running app's own origin (the dev server
// in dev mode); the URL is editable so any local page can be previewed.
function PreviewCard() {
  // Default to the running origin only when it's the real web dev server
  // (http/https AND not the Tauri webview host). A packaged Tauri build serves
  // the app itself from tauri://localhost or http://tauri.localhost (Windows) —
  // neither is a useful preview target, so fall back to the configured Vite dev
  // URL, which the user can edit to point at any local server.
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const isWebDev = /^https?:\/\//.test(origin) && !origin.includes("tauri.localhost");
  const initial = isWebDev ? origin : "http://localhost:5173";
  const [url, setUrl] = useState(initial);
  const [src, setSrc] = useState(initial);
  const [nonce, setNonce] = useState(0);

  const go = () => { setSrc(url); setNonce((n) => n + 1); };

  return (
    <div className="ctx-preview">
      <div className="ctx-preview-bar">
        <input
          className="ctx-preview-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") go(); }}
          placeholder="http://localhost:5173"
          spellCheck={false}
        />
        <button className="ctx-preview-go" onClick={go} title="Recharger"><Icon name="history" size={12} /></button>
      </div>
      <div className="ctx-preview-frame">
        <iframe key={nonce} src={src} title="Prévisu" sandbox="allow-scripts allow-same-origin allow-forms" />
      </div>
    </div>
  );
}

// ─── Shared empty state ─────────────────────────────────────
function CardEmpty({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="ctx-empty">
      <Icon name={icon} size={22} />
      <p>{text}</p>
    </div>
  );
}
