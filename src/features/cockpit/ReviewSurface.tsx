// src/features/cockpit/ReviewSurface.tsx
// Lot C2.3 — toggle de portée (head / index / worktree) + actions par fichier
//            (stage / unstage / discard avec confirmation).
//
// Layout:
//   ┌──────────────────────────────────────────┐
//   │ [Portée: Non-commités | Indexé | Non-indexé]   header chips │
//   ├──────────────┬───────────────────────────┤
//   │ file list    │ unified diff              │
//   │ (actions per │ (UnifiedDiff renderer)    │
//   │  row)        │                           │
//   └──────────────┴───────────────────────────┘
//
// Gestures implemented:
//   - Row click              → select file → show its diff for the current scope
//   - Click on file NAME     → openFile(path) + setActiveSurface("editor")
//   - Ctrl+click diff line   → editor jump (from C2.2)
//   - Stage / Unstage / Discard buttons on each row (hover-visible)
//   - Portée chips           → switch DiffSource (head / index / worktree)

import { useState, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { useIsGitRepo, useGitStatus, useGitDiff } from "@/features/git/queries";
import { useStageFiles, useUnstageFiles, useDiscardFiles } from "@/features/git/mutations";
import { setActiveSurface } from "./layoutStore";
import { useShell } from "@/routes/shell-context";
import { UnifiedDiff } from "./UnifiedDiff";
import { requestReveal } from "./revealStore";
import type { DiffSource, GitFileStatus } from "@/lib/types";

// ---------------------------------------------------------------------------
// Helpers (mirror SideGit.tsx helpers to stay visually consistent)
// ---------------------------------------------------------------------------

function statusGlyph(s: GitFileStatus): { ch: string; color: string; title: string } {
  if (s.isConflicted) return { ch: "C", color: "var(--danger)", title: "Conflicted" };
  if (s.isUntracked) return { ch: "U", color: "var(--tertiary)", title: "Untracked" };
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

// ---------------------------------------------------------------------------
// Discard confirmation modal (mirrors SideGit.tsx DiscardConfirm)
// ---------------------------------------------------------------------------

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
        <div style={{ fontWeight: 600 }}>Annuler les modifications locales ?</div>
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
          Cette action est irréversible.
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="lgb lgb-sm" onClick={onCancel}>
            Annuler
          </button>
          <button
            className="lgb lgb-sm"
            style={{ borderColor: "rgba(255,106,138,0.4)", color: "var(--danger)" }}
            onClick={onConfirm}
          >
            Ignorer
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------------------
// Portée chips — scope toggle (head / index / worktree)
// ---------------------------------------------------------------------------

const SCOPE_OPTIONS: Array<{ vs: DiffSource; label: string; tooltip: string }> = [
  {
    vs: "head",
    label: "Non-commités",
    tooltip: "Toutes les modifications non-commitées (staged + non-staged vs HEAD)",
  },
  {
    vs: "index",
    label: "Indexé",
    tooltip: "Modifications préparées (staged) : ce qui sera inclus dans le prochain commit",
  },
  {
    vs: "worktree",
    label: "Non-indexé",
    tooltip: "Modifications non préparées (unstaged) : dans le répertoire de travail, hors index",
  },
];

function ScopeChips({
  vs,
  onChange,
}: {
  vs: DiffSource;
  onChange: (v: DiffSource) => void;
}): JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "6px 10px",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        flexShrink: 0,
        flexWrap: "wrap",
      }}
    >
      <span
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--on-surface-muted)",
          marginRight: 4,
        }}
      >
        Portée
      </span>
      {SCOPE_OPTIONS.map((opt) => {
        const active = vs === opt.vs;
        return (
          <button
            key={opt.vs}
            title={opt.tooltip}
            onClick={() => onChange(opt.vs)}
            style={{
              fontSize: 10,
              padding: "2px 8px",
              borderRadius: 10,
              border: active
                ? "1px solid var(--primary)"
                : "1px solid rgba(255,255,255,0.1)",
              background: active
                ? "rgba(var(--primary-rgb, 130,100,255), 0.18)"
                : "rgba(255,255,255,0.04)",
              color: active ? "var(--primary)" : "var(--on-surface-variant)",
              cursor: "pointer",
              fontWeight: active ? 600 : 400,
              transition: "background 0.1s, border-color 0.1s, color 0.1s",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FileList
// ---------------------------------------------------------------------------

interface FileListProps {
  files: GitFileStatus[];
  selected: string | null;
  onSelect: (path: string) => void;
  onOpenFile: (path: string) => void;
  onDiscard: (path: string) => void;
}

function FileList({
  files,
  selected,
  onSelect,
  onOpenFile,
  onDiscard,
}: FileListProps): JSX.Element {
  const stage = useStageFiles();
  const unstage = useUnstageFiles();

  return (
    <div
      style={{
        width: 220,
        minWidth: 160,
        maxWidth: 280,
        borderRight: "1px solid rgba(255,255,255,0.06)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* list header */}
      <div
        style={{
          padding: "8px 12px 4px",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--on-surface-muted)",
          borderBottom: "1px solid rgba(255,255,255,0.04)",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        <span style={{ flex: 1 }}>Fichiers modifiés</span>
        <span
          style={{
            background: "rgba(255,255,255,0.07)",
            borderRadius: 8,
            padding: "0 6px",
            fontSize: 10,
            color: "var(--on-surface-variant)",
          }}
        >
          {files.length}
        </span>
      </div>

      {/* scrollable file rows */}
      <div className="scroll" style={{ flex: 1, overflow: "auto" }}>
        {files.map((f) => {
          const g = statusGlyph(f);
          const name = basename(f.path);
          const dir = dirname(f.path);
          const isSelected = f.path === selected;

          // Action predicates (not mutually exclusive — partial staging)
          const canStage = f.worktreeStatus !== " " || f.isUntracked;
          const canUnstage = f.isStaged;
          const canDiscard = canStage;

          return (
            <div
              key={f.path}
              role="option"
              aria-selected={isSelected}
              onClick={() => onSelect(f.path)}
              className="rev-file-row"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 0,
                padding: "5px 6px 5px 10px",
                cursor: "pointer",
                background: isSelected
                  ? "rgba(var(--primary-rgb, 130,100,255), 0.18)"
                  : "transparent",
                borderLeft: isSelected
                  ? "2px solid var(--primary)"
                  : "2px solid transparent",
                transition: "background 0.1s",
                position: "relative",
              }}
            >
              {/* file name — click opens in editor */}
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  void onOpenFile(f.path);
                }}
                title={`Ouvrir ${f.path} dans l'éditeur`}
                style={{
                  flex: 1,
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  color: isSelected ? "var(--on-surface)" : "var(--on-surface-variant)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  gap: 1,
                  minWidth: 0,
                }}
              >
                <span style={{ fontWeight: isSelected ? 600 : 400 }}>{name}</span>
                {dir && (
                  <span
                    style={{
                      fontSize: 9,
                      color: "var(--on-surface-muted)",
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

              {/* status glyph */}
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: g.color,
                  marginLeft: 4,
                  flexShrink: 0,
                }}
                title={g.title}
              >
                {g.ch}
              </span>

              {/* per-file action cluster (visible on hover via CSS) */}
              <span
                className="rev-row-actions"
                onClick={(e) => e.stopPropagation()}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 2,
                  marginLeft: 4,
                  flexShrink: 0,
                }}
              >
                {canStage && (
                  <button
                    className="rev-act-btn"
                    title="Préparer (Stage)"
                    disabled={stage.isPending}
                    onClick={(e) => {
                      e.stopPropagation();
                      stage.mutate([f.path]);
                    }}
                    style={{
                      fontSize: 10,
                      padding: "1px 5px",
                      borderRadius: 4,
                      border: "1px solid rgba(255,255,255,0.12)",
                      background: "rgba(var(--success-rgb, 80,200,120), 0.12)",
                      color: "var(--success)",
                      cursor: "pointer",
                      lineHeight: 1.5,
                    }}
                  >
                    +
                  </button>
                )}
                {canUnstage && (
                  <button
                    className="rev-act-btn"
                    title="Annuler la préparation (Unstage)"
                    disabled={unstage.isPending}
                    onClick={(e) => {
                      e.stopPropagation();
                      unstage.mutate([f.path]);
                    }}
                    style={{
                      fontSize: 10,
                      padding: "1px 5px",
                      borderRadius: 4,
                      border: "1px solid rgba(255,255,255,0.12)",
                      background: "rgba(var(--warn-rgb, 255,200,50), 0.12)",
                      color: "var(--warn)",
                      cursor: "pointer",
                      lineHeight: 1.5,
                    }}
                  >
                    −
                  </button>
                )}
                {canDiscard && (
                  <button
                    className="rev-act-btn"
                    title="Ignorer les modifications non-indexées (irréversible)"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDiscard(f.path);
                    }}
                    style={{
                      fontSize: 10,
                      padding: "1px 5px",
                      borderRadius: 4,
                      border: "1px solid rgba(255,106,138,0.25)",
                      background: "rgba(255,106,138,0.08)",
                      color: "var(--danger)",
                      cursor: "pointer",
                      lineHeight: 1.5,
                    }}
                  >
                    ↺
                  </button>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DiffPane — fetches + renders the diff for the selected file
// ---------------------------------------------------------------------------

const SCOPE_LABEL: Record<DiffSource, string> = {
  head: "vs HEAD",
  index: "Indexé",
  worktree: "Non-indexé",
};

const SCOPE_LABEL_TITLE: Record<DiffSource, string> = {
  head: "HEAD → répertoire de travail (toutes modifications non-commitées, staged + non-staged)",
  index: "Index → HEAD (modifications préparées pour le prochain commit)",
  worktree: "Répertoire de travail → index (modifications non préparées)",
};

function DiffPane({
  path,
  vs,
  onRevealLine,
}: {
  path: string | null;
  vs: DiffSource;
  onRevealLine?: (line: number) => void;
}): JSX.Element {
  const { data: diff, isLoading, isError } = useGitDiff(path, vs);

  if (!path) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--on-surface-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
        }}
      >
        Sélectionnez un fichier
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflow: "hidden", position: "relative", display: "flex", flexDirection: "column" }}>
      {/* diff header */}
      <div
        style={{
          padding: "6px 12px",
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          color: "var(--on-surface-muted)",
          borderBottom: "1px solid rgba(255,255,255,0.04)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span style={{ color: "var(--on-surface-variant)" }}>{path}</span>
        <span
          style={{
            fontSize: 9,
            background: "rgba(255,255,255,0.06)",
            borderRadius: 4,
            padding: "1px 6px",
            color: "var(--on-surface-muted)",
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
          title={SCOPE_LABEL_TITLE[vs]}
        >
          {SCOPE_LABEL[vs]}
        </span>
      </div>

      {/* diff body */}
      <div style={{ flex: 1, overflow: "auto", position: "relative" }}>
        {isLoading && (
          <div
            style={{
              padding: "20px 16px",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--on-surface-muted)",
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span className="ring" style={{ width: 12, height: 12 }} />
            Chargement du diff…
          </div>
        )}
        {isError && (
          <div
            style={{
              padding: "16px",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "var(--danger)",
            }}
          >
            Erreur lors du chargement du diff.
          </div>
        )}
        {!isLoading && !isError && diff !== undefined && (
          diff.trim().length === 0 ? (
            <div
              style={{
                padding: "16px 20px",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--on-surface-muted)",
                fontStyle: "italic",
              }}
            >
              {vs === "head" && "Aucun diff vs HEAD — fichier peut-être non suivi (nouveau)."}
              {vs === "index" && "Aucune modification préparée (rien dans l'index)."}
              {vs === "worktree" && "Aucune modification non-préparée (working tree propre pour ce fichier)."}
            </div>
          ) : (
            <div style={{ position: "relative", minHeight: "100%" }}>
              <UnifiedDiff text={diff} onRevealLine={onRevealLine} />
            </div>
          )
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ReviewSurface
// ---------------------------------------------------------------------------

export function ReviewSurface(): JSX.Element {
  const isRepo = useIsGitRepo();
  const { data: status, isLoading } = useGitStatus();
  const { openFile } = useShell();
  const discard = useDiscardFiles();

  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [vs, setVs] = useState<DiffSource>("head");
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null);

  // Flatten all changed files (staged + unstaged + untracked).
  const allFiles = useMemo<GitFileStatus[]>(() => status ?? [], [status]);

  // Auto-select: pick first when selection is null or stale (file gone from status).
  useEffect(() => {
    if (allFiles.length === 0) {
      setSelectedPath(null);
      return;
    }
    const stillPresent = allFiles.some((f) => f.path === selectedPath);
    if (!stillPresent) {
      setSelectedPath(allFiles[0].path);
    }
  }, [allFiles, selectedPath]);

  const handleOpenFile = (path: string) => {
    void openFile(path)
      .then(() => setActiveSurface("editor"))
      .catch(() => {});
  };

  // C2.2 — Ctrl/Cmd+click on a diff line: open the file in the editor surface
  // at the clicked line. openFile is async (disk read + CodeMirror remount);
  // useRevealRunner (in SurfaceHost) polls until the view is ready before
  // dispatching the cursor + scroll.
  const handleRevealLine = (line: number) => {
    if (!selectedPath) return;
    void openFile(selectedPath)
      .then(() => {
        setActiveSurface("editor");
        requestReveal({ path: selectedPath, line });
      })
      .catch(() => {});
  };

  // ── not a git repo ────────────────────────────────────────────────────────
  if (!isRepo) {
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: 24,
          color: "var(--on-surface-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
        }}
      >
        Pas un dépôt git
      </div>
    );
  }

  // ── loading ───────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          color: "var(--on-surface-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
        }}
      >
        <span className="ring" style={{ width: 14, height: 14 }} />
        Chargement…
      </div>
    );
  }

  // ── no changes ────────────────────────────────────────────────────────────
  if (allFiles.length === 0) {
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: 24,
          color: "var(--on-surface-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
        }}
      >
        Working tree clean.
      </div>
    );
  }

  // ── main layout ──────────────────────────────────────────────────────────
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      {/* Portée toggle — full width across the top */}
      <ScopeChips vs={vs} onChange={setVs} />

      {/* file list + diff split */}
      <div style={{ flex: 1, display: "flex", flexDirection: "row", overflow: "hidden" }}>
        <FileList
          files={allFiles}
          selected={selectedPath}
          onSelect={setSelectedPath}
          onOpenFile={handleOpenFile}
          onDiscard={(path) => setConfirmDiscard(path)}
        />
        <DiffPane path={selectedPath} vs={vs} onRevealLine={handleRevealLine} />
      </div>

      {/* Discard confirmation modal */}
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
    </div>
  );
}
