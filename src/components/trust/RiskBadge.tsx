// Shugu Forge — RiskBadge (Lane 5, trust-ux).
//
// A small, color-coded pill that states a capability tier (read / write / exec)
// in plain language. Replaces the implicit "green = safe" signal of the old
// Grounded Run button: green stopped meaning "safe" and started meaning "go" —
// here the COLOR encodes blast radius (cyan reads, amber writes, red executes)
// and the text never lets the color be misread.
//
// Decorative-glyph + always-present text label = accessible (color is never the
// ONLY carrier of meaning). The optional title surfaces the full blurb on hover.

import React from "react";
import { RISK, type RiskLevel } from "./trust";

export function RiskBadge({
  level,
  size = "md",
  showBlurb = false,
  className = "",
  title,
}: {
  level: RiskLevel;
  /** "sm" for inline-in-meta usage, "md" for standalone. */
  size?: "sm" | "md";
  /** When true, append the full blurb after the label (used in cards). */
  showBlurb?: boolean;
  className?: string;
  /** Override the hover tooltip; defaults to the tier blurb. */
  title?: string;
}) {
  const meta = RISK[level];
  const pad = size === "sm" ? "1px 6px" : "3px 9px";
  const fontSize = size === "sm" ? 9.5 : 11;

  return (
    <span
      className={`trust-risk-badge trust-risk-${level} ${className}`.trim()}
      title={title ?? meta.blurb}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: pad,
        borderRadius: 999,
        fontSize,
        fontWeight: 700,
        letterSpacing: "0.02em",
        lineHeight: 1.2,
        color: meta.color,
        background: meta.tint,
        border: `1px solid ${meta.border}`,
        whiteSpace: "nowrap",
        maxWidth: "100%",
      }}
    >
      <span aria-hidden="true">{meta.glyph}</span>
      <span>{meta.label}</span>
      {showBlurb && (
        <span
          style={{
            fontWeight: 500,
            opacity: 0.85,
            color: "var(--on-surface-variant, #a5a0bf)",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {meta.blurb}
        </span>
      )}
    </span>
  );
}
