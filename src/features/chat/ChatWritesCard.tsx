// src/features/chat/ChatWritesCard.tsx
// Lot C3 — Carte d'opération in-chat façon Codex : "✏️ N fichier(s) modifié(s)"
// avec liste dépliable des fichiers écrits + diff par fichier vs HEAD + bouton
// Annuler ↺ (même comportement que l'ancien RevertWritesButton).
//
// Architecture :
//   ChatWritesCard  — card principale, lit useChatWrites(messageId), affiche le
//                     header + bouton Annuler + liste des fichiers.
//   ChatWriteFileRow — une ligne par ChatWriteRecord, possède son propre état
//                      d'expansion + appelle useGitDiff (un hook par instance,
//                      conforme aux règles des hooks React). Monté lazily.

import React, { useState, useCallback } from "react";
import { invoke } from "@/lib/tauri";
import { useChatWrites, setChatWrites } from "./chatWritesStore";
import type { ChatWriteRecord } from "./chatWritesStore";
import { useGitDiff } from "@/features/git/queries";
import { useIsGitRepo } from "@/features/git/queries";
import { UnifiedDiff } from "@/features/cockpit/UnifiedDiff";

// ---------------------------------------------------------------------------
// Per-file row — one hook call per instance (hooks-rule safe)
// ---------------------------------------------------------------------------

interface ChatWriteFileRowProps {
  record: ChatWriteRecord;
  onOpenFile: (path: string) => void;
}

