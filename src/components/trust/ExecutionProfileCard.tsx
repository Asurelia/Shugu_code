// Shugu Forge — ExecutionProfileCard (Lane 5, trust-ux).
//
// The explicit "what is this run allowed to do, and what's the safety net?" card
// that frames the Grounded Run launcher. The old launcher was a green box whose
// color read as *safe* — but a Grounded Run executes real commands and writes to
// disk. This card states the capability tier (via RiskBadge) and the state of the
// git safety net up front, so the green is honest: green here means "guarded",
// not "harmless".
//
// It's a presentational wrapper: the launcher controls (textarea, buttons) are
// passed as `children` so the card owns the *framing* (risk header + safety-net
// line) while the panel keeps owning the launch logic.

import React from "react";
import { RiskBadge } from "./RiskBadge";
import { InlineNotice } from "./InlineNotice";
import type { RiskLevel } from "./trust";

export interface SafetyNet {
  /** true = a real net exists (e.g. a git repo to revert from). */
  ok: boolean;
  /** Plain-language description of the net's state. */
  message: string;
  /** Optional re-check action (e.g. after `git init` / a commit). */
  onRecheck?: () => void;
}

export function ExecutionProfileCard({
  title,
  glyph,
  risk,
  summary,
  safetyNet,
  children,
}: {
  /** Card heading, e.g. "Grounded Run". */
  title: string;
  /** Decorative heading glyph, e.g. "🌱". */
  glyph?: string;
  /** Capability tier this profile runs at — drives the RiskBadge + accent. */
  risk: RiskLevel;
  /** One-line description of what the run does. */
  summary: React.ReactNode;
  /** Git (or other) safety-net status. Omit when not applicable. */
  safetyNet?: SafetyNet;
  /** The launcher controls (inputs + launch button). */
  children?: React.ReactNode;
}) {
  return (
    <section
      className={`trust-exec-card trust-exec-${risk}`}
      style={{
        marginBottom: 12,
        padding: 12,
        borderRadius: 10,
        background: "var(--surface-container-low, #12121e)",
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
          marginBottom: 6,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--on-surface, #ddd)" }}>
          {glyph ? `${glyph} ` : ""}
          {title}
        </span>
        <RiskBadge level={risk} size="sm" />
      </header>

      <div
        style={{
          fontSize: 10.5,
          color: "var(--on-surface-muted, #6e6a89)",
          lineHeight: 1.5,
          marginBottom: 10,
        }}
      >
        {summary}
      </div>

      {safetyNet && (
        <div style={{ marginBottom: 10 }}>
          {safetyNet.ok ? (
            <InlineNotice
              tone="success"
              action={
                safetyNet.onRecheck
                  ? { label: "Revérifier", onClick: safetyNet.onRecheck }
                  : undefined
              }
            >
              {safetyNet.message}
            </InlineNotice>
          ) : (
            <InlineNotice
              tone="warn"
              title="Filet de sécurité incomplet"
              action={
                safetyNet.onRecheck
                  ? { label: "Revérifier", onClick: safetyNet.onRecheck }
                  : undefined
              }
            >
              {safetyNet.message}
            </InlineNotice>
          )}
        </div>
      )}

      {children}
    </section>
  );
}
