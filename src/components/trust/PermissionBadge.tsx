// Shugu Forge — PermissionBadge (Lane 5, trust-ux).
//
// Replaces the ambiguous "🛡 local" chip under the composer. "local" conflated
// three different ideas (data stays on my machine / runs without the cloud /
// can-or-can't touch my files), so the user couldn't tell what was actually
// guaranteed. This badge states ONE precise permission fact, with a kind that
// drives a truthful color:
//
//   • "private"  — data/inference stays on this machine (privacy claim, cyan).
//   • "scoped"   — the agent can act, but only inside the open workspace (amber).
//   • "guarded"  — there IS a safety net (git) that makes actions reversible (green).
//
// It is a <button> when an onClick is supplied (e.g. to open the relevant
// settings/Git tab) and a plain <span> otherwise — never a div-with-onClick.

import React from "react";

export type PermissionKind = "private" | "readonly" | "scoped" | "guarded" | "direct";

interface PermMeta {
  glyph: string;
  color: string;
  tint: string;
  border: string;
}

const PERM: Record<PermissionKind, PermMeta> = {
  private: {
    glyph: "🔒",
    color: "var(--tertiary, #81ecff)",
    tint: "rgba(129, 236, 255, 0.07)",
    border: "rgba(129, 236, 255, 0.24)",
  },
  readonly: {
    glyph: "👁",
    color: "var(--tertiary, #81ecff)",
    tint: "rgba(129, 236, 255, 0.07)",
    border: "rgba(129, 236, 255, 0.24)",
  },
  scoped: {
    glyph: "📂",
    color: "var(--warn, #ffcf6b)",
    tint: "rgba(255, 207, 107, 0.07)",
    border: "rgba(255, 207, 107, 0.24)",
  },
  guarded: {
    glyph: "🛟",
    color: "var(--success, #8aefc7)",
    tint: "rgba(138, 239, 199, 0.07)",
    border: "rgba(138, 239, 199, 0.24)",
  },
  direct: {
    glyph: "⚡",
    color: "var(--danger, #ff6a8a)",
    tint: "rgba(255, 106, 138, 0.08)",
    border: "rgba(255, 106, 138, 0.28)",
  },
};

export function PermissionBadge({
  kind,
  label,
  title,
  onClick,
  className = "",
}: {
  kind: PermissionKind;
  /** The precise, plain-language permission statement (e.g. "Privé · sur ta machine"). */
  label: string;
  /** Hover tooltip — should expand on exactly what is and isn't guaranteed. */
  title?: string;
  /** When provided the badge becomes a real button (e.g. jump to Git/Settings). */
  onClick?: () => void;
  className?: string;
}) {
  const meta = PERM[kind];
  const sharedStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "3px 9px",
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 600,
    lineHeight: 1.2,
    color: meta.color,
    background: meta.tint,
    border: `1px solid ${meta.border}`,
    whiteSpace: "nowrap",
    fontFamily: "inherit",
  };
  const cls = `trust-perm-badge trust-perm-${kind} ${className}`.trim();
  const inner = (
    <>
      <span aria-hidden="true">{meta.glyph}</span>
      <span>{label}</span>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={cls}
        title={title ?? label}
        onClick={onClick}
        style={{ ...sharedStyle, cursor: "pointer" }}
      >
        {inner}
      </button>
    );
  }
  return (
    <span className={cls} title={title ?? label} style={sharedStyle}>
      {inner}
    </span>
  );
}
