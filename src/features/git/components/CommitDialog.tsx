// Shugu Forge — CommitDialog (LOT 3 git-ui).
//
// VSCode-flavored "verbose commit" modal : shows the list of staged files
// + a unified diff preview per file, with a multi-line message textarea
// at the bottom. Useful when the inline CommitBox is too cramped to
// review a multi-file commit.
//
// Open via the kebab menu on the CommitBox header (SideGit). Closes on
// Escape, outside-click, or after a successful commit.
//
// Only renders staged-file diffs (`vs="index"`). Each file is collapsed
// by default — click the header to expand. We lazy-fetch the diff only
// when the file is expanded so opening the modal stays cheap with 100+
// staged files.

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/components";
import { useGitStatus, useGitDiff } from "@/features/git/queries";
import { useCommit } from "@/features/git/mutations";

function FileDiffRow({ path }: { path: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  // `useGitDiff` is gated by `enabled: path !== null` ; we always pass a
  // real path so it triggers once the row is mounted. To keep the modal
  // light at 50+ staged files, render the diff only when expanded —
  // TanStack caches the result so the second open is instant.
  const { data: diff, isLoading } = useGitDiff(expanded ? path : null, "index");

  return (
    <div
      style={{
        border: "1px solid rgba(255,255,255,0.06)",
        borderRadius: 8,
        marginBottom: 6,
        background: "rgba(255,255,255,0.02)",
      }}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "6px 10px",
          background: "transparent",
          border: 0,
          color: "var(--on-surface)",
          font: "inherit",
          fontSize: 12,
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ width: 10 }}>{expanded ? "▾" : "▸"}</span>
        <Icon name="file" size={11} />
        <span
          style={{
            flex: 1,
            fontFamily: "var(--font-mono)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {path}
        </span>
      </button>
      {expanded && (
        <pre
          style={{
            margin: 0,
            padding: "8px 12px",
            background: "rgba(0,0,0,0.18)",
            borderTop: "1px solid rgba(255,255,255,0.04)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            color: "var(--on-surface-variant)",
            maxHeight: 200,
            overflow: "auto",
            whiteSpace: "pre",
          }}
        >
          {isLoading
            ? "Loading…"
            : diff && diff.trim().length > 0
              ? diff
              : "(no textual diff)"}
        </pre>
      )}
    </div>
  );
}

export function CommitDialog({
  initialMessage,
  amend,
  onClose,
}: {
  initialMessage: string;
  amend: boolean;
  onClose: () => void;
}): JSX.Element {
  const [message, setMessage] = useState(initialMessage);
  const [doAmend, setDoAmend] = useState(amend);
  const { data: status } = useGitStatus();
  const commit = useCommit();

  const stagedFiles = (status ?? []).filter((s) => s.isStaged);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !commit.isPending) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, commit.isPending]);

  const submit = () => {
    const msg = message.trim();
    if (!msg) return;
    commit.mutate(
      { message: msg, amend: doAmend },
      { onSuccess: () => onClose() },
    );
  };

  return createPortal(
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget && !commit.isPending) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9500,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.55)",
        backdropFilter: "blur(4px)",
      }}
    >
      <div
        style={{
          width: "min(720px, 90vw)",
          maxHeight: "85vh",
          display: "flex",
          flexDirection: "column",
          background:
            "linear-gradient(180deg, rgba(20,16,38,0.96), rgba(12,10,24,0.98))",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 14,
          boxShadow: "0 24px 60px rgba(0,0,0,0.6)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <Icon name="commit" size={14} />
          <div style={{ flex: 1, fontWeight: 600 }}>
            Commit {stagedFiles.length} file{stagedFiles.length !== 1 ? "s" : ""}
          </div>
          <button
            onClick={onClose}
            disabled={commit.isPending}
            className="lgb lgb-sm"
            title="Close"
            style={{ padding: "4px 8px" }}
          >
            <Icon name="x" size={11} />
          </button>
        </div>

        <div
          className="scroll"
          style={{
            flex: 1,
            overflow: "auto",
            padding: 12,
          }}
        >
          {stagedFiles.length === 0 ? (
            <div
              style={{
                padding: 32,
                color: "var(--on-surface-muted)",
                textAlign: "center",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
              }}
            >
              No staged changes.
            </div>
          ) : (
            stagedFiles.map((s) => <FileDiffRow key={s.path} path={s.path} />)
          )}
        </div>

        <div
          style={{
            padding: 12,
            borderTop: "1px solid rgba(255,255,255,0.06)",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Commit message (first line = summary)"
            rows={4}
            style={{
              width: "100%",
              resize: "vertical",
              minHeight: 60,
              background: "rgba(255,255,255,0.04)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: 8,
              padding: "8px 10px",
              color: "var(--on-surface)",
              font: "inherit",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
            }}
          />
          <div
            style={{ display: "flex", alignItems: "center", gap: 12 }}
          >
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 12,
                color: "var(--on-surface-variant)",
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={doAmend}
                onChange={(e) => setDoAmend(e.target.checked)}
              />
              Amend last commit
            </label>
            <div style={{ flex: 1 }} />
            {commit.isError && (
              <span
                style={{
                  color: "var(--danger)",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                }}
              >
                {String(commit.error)}
              </span>
            )}
            <button
              onClick={onClose}
              disabled={commit.isPending}
              className="lgb lgb-sm"
            >
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={commit.isPending || !message.trim() || stagedFiles.length === 0}
              className="lgb lgb-sm lgb-primary"
            >
              {commit.isPending ? "Committing…" : doAmend ? "Amend" : "Commit"}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
