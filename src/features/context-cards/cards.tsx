// Shugu Forge — contextual cards (Plan / Agents / Git / Prévisu / Sources / Env).
//
// Partagé entre le ContextBubble du chat principal et la mascotte — exigence
// mémoire « pas de duplication, logique data partagée ». Chaque carte est
// branchée sur la VRAIE donnée, scopée à la conversation / au projet courant :
//
//   Plan     → le dernier `todo_write` de l'orchestrateur de la conversation,
//              rendu via le composant partagé <AgentPlan/> (même format que le
//              fil de chat — façon Claude Code).
//   Agents   → useActiveAgents + l'action en COURS de chaque agent (ce qu'il fait).
//   Git      → récap visuel (branche, diffstat, commits, worktrees) + git init,
//              avec accès au panneau Source Control complet (<SideGit/>).
//   Prévisu  → iframe SEULEMENT si un serveur de dev est détecté (TCP probe).
//   Sources  → les VRAIES sources injectées dans la conversation (db.sources).
//   Env      → voir / éditer les fichiers .env du projet ouvert.

import { useMemo, useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Icon } from "@/components/components";
import { SideGit } from "@/features/git/SideGit";
import {
  useAgentsByConversation,
  useActiveAgents,
  useAgentTranscript,
} from "@/features/agents/queries";
import {
  useIsGitRepo,
  useGitBranches,
  useGitLog,
  useGitWorktrees,
  useGitNumstat,
} from "@/features/git/queries";
import { useGitInit, useWorktreeAdd, useWorktreeRemove } from "@/features/git/mutations";
import { useWorkspaceChanges } from "@/features/git/useWorkspaceChanges";
import { useMessages } from "@/features/chat/chat-sync";
import { AgentPlan } from "@/features/chat/AgentPlan";
import { parsePlan, useAgentCurrentActivity } from "@/features/chat/useMessageDisplay";
import {
  fsReadDirShallow,
  fsReadFile,
  fsWriteFile,
  fsGetWorkspaceRoot,
  fsSetWorkspaceRoot,
} from "@/lib/fs";
import { previewDetectServer } from "@/lib/git";
import { db } from "@/lib/db";
import type { AgentRow } from "@/lib/agents";

// ─── Tab registry (shared with ContextBubble + FloatChat) ───
export const CTX_TABS = [
  { id: "plan",    label: "Plan",    icon: "commit" },
  { id: "tasks",   label: "Agents",  icon: "agent" },
  { id: "git",     label: "Git",     icon: "git" },
  { id: "preview", label: "Prévisu", icon: "image" },
  { id: "sources", label: "Sources", icon: "folderTree" },
  { id: "env",     label: "Env",     icon: "shield" },
] as const;

export type CtxTabId = (typeof CTX_TABS)[number]["id"];

/** Live per-tab badge counts. Seuls les signaux « attention » portent un nombre
 *  (agents actifs, fichiers modifiés) ; les autres onglets n'ont pas de compteur
 *  pertinent. */
export function useCtxCounts(_convId: string): Record<CtxTabId, number> {
  const { data: activeAgents = [] } = useActiveAgents();
  const { count: changes } = useWorkspaceChanges();
  return {
    plan: 0,
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
    case "git":     return <GitRecapCard onOpenFile={onOpenFile} />;
    case "preview": return <PreviewCard />;
    case "sources": return <SourcesCard convId={convId} onOpenFile={onOpenFile} />;
    case "env":     return <EnvCard onOpenFile={onOpenFile} />;
    default:        return null;
  }
}

// ─── Shared helpers ─────────────────────────────────────────
/** Compact duration: <60s → "0.4s", else "2m 13s". */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/** Relative "il y a …" from a unix-seconds timestamp. */
function fmtAgo(unixSeconds: number): string {
  const s = Math.max(0, Date.now() / 1000 - unixSeconds);
  if (s < 60) return "à l'instant";
  const m = Math.floor(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.floor(h / 24);
  return `il y a ${d} j`;
}

/** "…/parent/file" — keep the last two segments of a long path. */
function shortPath(p: string): string {
  const seg = p.split("/").filter(Boolean);
  return seg.length <= 2 ? p : "…/" + seg.slice(-2).join("/");
}

/** Loose cross-platform path equality (slashes, trailing slash, case). */
function samePath(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

/** Re-render every `ms` while `active` so live elapsed counters keep moving. */
function useTick(ms: number, active: boolean): void {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setN((n) => n + 1), ms);
    return () => window.clearInterval(id);
  }, [ms, active]);
}