function ChatWriteFileRow({ record, onOpenFile }: ChatWriteFileRowProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const isRepo = useIsGitRepo();

  // Diff vs HEAD — only fetched once the row is expanded (enabled gate).
  // `useGitDiff` is called unconditionally (hooks rules) but gated by `enabled`
  // inside the hook itself (isRepo && path !== null). When not a git repo,
  // data remains undefined and we show the "pas un dépôt git" note.
  const { data: diffText, isLoading: diffLoading } = useGitDiff(
    expanded ? record.path : null,
    "head",
  );

  // Glyph: created (before == null/undefined) vs modified.
  const isCreated = record.before == null;
  const glyph = isCreated ? "+" : "~";
  const glyphTitle = isCreated ? "Fichier créé" : "Fichier modifié";

  // Display just the filename (last path segment) with the full path as title.
  const segments = record.path.replace(/\\/g, "/").split("/");
  const filename = segments[segments.length - 1] ?? record.path;
  const dir = segments.length > 1 ? segments.slice(0, -1).join("/") + "/" : "";

  return (
    <div
      style={{
        borderTop: "1px solid rgba(255,255,255,0.05)",
      }}
    >
      {/* File row header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 10px",
          cursor: "pointer",
          userSelect: "none",
        }}
        onClick={() => setExpanded((e) => !e)}
        title={record.path}
      >
        {/* Expand arrow */}
        <span
          style={{
            fontSize: 9,
            color: "var(--on-surface-muted)",
            transition: "transform 0.15s",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            display: "inline-block",
            width: 10,
            flexShrink: 0,
          }}
        >
          ▶
        </span>
        {/* Created / modified glyph */}
        <span
          title={glyphTitle}
          style={{
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            fontWeight: 700,
            color: isCreated ? "var(--success)" : "var(--secondary, #a78bfa)",
            flexShrink: 0,
            width: 12,
            textAlign: "center",
          }}
        >
          {glyph}
        </span>
        {/* Path */}
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
          }}
        >
          {dir && (
            <span style={{ color: "var(--on-surface-muted)" }}>{dir}</span>
          )}
          <span style={{ color: "var(--on-surface)" }}>{filename}</span>
        </span>
        {/* Open in editor button (stop propagation so it doesn't toggle expand) */}
        <button
          type="button"
          title="Ouvrir dans l'éditeur"
          onClick={(e) => {
            e.stopPropagation();
            onOpenFile(record.path);
          }}
          style={{
            flexShrink: 0,
            background: "none",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 4,
            color: "var(--on-surface-muted)",
            cursor: "pointer",
            fontSize: 10,
            padding: "1px 6px",
            lineHeight: "16px",
            opacity: 0.7,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = "1"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.opacity = "0.7"; }}
        >
          Ouvrir ›
        </button>
      </div>

      {/* Collapsible diff section */}
      {expanded && (
        <div
          style={{
            position: "relative",
            maxHeight: 300,
            overflowY: "auto",
            borderTop: "1px solid rgba(255,255,255,0.04)",
            background: "rgba(0,0,0,0.18)",
          }}
        >
          {diffLoading ? (
            <div
              style={{
                padding: "12px 16px",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--on-surface-muted)",
                fontStyle: "italic",
              }}
            >
              Chargement du diff…
            </div>
          ) : !isRepo ? (
            <div
              style={{
                padding: "12px 16px",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--on-surface-muted)",
                fontStyle: "italic",
              }}
            >
              diff indisponible (pas un dépôt git)
            </div>
          ) : typeof diffText === "string" ? (
            <div style={{ position: "relative", minHeight: 40 }}>
              <UnifiedDiff text={diffText} />
            </div>
          ) : (
            <div
              style={{
                padding: "12px 16px",
                fontFamily: "var(--font-mono)",
                fontSize: 11,
                color: "var(--on-surface-muted)",
                fontStyle: "italic",
              }}
            >
              diff indisponible
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main card
// ---------------------------------------------------------------------------

interface ChatWritesCardProps {
  messageId: string;
  /** onOpenFile handler from the parent CxMessage (uses handleOpenFile → in-chat split). */
  onOpenFile: (path: string) => void;
}

export function ChatWritesCard({ messageId, onOpenFile }: ChatWritesCardProps): JSX.Element | null {
  const records = useChatWrites(messageId);
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Return null when there are no records (same condition as the old button).
  if (records.length === 0) return null;

  const n = records.length;

  // Revert logic — byte-identical to the old RevertWritesButton:
  //   1. invoke("chat_revert_writes", { records }) — backend restores each file.
  //   2. setChatWrites(messageId, []) — clears the store → card disappears.
  //   3. emit("workspace://changed") — refreshes the file tree / editor (best-effort).
  const onRevert = () => {
    setBusy(true);
    setErr(null);
    void (async () => {
      try {
        await invoke("chat_revert_writes", { records });
        setChatWrites(messageId, []); // retire la carte
        try {
          const mod = await import("@tauri-apps/api/event");
          await mod.emit("workspace://changed", {});
        } catch (e) {
          console.warn("[chat] workspace://changed emit failed:", e);
        }
      } catch (e) {
        setErr(String(e));
        setBusy(false);
      }
    })();
  };

  return (
    <div
      className="cx-revert"
      style={{
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 8,
        overflow: "hidden",
        margin: "8px 0 4px",
        background: "rgba(20,16,38,0.55)",
        backdropFilter: "blur(8px)",
      }}
    >
      {/* Card header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "7px 10px",
          cursor: "pointer",
          userSelect: "none",
        }}
        onClick={() => setOpen((o) => !o)}
      >
        {/* Collapse arrow */}
        <span
          style={{
            fontSize: 9,
            color: "var(--on-surface-muted)",
            transition: "transform 0.15s",
            transform: open ? "rotate(90deg)" : "rotate(0deg)",
            display: "inline-block",
            width: 10,
            flexShrink: 0,
          }}
        >
          ▶
        </span>

        {/* Title */}
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "var(--on-surface)",
            flex: 1,
          }}
        >
          ✏️ {n} fichier{n > 1 ? "s" : ""} modifié{n > 1 ? "s" : ""}
        </span>

        {/* Annuler button — stop propagation so it doesn't toggle the card */}
        <button
          type="button"
          className="cx-revert-btn"
          onClick={(e) => {
            e.stopPropagation();
            onRevert();
          }}
          disabled={busy}
          title="Restaure les fichiers à leur état d'avant ce message"
          style={{
            flexShrink: 0,
          }}
        >
          {busy ? "Annulation…" : "Annuler ↺"}
        </button>
      </div>

      {/* Error display */}
      {err && (
        <div style={{ padding: "4px 10px" }}>
          <span className="cx-revert-err">⚠ {err}</span>
        </div>
      )}

      {/* File list */}
      {open && (
        <div>
          {records.map((record) => (
            <ChatWriteFileRow
              key={record.path}
              record={record}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}
