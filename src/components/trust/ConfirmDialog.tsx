// Shugu Forge — ConfirmDialog (Lane 5, trust-ux).
//
// A focused, accessible "are you sure?" modal for actions whose blast radius the
// user should acknowledge BEFORE they happen (e.g. launching a run that will
// execute real commands without a git safety net). Generalizes the bespoke
// FileDeleteConfirm pattern already in components.tsx into a reusable primitive
// the trust surfaces can share.
//
// Accessibility:
//   • role="dialog" + aria-modal + aria-labelledby/‑describedby.
//   • Escape cancels; backdrop click cancels.
//   • The confirm button is auto-focused on mount so Enter confirms.
//   • Real <button> elements (no div-onClick).
//   • `tone="danger"` paints the confirm button red for irreversible/risky ops.

import React, { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = "Confirmer",
  cancelLabel = "Annuler",
  tone = "default",
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" → red confirm button for risky/irreversible actions. */
  tone?: "default" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    // Focus the confirm button so Enter confirms and focus is trapped at the
    // start of the dialog (keyboard users land inside, not behind, the modal).
    const t = window.setTimeout(() => confirmRef.current?.focus(), 0);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.clearTimeout(t);
    };
  }, [open, onCancel]);

  if (!open) return null;

  const accent = tone === "danger" ? "var(--danger, #ff6a8a)" : "var(--primary, #e08efe)";
  const confirmBg =
    tone === "danger" ? "rgba(255, 106, 138, 0.16)" : "rgba(224, 142, 254, 0.16)";
  const confirmBorder =
    tone === "danger" ? "rgba(255, 106, 138, 0.45)" : "rgba(224, 142, 254, 0.45)";

  return createPortal(
    <div
      className="trust-confirm-overlay"
      onClick={onCancel}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(5, 5, 12, 0.55)",
        backdropFilter: "blur(2px)",
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={body ? bodyId : undefined}
        className={`trust-confirm-modal trust-confirm-${tone}`}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(420px, calc(100vw - 48px))",
          padding: 18,
          borderRadius: 12,
          background: "var(--surface-container, #16162a)",
          border: `1px solid ${confirmBorder}`,
          boxShadow: "0 18px 50px rgba(0,0,0,0.5)",
        }}
      >
        <h3
          id={titleId}
          style={{
            margin: 0,
            fontSize: 14,
            fontWeight: 700,
            color: accent,
            display: "flex",
            alignItems: "center",
            gap: 7,
          }}
        >
          {tone === "danger" && <span aria-hidden="true">⚠️</span>}
          {title}
        </h3>
        {body && (
          <div
            id={bodyId}
            style={{
              marginTop: 10,
              fontSize: 12,
              lineHeight: 1.55,
              color: "var(--on-surface-variant, #a5a0bf)",
            }}
          >
            {body}
          </div>
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 18,
          }}
        >
          <button
            type="button"
            onClick={onCancel}
            style={{
              fontSize: 12,
              fontWeight: 600,
              padding: "6px 14px",
              borderRadius: 7,
              background: "transparent",
              color: "var(--on-surface-variant, #a5a0bf)",
              border: "1px solid rgba(150,150,150,0.28)",
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            ref={confirmRef}
            onClick={onConfirm}
            style={{
              fontSize: 12,
              fontWeight: 700,
              padding: "6px 14px",
              borderRadius: 7,
              background: confirmBg,
              color: accent,
              border: `1px solid ${confirmBorder}`,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