// ─── Plan ───────────────────────────────────────────────────
// Le VRAI plan de la conversation = le dernier `todo_write` de l'orchestrateur
// racine (parentId === null). Parsé via `parsePlan` et rendu via le composant
// partagé <AgentPlan/> — exactement le même format (☐/◐/☑) que dans le fil de
// chat, façon Claude Code. Plus de dump illisible des tâches d'agents.
function PlanCard({ convId }: { convId: string }) {
  const { data: agents = [] } = useAgentsByConversation(convId);

  const rootId = useMemo(() => {
    const roots = agents.filter((a) => a.parentId === null);
    if (roots.length === 0) return null;
    return roots.reduce((a, b) => (b.createdAt > a.createdAt ? b : a)).id;
  }, [agents]);

  const { data: transcript } = useAgentTranscript(rootId);

  const plan = useMemo(() => {
    if (!transcript) return undefined;
    let p: ReturnType<typeof parsePlan>;
    for (const ev of transcript.events) {
      if (ev.kind === "toolCall" && ev.tool === "todo_write") {
        p = parsePlan(ev.args) ?? p;
      }
    }
    return p;
  }, [transcript]);

  const hasRunning = plan?.some((s) => s.status === "in_progress") ?? false;
  useTick(1000, hasRunning);

  if (!plan || plan.length === 0) {
    return (
      <CardEmpty
        icon="commit"
        text="Aucun plan pour cette conversation. Passe en mode Plan ou Agent et confie une tâche : la checklist du plan apparaîtra ici."
      />
    );
  }

  return (
    <div className="ctx-plan-wrap">
      <AgentPlan steps={plan} />
    </div>
  );
}

// ─── Agents (active sub-agents + current activity) ──────────
function TasksCard() {
  const { data: agents = [] } = useActiveAgents();
  const hasRunning = agents.some((a) => a.status === "running");
  useTick(1000, hasRunning);

  if (agents.length === 0) {
    return (
      <CardEmpty
        icon="agent"
        text="Aucun agent actif. Les sous-agents lancés par l'orchestrateur apparaîtront ici avec ce qu'ils font en temps réel."
      />
    );
  }

  return (
    <div className="ctx-tasks">
      <div className="ctx-card-head">
        <div className="ctx-card-title">Agents en cours</div>
        <span className="ctx-card-sub">{agents.length} actif{agents.length > 1 ? "s" : ""}</span>
      </div>
      {agents.map((a) => (
        <AgentTaskCard key={a.id} a={a} />
      ))}
    </div>
  );
}

function AgentTaskCard({ a }: { a: AgentRow }) {
  const activity = useAgentCurrentActivity(a.id);
  const running = a.status === "running";
  return (
    <div className={"task-card" + (running ? " run" : "")}>
      <div className="task-row1">
        <span className="task-name" title={a.task}>{a.task || a.role}</span>
        <span className={"task-badge " + (running ? "running" : "queued")}>
          {running ? "en cours" : "en file"}
        </span>
      </div>
      <div className="task-stream">{a.role} · {a.model}</div>
      {activity && (
        <div className="task-activity">
          <span className="ic">{activity.icon}</span>
          <span className="lb">{activity.label}</span>
          {activity.detail && <span className="dt" title={activity.detail}>{activity.detail}</span>}
          <span className="st">{activity.running ? "…" : "✓"}</span>
        </div>
      )}
      <div className="task-foot">
        {running && <div className="task-bar"><span /></div>}
        <span className="task-time">{running ? fmtElapsed(Date.now() - a.createdAt) : "en attente"}</span>
      </div>
    </div>
  );
}

