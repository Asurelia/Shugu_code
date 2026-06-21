// Shugu Forge — ModeBadge (Lane 5, trust-ux).
//
// The Ask/Plan/Act pill shown in each agent message's meta row, so the reader
// can tell at a glance HOW the agent was operating (read-only Plan vs full Act).
// Internally the modes are chat/plan/agent (chat-sync's ChatMode); the badge
// surfaces the Claude-Code Ask/Plan/Act wording and a risk-colored dot.
//
// Color encodes the same blast-radius taxonomy as RiskBadge (read=cyan,
// exec=red), so a glance at the dot says "this turn could run commands" before
// you read a single word.

import React from "react";
import { MODE_META, RISK, toTrustMode } from "./trust";

export function ModeBadge({
  mode,
  className = "",
}: {
  /** A ChatMode value ("chat" | "plan" | "agent"); anything else falls back to "agent". */
  mode: string | null | undefined;
  className?: string;
}) {
  const m = toTrustMode(mode);
  const meta = MODE_META[m];
  const risk = RISK[meta.risk];

  return (
    <span
      className={`trust-mode-badge trust-mode-${m} ${className}`.trim()}
      title={`Mode ${meta.badge} (${meta.label}) — ${risk.blurb}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 7px",
        borderRadius: 999,
        fontSize: 9,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        fontFamily: "var(--font-mono, monospace)",
        lineHeight: 1.4,
        color: risk.color,
        background: risk.tint,
        border: `1px solid ${risk.border}`,
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 5,
          height: 5,
          borderRadius: "50%",
          background: risk.color,
        }}
      />
      {meta.badge}
    </span>
  );
}
