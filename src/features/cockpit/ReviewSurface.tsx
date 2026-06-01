// src/features/cockpit/ReviewSurface.tsx
// Lot C2.1 — real read-only git diff view for the Révision surface.
//
// Layout:
//   ┌──────────────────────────────────────────┐
//   │ Révision header                          │
//   ├──────────────┬───────────────────────────┤
//   │ file list    │ unified diff              │
//   │ (compact)    │ (UnifiedDiff renderer)    │
//   └──────────────┴───────────────────────────┘
//
// Gestures implemented (C2.1):
//   - Row click          → select file → show its worktree diff
//   - Click on file NAME → openFile(path) + setActiveSurface("editor")
//   - Auto-select first file on mount / when selection goes stale
//
// Deferred (later slices): stage/revert, portée toggle (head/index/worktree),
// hunk-level actions, Cmd+click→line, hover "+"→agent comment.

import { useState, useEffect, useMemo } from "react";
import { useIsGitRepo, useGitStatus, useGitDiff } from "@/features/git/queries";
import { setActiveSurface } from "./layoutStore";
import { useShell } from "@/routes/shell-context";
import { UnifiedDiff } from "./UnifiedDiff";
import type { GitFileStatus } from "@/lib/types";

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
// FileList
// ---------------------------------------------------------------------------

interface FileListProps {
  files: GitFileStatus[];
  selected: string | null;
  onSelect: (path: string) => void;
  onOpenFile: (path: string) => void;
}

function FileList({ files, selected, onSelect, onOpenFile }: FileListProps): JSX.Element {
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

          return (
            <div
              key={f.path}
              role="option"
              aria-selected={isSelected}
              onClick={() => onSelect(f.path)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 0,
                padding: "5px 8px 5px 10px",
                cursor: "pointer",
                background: isSelected
                  ? "rgba(var(--primary-rgb, 130,100,255), 0.18)"
                  : "transparent",
                borderLeft: isSelected
                  ? "2px solid var(--primary)"
                  : "2px solid transparent",
                transition: "background 0.1s",
              }}
            >
              {/* file name — click opens in editor */}
              <span
                onClick={(e) => {
                  e.stopPropagation(); // don't re-trigger row select
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
                  marginLeft: 6,
                  flexShrink: 0,
                }}
                title={g.title}
              >
                {g.ch}
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

function DiffPane({ path }: { path: string | null }): JSX.Element {
  // NOTE: vs="worktree" = diff_index_to_workdir (working tree vs index).
  // A fully-staged file with no additional worktree changes will show an
  // empty diff here. The portée toggle (head/index/worktree) lands in a
  // later slice to address this case.
  const { data: diff, isLoading, isError } = useGitDiff(path, "worktree");

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
        >
          worktree
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
              Aucune modification dans le répertoire de travail.
              {/* Note: fichier peut être entièrement dans l'index (staged). */}
            </div>
          ) : (
            <div style={{ position: "relative", minHeight: "100%" }}>
              <UnifiedDiff text={diff} />
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

  const [selectedPath, setSelectedPath] = useState<string | null>(null);

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
        flexDirection: "row",
        overflow: "hidden",
      }}
    >
      <FileList
        files={allFiles}
        selected={selectedPath}
        onSelect={setSelectedPath}
        onOpenFile={handleOpenFile}
      />
      <DiffPane path={selectedPath} />
    </div>
  );
}