// ─── Git (récap visuel + worktrees + accès panneau complet) ──
function GitRecapCard({ onOpenFile }: { onOpenFile: (path: string) => void }) {
  const [full, setFull] = useState(false);
  const isRepo = useIsGitRepo();
  const initMut = useGitInit();

  if (!isRepo) {
    return (
      <div className="ctx-git-init">
        <Icon name="git" size={24} />
        <p>Cet espace de travail n'est pas un dépôt git.</p>
        <button
          className="lgb lgb-primary lgb-sm"
          disabled={initMut.isPending}
          onClick={() => initMut.mutate()}
        >
          {initMut.isPending ? "Initialisation…" : "Initialiser un dépôt"}
        </button>
        {initMut.isError && <div className="ctx-err">{String(initMut.error)}</div>}
      </div>
    );
  }

  if (full) {
    return (
      <div className="ctx-git-full">
        <button className="ctx-git-back" onClick={() => setFull(false)}>
          ‹ Récap
        </button>
        <div className="ctx-embed"><SideGit /></div>
      </div>
    );
  }

  return <GitRecap onOpenFile={onOpenFile} onFull={() => setFull(true)} />;
}

function GitRecap({
  onOpenFile,
  onFull,
}: {
  onOpenFile: (path: string) => void;
  onFull: () => void;
}) {
  const { data: branches } = useGitBranches();
  const { files } = useWorkspaceChanges();
  const { data: numstat = [] } = useGitNumstat();
  const { data: commits = [] } = useGitLog(6);

  const numByPath = useMemo(() => {
    const m = new Map<string, { a: number; r: number }>();
    for (const n of numstat) m.set(n.path, { a: n.added, r: n.removed });
    return m;
  }, [numstat]);
  const totalAdd = numstat.reduce((s, n) => s + n.added, 0);
  const totalRem = numstat.reduce((s, n) => s + n.removed, 0);

  const current = branches?.current ?? "(detached)";
  const curBranch = branches?.local.find((b) => b.name === current);

  return (
    <div className="ctx-git">
      <div className="ctx-git-branch">
        <span className="ctx-tag branch"><Icon name="branch" size={11} /> {current}</span>
        {curBranch && (curBranch.ahead > 0 || curBranch.behind > 0) && (
          <span className="ctx-env-aheadbehind">↑{curBranch.ahead} ↓{curBranch.behind}</span>
        )}
        <button className="ctx-git-fullbtn" onClick={onFull} title="Ouvrir le gestionnaire complet">
          Gérer
        </button>
      </div>

      <div className="ctx-git-section">
        <div className="ctx-git-sec-head">
          <span>Modifications ({files.length})</span>
          {(totalAdd > 0 || totalRem > 0) && (
            <span className="ctx-diffstat">
              <span className="add">+{totalAdd}</span> <span className="rem">−{totalRem}</span>
            </span>
          )}
        </div>
        {files.length === 0 ? (
          <div className="ctx-env-sub">espace de travail propre</div>
        ) : (
          <div className="ctx-git-files">
            {files.slice(0, 8).map((f) => {
              const n = numByPath.get(f.name);
              return (
                <div
                  key={f.name}
                  className="ctx-git-file"
                  onClick={() => onOpenFile(f.name)}
                  title={"Ouvrir " + f.name}
                >
                  <span className={"dot " + f.st} />
                  <span className="name">{f.name}</span>
                  {n && (n.a > 0 || n.r > 0) && (
                    <span className="nums">
                      <span className="add">+{n.a}</span>
                      <span className="rem">−{n.r}</span>
                    </span>
                  )}
                </div>
              );
            })}
            {files.length > 8 && <div className="ctx-env-sub">+{files.length - 8} de plus…</div>}
          </div>
        )}
      </div>

      <div className="ctx-git-section">
        <div className="ctx-git-sec-head"><span>Commits récents</span></div>
        {commits.length === 0 ? (
          <div className="ctx-env-sub">aucun commit pour l'instant</div>
        ) : (
          <ul className="ctx-git-commits">
            {commits.map((c) => (
              <li key={c.oid} className="ctx-commit">
                <span className="graph"><span className="cdot" /></span>
                <div className="cbody">
                  <div className="csum" title={c.summary}>{c.summary}</div>
                  <div className="cmeta">
                    <span className="coid">{c.shortOid}</span> · {c.authorName} · {fmtAgo(c.timestamp)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <WorktreesSection />
    </div>
  );
}

function WorktreesSection() {
  const { data: worktrees = [] } = useGitWorktrees();
  const { data: wsRoot = null } = useQuery({
    queryKey: ["ws-root"],
    queryFn: fsGetWorkspaceRoot,
    staleTime: Infinity,
    retry: false,
  });
  const addMut = useWorktreeAdd();
  const rmMut = useWorktreeRemove();
  const [creating, setCreating] = useState(false);
  const [branch, setBranch] = useState("");

  const create = () => {
    const b = branch.trim();
    if (!b) return;
    addMut.mutate(
      { path: `.worktrees/${b}`, branch: b, newBranch: true },
      { onSuccess: () => { setCreating(false); setBranch(""); } },
    );
  };

  const open = (path: string) => {
    void fsSetWorkspaceRoot(path).catch((e) => console.warn("[ctx] open worktree", e));
  };

  return (
    <div className="ctx-git-section">
      <div className="ctx-git-sec-head">
        <span>Worktrees</span>
        <button className="ctx-wt-add" onClick={() => setCreating((v) => !v)} title="Créer un worktree">
          <Icon name="plus" size={12} />
        </button>
      </div>

      {creating && (
        <div className="ctx-wt-form">
          <input
            className="ctx-wt-input"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="nom-de-branche"
            spellCheck={false}
            onKeyDown={(e) => { if (e.key === "Enter") create(); }}
          />
          <button
            className="lgb lgb-sm lgb-primary"
            disabled={addMut.isPending || !branch.trim()}
            onClick={create}
          >
            {addMut.isPending ? "…" : "Créer"}
          </button>
        </div>
      )}
      {addMut.isError && <div className="ctx-err">{String(addMut.error)}</div>}
      {rmMut.isError && <div className="ctx-err">{String(rmMut.error)}</div>}

      {worktrees.length === 0 ? (
        <div className="ctx-env-sub">aucun worktree lié</div>
      ) : (
        <div className="ctx-wt-list">
          {worktrees.map((w) => {
            const isCurrent = samePath(w.path, wsRoot);
            return (
              <div key={w.path} className={"ctx-wt" + (isCurrent ? " current" : "")}>
                <button
                  className="ctx-wt-main"
                  title={isCurrent ? w.path : "Ouvrir " + w.path}
                  disabled={isCurrent}
                  onClick={() => !isCurrent && open(w.path)}
                >
                  <Icon name="folder" size={12} />
                  <span className="wt-branch">
                    {w.branch ?? (w.isDetached ? "(detached)" : "(bare)")}
                  </span>
                  <span className="wt-path">{shortPath(w.path)}</span>
                  {isCurrent && <span className="wt-cur">courant</span>}
                </button>
                {!isCurrent && (
                  <button
                    className="ctx-wt-rm"
                    title="Supprimer ce worktree"
                    disabled={rmMut.isPending}
                    onClick={() => rmMut.mutate({ path: w.path })}
                  >
                    <Icon name="x" size={11} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Prévisu (iframe SEULEMENT si un serveur est détecté) ───
const PREVIEW_PORTS = [5173, 3000, 4173, 8080, 8000, 5000];

function PreviewCard() {
  const { data: openPorts = [] } = useQuery({
    queryKey: ["ctx-preview-ports"],
    queryFn: () => previewDetectServer(PREVIEW_PORTS),
    refetchInterval: 2500,
    staleTime: 0,
    retry: false,
  });
  const first = openPorts.length ? `http://localhost:${openPorts[0]}` : "";

  const [url, setUrl] = useState("");
  const [src, setSrc] = useState("");
  const [nonce, setNonce] = useState(0);
  const [manual, setManual] = useState("");

  // Adopt the first detected server as soon as one appears (unless the user
  // already pointed the preview somewhere manually).
  useEffect(() => {
    if (first && !src) {
      setUrl(first);
      setSrc(first);
    }
  }, [first, src]);

  const go = () => { setSrc(url); setNonce((n) => n + 1); };
  const openManual = () => {
    const u = manual.trim();
    if (!u) return;
    setUrl(u);
    setSrc(u);
    setNonce((n) => n + 1);
  };

  if (!src) {
    return (
      <div className="ctx-preview-empty">
        <Icon name="image" size={24} />
        <p>
          Aucun serveur de prévisu détecté.<br />
          Lance ton serveur de dev (ex. <code>pnpm dev</code>) pour le voir ici.
        </p>
        <div className="ctx-preview-manual">
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            placeholder="ou saisir une URL…"
            spellCheck={false}
            onKeyDown={(e) => { if (e.key === "Enter") openManual(); }}
          />
          <button className="lgb lgb-sm" disabled={!manual.trim()} onClick={openManual}>
            Ouvrir
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="ctx-preview">
      <div className="ctx-preview-bar">
        {openPorts.length > 1 && (
          <select
            className="ctx-preview-sel"
            value={openPorts.some((p) => `http://localhost:${p}` === url) ? url : ""}
            onChange={(e) => { setUrl(e.target.value); setSrc(e.target.value); setNonce((n) => n + 1); }}
          >
            <option value="" disabled>serveurs…</option>
            {openPorts.map((p) => {
              const u = `http://localhost:${p}`;
              return <option key={p} value={u}>localhost:{p}</option>;
            })}
          </select>
        )}
        <input
          className="ctx-preview-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") go(); }}
          placeholder="http://localhost:5173"
          spellCheck={false}
        />
        <button className="ctx-preview-go" onClick={go} title="Recharger">
          <Icon name="history" size={12} />
        </button>
      </div>
      <div className="ctx-preview-frame">
        <iframe key={nonce} src={src} title="Prévisu" sandbox="allow-scripts allow-same-origin allow-forms" />
      </div>
    </div>
  );
}

// ─── Sources (vraies sources injectées dans la conversation) ─
function SourcesCard({ convId, onOpenFile }: { convId: string; onOpenFile: (path: string) => void }) {
  const { data: messages = [] } = useMessages(convId);
  // Re-key on message count so the just-logged sources show up after a send.
  const { data: srcs = [] } = useQuery({
    queryKey: ["ctx-sources-used", convId, messages.length],
    queryFn: () => db.sources.listByConversation(convId),
    staleTime: 3_000,
    retry: false,
  });

  if (srcs.length === 0) {
    return (
      <CardEmpty
        icon="folderTree"
        text="Aucune source utilisée pour l'instant. Les fichiers réellement injectés dans le contexte (éditeur, @mentions, RAG) apparaîtront ici après un message."
      />
    );
  }

  return (
    <div className="ctx-sources">
      <div className="ctx-sources-meta">
        <span className="ctx-tag"><Icon name="folderTree" size={10} /> {srcs.length} source{srcs.length > 1 ? "s" : ""}</span>
        <span className="ctx-sources-hint">réellement injectées</span>
      </div>
      <div className="ctx-sources-list">
        {srcs.map((s) => {
          const seg = s.path.split("/");
          const name = seg.pop() ?? s.path;
          const dir = seg.join("/");
          return (
            <div key={s.path} className="ctx-source" onClick={() => onOpenFile(s.path)} title={"Ouvrir " + s.path}>
              <Icon name="file" size={12} />
              <span className="ctx-source-name">{name}</span>
              {dir && <span className="ctx-source-dir">{dir}</span>}
              <span className="ctx-source-kinds">{kindTags(s.kind)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function kindTags(kind: string): string {
  const map: Record<string, string> = { editor: "éditeur", mention: "@mention", rag: "RAG" };
  return kind
    .split(",")
    .map((k) => map[k] ?? k)
    .join(" · ");
}

// ─── Env (voir / éditer les .env du projet) ─────────────────
function EnvCard({ onOpenFile }: { onOpenFile: (path: string) => void }) {
  const { data: envFiles = [], isLoading } = useQuery({
    queryKey: ["ctx-env-files"],
    queryFn: async () => {
      const entries = await fsReadDirShallow("");
      return entries
        .filter((e) => !e.isDir && e.name.startsWith(".env"))
        .map((e) => e.path)
        .sort();
    },
    staleTime: 5_000,
    retry: false,
  });

  if (isLoading) {
    return <div className="ctx-env-sub" style={{ padding: 12 }}>chargement…</div>;
  }
  if (envFiles.length === 0) {
    return (
      <CardEmpty
        icon="shield"
        text="Aucun fichier .env à la racine du projet. Crée un .env (ou .env.local) pour gérer tes variables d'environnement ici."
      />
    );
  }

  return (
    <div className="ctx-env-editor">
      {envFiles.map((p) => (
        <EnvFileEditor key={p} path={p} onOpenFile={onOpenFile} />
      ))}
    </div>
  );
}

interface EnvRow { key: string; value: string }

function parseDotenv(text: string): EnvRow[] {
  const out: EnvRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const key = t.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = t.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out.push({ key, value });
  }
  return out;
}

function serializeDotenv(rows: EnvRow[]): string {
  const body = rows
    .filter((r) => r.key.trim())
    .map((r) => {
      const needsQuote = /\s|#|"|'/.test(r.value);
      const v = needsQuote ? `"${r.value.replace(/"/g, '\\"')}"` : r.value;
      return `${r.key.trim()}=${v}`;
    })
    .join("\n");
  return body ? body + "\n" : "";
}

function EnvFileEditor({ path, onOpenFile }: { path: string; onOpenFile: (path: string) => void }) {
  const qc = useQueryClient();
  const { data: content = "" } = useQuery({
    queryKey: ["ctx-env-content", path],
    queryFn: async () => (await fsReadFile(path)).text,
    staleTime: 5_000,
    retry: false,
  });

  const [rows, setRows] = useState<EnvRow[]>([]);
  const [raw, setRaw] = useState(false);
  const [rawText, setRawText] = useState("");
  const [reveal, setReveal] = useState<Record<number, boolean>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // (Re)hydrate from disk content. Resets dirty + reveal on external change.
  useEffect(() => {
    setRows(parseDotenv(content));
    setRawText(content);
    setReveal({});
    setDirty(false);
  }, [content]);

  const name = path.split("/").pop() ?? path;

  const setRow = (i: number, patch: Partial<EnvRow>) => {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
    setDirty(true);
  };
  const removeRow = (i: number) => {
    setRows((rs) => rs.filter((_, j) => j !== i));
    setDirty(true);
  };
  const addRow = () => {
    setRows((rs) => [...rs, { key: "", value: "" }]);
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const text = raw ? rawText : serializeDotenv(rows);
      await fsWriteFile(path, text);
      setDirty(false);
      void qc.invalidateQueries({ queryKey: ["ctx-env-content", path] });
    } catch (e) {
      console.warn("[ctx] save .env", e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ctx-envfile">
      <div className="ctx-envfile-head">
        <button className="ctx-envfile-name" onClick={() => onOpenFile(path)} title={"Ouvrir " + path}>
          <Icon name="shield" size={12} /> {name}
        </button>
        <div className="ctx-envfile-actions">
          <button
            className={"ctx-envfile-toggle" + (raw ? " on" : "")}
            onClick={() => { if (!raw) setRawText(serializeDotenv(rows)); setRaw((v) => !v); }}
            title="Édition brute"
          >
            {raw ? "table" : "brut"}
          </button>
          <button
            className="lgb lgb-sm lgb-primary"
            disabled={!dirty || saving}
            onClick={save}
          >
            {saving ? "…" : "Enregistrer"}
          </button>
        </div>
      </div>

      {raw ? (
        <textarea
          className="ctx-env-raw"
          value={rawText}
          spellCheck={false}
          onChange={(e) => { setRawText(e.target.value); setDirty(true); }}
        />
      ) : (
        <div className="ctx-env-rows">
          {rows.length === 0 && <div className="ctx-env-sub">fichier vide</div>}
          {rows.map((r, i) => (
            <div key={i} className="ctx-env-kv">
              <input
                className="ctx-env-key"
                value={r.key}
                placeholder="CLÉ"
                spellCheck={false}
                onChange={(e) => setRow(i, { key: e.target.value })}
              />
              <input
                className="ctx-env-val"
                type={reveal[i] ? "text" : "password"}
                value={r.value}
                placeholder="valeur"
                spellCheck={false}
                onChange={(e) => setRow(i, { value: e.target.value })}
              />
              <button
                className="ctx-env-eye"
                title={reveal[i] ? "Masquer" : "Révéler"}
                onClick={() => setReveal((m) => ({ ...m, [i]: !m[i] }))}
              >
                {reveal[i] ? "🙈" : "👁"}
              </button>
              <button className="ctx-env-del" title="Supprimer" onClick={() => removeRow(i)}>
                <Icon name="x" size={11} />
              </button>
            </div>
          ))}
          <button className="ctx-env-addrow" onClick={addRow}>
            <Icon name="plus" size={11} /> Ajouter une variable
          </button>
        </div>
      )}
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
