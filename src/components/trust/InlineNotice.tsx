// Shugu Forge — InlineNotice (Lane 5, trust-ux).
//
// A single, consistent inline banner for "you should know this before acting"
// messages. Before this, the same warning UX was re-hand-rolled inline in every
// panel (the git-safety-net warning in AgentsPanel, ad-hoc error <div>s, etc.),
// each with slightly different colors/spacing. A consistent notice makes the
// confidence signal recognizable everywhere.
//
// `tone` drives color (info = cyan, warn = amber, danger = red, success = green).
// An optional `action` renders a real <button> (semantic) on the right — used
// for "Revérifier", "Ouvrir l'onglet Git", etc.

import React from "react";

export type NoticeTone = "info" | "warn" | "danger" | "success";

interface ToneMeta {
  glyph: string;
  color: string;
  tint: string;
  border: string;
}

const TONES: Record<NoticeTone, ToneMeta> = {
  info: {
    glyph: "ℹ️",
    color: "var(--tertiary, #81ecff)",
    tint: "rgba(129, 236, 255, 0.07)",
    border: "rgba(129, 236, 255, 0.22)",
  },
  warn: {
    glyph: "⚠️",
    color: "var(--warn, #ffcf6b)",
    tint: "rgba(255, 207, 107, 0.07)",
    border: "rgba(255, 207, 107, 0.26)",
  },
  danger: {
    glyph: "⛔",
    color: "var(--danger, #ff6a8a)",
    tint: "rgba(255, 106, 138, 0.07)",
    border: "rgba(255, 106, 138, 0.26)",
  },
  success: {
    glyph: "✅",
    color: "var(--success, #8aefc7)",
    tint: "rgba(138, 239, 199, 0.07)",
    border: "rgba(138, 239, 199, 0.24)",
  },
};

export function InlineNotice({
  tone = "info",
  title,
  children,
  action,
  className = "",
}: {
  tone?: NoticeTone;
  /** Optional bold lead line. */
  title?: string;
  /** Body content (string or rich nodes). */
  children?: React.ReactNode;
  /** Optional right-aligned action: a real button. */
  action?: { label: string; onClick: () => void; disabled?: boolean };
  className?: string;
}) {
  const meta = TONES[tone];
  return (
    <div
      className={`trust-notice trust-notice-${tone} ${className}`.trim()}
      role={tone === "danger" || tone === "warn" ? "alert" : "status"}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "8px 10px",
        borderRadius: 8,
        fontSize: 11,
        lineHeight: 1.5,
        color: "var(--on-surface, #ddd)",
        background: meta.tint,
        border: `1px solid ${meta.border}`,
      }}
    >
      <span aria-hidden="true" style={{ flexShrink: 0, lineHeight: 1.5 }}>
        {meta.glyph}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        {title && (
          <div style={{ fontWeight: 700, color: meta.color, marginBottom: children ? 3 : 0 }}>
            {title}
          </div>
        )}
        {children && <div style={{ color: "var(--on-surface-variant, #a5a0bf)" }}>{children}</div>}
      </div>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          disabled={action.disabled}
          style={{
            flexShrink: 0,
            fontSize: 10,
            fontWeight: 600,
            padding: "3px 10px",
            borderRadius: 6,
            background: "transparent",
            color: meta.color,
            border: `1px solid ${meta.border}`,
            cursor: action.disabled ? "default" : "pointer",
            opacity: action.disabled ? 0.5 : 1,
            fontFamily: "inherit",
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
