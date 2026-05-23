// Shugu Forge — SideGit (LOT 3 git-ui).
//
// VSCode-style Source Control panel. Vertical layout :
//   [Branch switcher]
//   [Commit box : textarea autosize + AI ✨ + Commit + Amend]
//   [Staged changes]
//   [Changes]
//   [Stashes (compact)]
//   [Remotes (compact)]
//   [Actions : Pull / Push / Fetch / Stash + ↑/↓ badges]
//
// State lives in TanStack Query (status, branches) + a tiny set of local
// component states (message, amend, dialog open, ctx menu). The compare
// flow leverages ShellContext.setCompareFile so the existing DiffView in
// views-code.tsx renders the file vs its HEAD.
//
// Clicking a staged or unstaged file sets `compareFile` to (HEAD, path)
// so the user sees the diff in the editor pane without leaving SideGit.

import { useState, useEffect, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/components";
import { useShell } from "@/routes/shell-context";
import { useGitStatus, useGitBranches, useIsGitRepo } from "./queries";
import {
  useStageFiles,
  useUnstageFiles,
  useDiscardFiles,
  useCommit,
  usePush,
  usePull,
  useFetch,
  useStashSave,
} from "./mutations";
import { useAICommit } from "./useAICommit";
import { BranchSwitcher } from "./components/BranchSwitcher";
import { CommitDialog } from "./components/CommitDialog";
import { openReviewDialog } from "./reviewDialogStore";
import { StashList } from "./components/StashList";
import { RemoteManager } from "./components/RemoteManager";
import type { GitFileStatus } from "@/lib/types";

// Conventional status → glyph + color triad (VSCode-faithful colors).
function statusGlyph(s: GitFileStatus): { ch: string; color: string; title: string } {
  if (s.isConflicted) return { ch: "C", color: "var(--danger)", title: "Conflicted" };
  if (s.isUntracked) return { ch: "U", color: "var(--tertiary)", title: "Untracked" };
  // Index status takes precedence in staged view; this helper is used for
  // both lists — caller passes the right row from the right filter.
  const c = (s.indexStatus !== " " ? s.indexStatus : s.worktreeStatus).toUpperCase();
  if (c === "M") return { ch: "M", color: "var(--warn)", title: "Modified" };
  if (c === "A") return { ch: "A", color: "var(--success)", title: "Added" };
  if (c === "D") return { ch: "D", color: "var(--danger)", title: "Deleted" };
  if (c === "R") return { ch: "R", color: "var(--primary)", title: "Renamed" };
  if (c === "C") return { ch: "C", color: "var(--primary)", title: "Copied" };
  if (c === "T") return { ch: "T", color: "var(--on-surface-variant)", title: "Type-changed" };
  return { ch: c || "?", color: "var(--on-surface-muted)", title: "Changed" };
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}
function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

interface CtxMenuState {
  kind: "staged" | "unstaged";
  path: string;
  x: number;
  y: number;
}

function CtxMenu({
  state,
  onClose,
  onAction,
}: {
  state: CtxMenuState;
  onClose: () => void;
  onAction: (action: string) => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={ref}
      className="file-ctx-menu"
      style={{ left: state.x, top: state.y }}
    >
      {state.kind === "unstaged" && (
        <button onClick={() => onAction("stage")}>Stage</button>
      )}
      {state.kind === "staged" && (
        <button onClick={() => onAction("unstage")}>Unstage</button>
      )}
      <button onClick={() => onAction("compare")}>Open Changes</button>
      <button onClick={() => onAction("open")}>Open File</button>
      {state.kind === "unstaged" && (
        <>
          <div className="file-ctx-sep" />
          <button className="danger" onClick={() => onAction("discard")}>
            Discard Changes
          </button>
        </>
      )}
      <div className="file-ctx-target">{state.path}</div>
    </div>,
    document.body,
  );
}

function DiscardConfirm({
  path,
  onCancel,
  onConfirm,
}: {
  path: string;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  return createPortal(
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9500,
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        style={{
          width: "min(420px, 92vw)",
          background:
            "linear-gradient(180deg, rgba(20,16,38,0.96), rgba(12,10,24,0.98))",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 12,
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ fontWeight: 600 }}>Discard local changes?</div>
        <div
          style={{
            fontSize: 12,
            color: "var(--on-surface-variant)",
            fontFamily: "var(--font-mono)",
            wordBreak: "break-all",
          }}
        >
          {path}
        </div>
        <div
          style={{
            fontSize: 11,
            color: "var(--warn)",
          }}
        >
          This cannot be undone.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="lgb lgb-sm" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="lgb lgb-sm"
            style={{ borderColor: "rgba(255,106,138,0.4)", color: "var(--danger)" }}
            onClick={onConfirm}
          >
            Discard
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function FileRow({
  row,
  onClick,
  onContextMenu,
}: {
  row: GitFileStatus;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}): JSX.Element {
  const g = statusGlyph(row);
  const name = basename(row.path);
  const dir = dirname(row.path);

  return (
    <div
      className="side-item"
      onClick={onClick}
      onContextMenu={onContextMenu}
      style={{ paddingLeft: 12 }}
    >
      <Icon name="file" size={11} className="ico" />
      <span
        className="label"
        style={{ display: "flex", alignItems: "baseline", gap: 6 }}
      >
        <span>{name}</span>
        {dir && (
          <span
            style={{
              fontSize: 10,
              color: "var(--on-surface-muted)",
              fontFamily: "var(--font-mono)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={dir}
          >
            {dir}
          </span>
        )}
      </span>
      <span
        className="meta"
        style={{ color: g.color, fontWeight: 600 }}
        title={g.title}
      >
        {g.ch}
      </span>
    </div>
  );
}

function CommitBox(): JSX.Element {
  const [message, setMessage] = useState("");
  const [amend, setAmend] = useState(false);
  const [showDialog, setShowDialog] = useState(false);
  const [justCommitted, setJustCommitted] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const { data: status } = useGitStatus();
  const commit = useCommit();
  const stage = useStageFiles();
  const ai = useAICommit();

  const changed = status ?? [];
  const stagedCount = changed.filter((s) => s.isStaged).length;
  const changedCount = changed.length;

  // Autosize the textarea : line-count clamped to [1, 8].
  useEffect(() => {
    const lines = (message.match(/\n/g)?.length ?? 0) + 1;
    if (taRef.current) {
      taRef.current.rows = Math.min(8, Math.max(1, lines));
    }
  }, [message]);

  const doCommit = async () => {
    const m = message.trim();
    if (!m) return;
    // Smart commit (façon VSCode) : si rien n'est préparé (staged) mais qu'il
    // y a des modifications, on les prépare TOUTES automatiquement avant de
    // commiter. Évite le piège "bouton grisé" pour qui ne connaît pas l'étape
    // de staging — cliquer "Tout commiter" suffit.
    if (stagedCount === 0 && !amend) {
      if (changedCount === 0) return;
      try {
        await stage.mutateAsync(changed.map((s) => s.path));
      } catch {
        return; // l'erreur de préparation s'affiche via stage.isError
      }
    }
    commit.mutate(
      { message: m, amend },
      {
        onSuccess: () => {
          setMessage("");
          setAmend(false);
          setJustCommitted(true);
          window.setTimeout(() => setJustCommitted(false), 2500);
        },
      },
    );
  };

  const runAI = async () => {
    const out = await ai.generate();
    if (out) setMessage(out);
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "8px 12px",
        borderBottom: "1px solid rgba(255,255,255,0.04)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <div
          style={{
            flex: 1,
            fontSize: 11,
            color: "var(--on-surface-muted)",
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          Message
        </div>
        <button
          className="lgb lgb-sm"
          title="Open verbose commit dialog (review staged diffs)"
          onClick={() => setShowDialog(true)}
          style={{ padding: "2px 8px" }}
        >
          <Icon name="diff" size={10} />
        </button>
      </div>
      <textarea
        ref={taRef}
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder={`Message (Ctrl+Enter to commit on '${"HEAD"}')`}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
            e.preventDefault();
            doCommit();
          }
        }}
        rows={1}
        style={{
          width: "100%",
          resize: "none",
          background: "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 6,
          padding: "6px 10px",
          color: "var(--on-surface)",
          font: "inherit",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          lineHeight: 1.4,
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button
          className="lgb lgb-sm"
          title="Generate commit message from staged diff via the active LLM"
          disabled={ai.isLoading || stagedCount === 0}
          onClick={runAI}
        >
          <Icon name="sparkle" size={11} />
          {ai.isLoading ? "AI…" : "AI"}
        </button>
        <button
          className="lgb lgb-sm"
          title="AI code review du diff (staged / toutes modifs)"
          disabled={changed.length === 0}
          onClick={() => openReviewDialog("index")}
        >
          <Icon name="shield" size={11} />
          Review
        </button>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: 11,
            color: "var(--on-surface-variant)",
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={amend}
            onChange={(e) => setAmend(e.target.checked)}
          />
          Amend
        </label>
        <div style={{ flex: 1 }} />
        <button
          className="lgb lgb-sm lgb-primary"
          disabled={
            commit.isPending ||
            stage.isPending ||
            !message.trim() ||
            (!amend && changedCount === 0)
          }
          onClick={doCommit}
          title={
            changedCount === 0 && !amend
              ? "Aucune modification à commiter"
              : stagedCount === 0
                ? `Préparer et commiter ${changedCount} fichier${changedCount !== 1 ? "s" : ""}`
                : `Commiter ${stagedCount} fichier${stagedCount !== 1 ? "s" : ""} préparé${stagedCount !== 1 ? "s" : ""}`
          }
        >
          {commit.isPending
            ? "Commit…"
            : stage.isPending
              ? "Préparation…"
              : amend
                ? "Amend"
                : stagedCount === 0 && changedCount > 0
                  ? "Tout commiter"
                  : "Commit"}
        </button>
      </div>
      {ai.error && (
        <div
          style={{
            fontSize: 10,
            color: "var(--danger)",
            fontFamily: "var(--font-mono)",
          }}
        >
          AI: {ai.error}
        </div>
      )}
      {(commit.isError || stage.isError) && (
        <div
          style={{
            fontSize: 10,
            color: "var(--danger)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {String(commit.error ?? stage.error)}
        </div>
      )}
      {justCommitted && (
        <div
          style={{
            fontSize: 10,
            color: "var(--success)",
            fontFamily: "var(--font-mono)",
          }}
        >
          ✓ Commit créé
        </div>
      )}
      {showDialog && (
        <CommitDialog
          initialMessage={message}
          amend={amend}
          onClose={() => setShowDialog(false)}
        />
      )}
    </div>
  );
}

function StagedChangesList({
  rows,
  onPick,
  onCtx,
}: {
  rows: GitFileStatus[];
  onPick: (path: string) => void;
  onCtx: (state: CtxMenuState) => void;
}): JSX.Element | null {
  const unstage = useUnstageFiles();
  if (rows.length === 0) return null;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "8px 12px 4px",
        }}
      >
        <div
          style={{
            flex: 1,
            fontSize: 11,
            color: "var(--on-surface-muted)",
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          Staged Changes
        </div>
        <span
          className="chip"
          style={{ padding: "0 6px", fontSize: 10 }}
          title={`${rows.length} staged`}
        >
          {rows.length}
        </span>
        <button
          className="lgb lgb-sm"
          title="Unstage all"
          onClick={() => unstage.mutate(rows.map((r) => r.path))}
          disabled={unstage.isPending}
          style={{ padding: "2px 8px", marginLeft: 6 }}
        >
          −
        </button>
      </div>
      {rows.map((r) => (
        <FileRow
          key={`s-${r.path}`}
          row={r}
          onClick={() => onPick(r.path)}
          onContextMenu={(e) => {
            e.preventDefault();
            onCtx({ kind: "staged", path: r.path, x: e.clientX, y: e.clientY });
          }}
        />
      ))}
    </div>
  );
}

function ChangesList({
  rows,
  onPick,
  onCtx,
}: {
  rows: GitFileStatus[];
  onPick: (path: string) => void;
  onCtx: (state: CtxMenuState) => void;
}): JSX.Element | null {
  const stage = useStageFiles();
  if (rows.length === 0) return null;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "8px 12px 4px",
        }}
      >
        <div
          style={{
            flex: 1,
            fontSize: 11,
            color: "var(--on-surface-muted)",
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          Changes
        </div>
        <span
          className="chip"
          style={{ padding: "0 6px", fontSize: 10 }}
          title={`${rows.length} changed`}
        >
          {rows.length}
        </span>
        <button
          className="lgb lgb-sm"
          title="Stage all"
          onClick={() => stage.mutate(rows.map((r) => r.path))}
          disabled={stage.isPending}
          style={{ padding: "2px 8px", marginLeft: 6 }}
        >
          +
        </button>
      </div>
      {rows.map((r) => (
        <FileRow
          key={`c-${r.path}`}
          row={r}
          onClick={() => onPick(r.path)}
          onContextMenu={(e) => {
            e.preventDefault();
            onCtx({ kind: "unstaged", path: r.path, x: e.clientX, y: e.clientY });
          }}
        />
      ))}
    </div>
  );
}

function ActionsBar(): JSX.Element {
  const { data: branches } = useGitBranches();
  const push = usePush();
  const pull = usePull();
  const fetchM = useFetch();
  const stashSave = useStashSave();

  const head = branches?.local.find((b) => b.name === branches?.current);
  const ahead = head?.ahead ?? 0;
  const behind = head?.behind ?? 0;
  // Best-effort remote name. The contract has no per-branch "remote"
  // field other than `upstream` which is "origin/main" style.
  const remote = head?.upstream?.split("/")[0] ?? "origin";
  const branch = branches?.current ?? "";

  const canRemote = Boolean(branch);

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 6,
        padding: 12,
        borderTop: "1px solid rgba(255,255,255,0.04)",
      }}
    >
      <button
        className="lgb lgb-sm"
        disabled={!canRemote || pull.isPending}
        onClick={() => pull.mutate({ remote, branch })}
        title={`git pull ${remote} ${branch}`}
      >
        <Icon name="pull" size={11} /> Pull
        {behind > 0 && (
          <span style={{ marginLeft: 4, color: "var(--tertiary)" }}>↓{behind}</span>
        )}
      </button>
      <button
        className="lgb lgb-sm"
        disabled={!canRemote || push.isPending}
        onClick={() => push.mutate({ remote, branch })}
        title={`git push ${remote} ${branch}`}
      >
        <Icon name="push" size={11} /> Push
        {ahead > 0 && (
          <span style={{ marginLeft: 4, color: "var(--success)" }}>↑{ahead}</span>
        )}
      </button>
      <button
        className="lgb lgb-sm"
        disabled={fetchM.isPending}
        onClick={() => fetchM.mutate(remote)}
        title="git fetch"
      >
        <Icon name="download" size={11} /> Fetch
      </button>
      <button
        className="lgb lgb-sm"
        disabled={stashSave.isPending}
        onClick={() => stashSave.mutate(null)}
        title="git stash"
      >
        <Icon name="stash" size={11} /> Stash
      </button>
    </div>
  );
}

export function SideGit(): JSX.Element {
  const { setCompareFile, openFile } = useShell();
  const isRepo = useIsGitRepo();
  const { data: status, isLoading } = useGitStatus();
  const stage = useStageFiles();
  const unstage = useUnstageFiles();
  const discard = useDiscardFiles();
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);

  const { staged, changes } = useMemo(() => {
    const s: GitFileStatus[] = [];
    const c: GitFileStatus[] = [];
    for (const r of status ?? []) {
      if (r.isStaged) s.push(r);
      if (r.worktreeStatus !== " " || r.isUntracked) c.push(r);
    }
    return { staged: s, changes: c };
  }, [status]);

  const openCompare = (path: string) => {
    // Reuse the existing 2-pane MergeView in views-code.tsx by setting
    // ShellContext.compareFile. We use the working-tree file as the
    // "right" side and the same path as the "left" side — the DiffView
    // internally fetches HEAD via useGitHead when comparing identical
    // paths. Until that special-case lands, we still show the file vs
    // itself which is a no-op visual diff. The user can open the file
    // instead via the context menu.
    setCompareFile({ left: path, right: path });
  };

  const onCtxAction = (action: string) => {
    if (!ctxMenu) return;
    const path = ctxMenu.path;
    setCtxMenu(null);
    if (action === "stage") stage.mutate([path]);
    else if (action === "unstage") unstage.mutate([path]);
    else if (action === "discard") setConfirmDiscard(path);
    else if (action === "compare") openCompare(path);
    else if (action === "open") void openFile(path).catch(() => {});
  };

  if (!isRepo) {
    return (
      <aside className="side">
        <div className="side-head">
          <div className="side-title">Source Control</div>
        </div>
        <div
          className="side-list scroll"
          style={{ padding: 24, textAlign: "center" }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
              color: "var(--on-surface-muted)",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
            }}
          >
            <Icon name="git" size={28} />
            <div>Not a git repository</div>
            <div style={{ opacity: 0.6, fontSize: 11 }}>
              Open a folder that contains a .git/ to enable Source Control.
            </div>
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="side">
      <div className="side-head">
        <div className="side-title">Source Control</div>
      </div>
      <div className="side-list scroll" style={{ padding: 0 }}>
        <div style={{ padding: "8px 12px" }}>
          <BranchSwitcher />
        </div>
        <CommitBox />
        {isLoading && (
          <div
            style={{
              padding: 12,
              fontSize: 11,
              color: "var(--on-surface-muted)",
              fontFamily: "var(--font-mono)",
            }}
          >
            Loading status…
          </div>
        )}
        <StagedChangesList
          rows={staged}
          onPick={openCompare}
          onCtx={setCtxMenu}
        />
        <ChangesList rows={changes} onPick={openCompare} onCtx={setCtxMenu} />
        {!isLoading && staged.length === 0 && changes.length === 0 && (
          <div
            style={{
              padding: "8px 12px",
              fontSize: 11,
              color: "var(--on-surface-muted)",
              fontFamily: "var(--font-mono)",
            }}
          >
            Working tree clean.
          </div>
        )}
        <StashList />
        <RemoteManager />
      </div>
      <ActionsBar />
      {ctxMenu && (
        <CtxMenu
          state={ctxMenu}
          onClose={() => setCtxMenu(null)}
          onAction={onCtxAction}
        />
      )}
      {confirmDiscard && (
        <DiscardConfirm
          path={confirmDiscard}
          onCancel={() => setConfirmDiscard(null)}
          onConfirm={() => {
            const p = confirmDiscard;
            setConfirmDiscard(null);
            discard.mutate([p]);
          }}
        />
      )}
    </aside>
  );
}
