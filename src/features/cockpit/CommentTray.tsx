// src/features/cockpit/CommentTray.tsx
// Lot C2.4 — tray des commentaires inline en attente d'envoi à l'agent.
//
// Rendu AU-DESSUS du composer dans views-chat.tsx. Retourne null si la file
// est vide → le chat normal (flag cockpit OFF, ou aucune note en attente) ne
// voit RIEN (zéro différence visuelle).

import React from "react";
import { useComments, removeComment } from "./commentStore";

export function CommentTray(): JSX.Element | null {
  const comments = useComments();

  // Safety gate — NOTHING rendered when the queue is empty.
  // This is the "no-comments path identical to today" guarantee.
  if (comments.length === 0) return null;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "6px 12px 4px",
        borderTop: "1px solid rgba(var(--primary-rgb,130,100,255),0.2)",
        background: "rgba(var(--primary-rgb,130,100,255),0.06)",
      }}
    >
      <div
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          color: "var(--primary)",
          opacity: 0.7,
          marginBottom: 2,
        }}
      >
        Commentaires inline ({comments.length}) · seront injectés avec le prochain message
      </div>
      {comments.map((c) => (
        <div
          key={c.id}
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 6,
            fontSize: 11,
            fontFamily: "var(--font-mono)",
          }}
        >
          <span
            style={{
              color: "var(--on-surface-muted)",
              flexShrink: 0,
              fontSize: 10,
            }}
          >
            {c.path}:{c.line}
          </span>
          <span style={{ color: "var(--on-surface-variant)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            — {c.note}
          </span>
          <button
            type="button"
            title="Retirer ce commentaire"
            onClick={() => removeComment(c.id)}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              color: "var(--on-surface-muted)",
              opacity: 0.6,
              padding: "0 2px",
              lineHeight: 1,
              fontSize: 12,
              flexShrink: 0,
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
