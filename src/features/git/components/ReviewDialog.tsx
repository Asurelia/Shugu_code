// Shugu Forge — ReviewDialog (Lot 7 AI code review).
//
// Modal "AI code review" : l'AI lit le diff (staged ou toutes modifs) et
// renvoie une revue structurée, affichée en texte pré-formaté. Calqué sur le
// shell de CommitDialog (createPortal, escape/outside-click, header / body
// scrollable / footer). La génération est lancée automatiquement à l'ouverture
// et relancée quand on change la source.
//
// Monté UNE seule fois (RootLayout) ; l'état open vient de `reviewDialogStore`
// → ouvrable depuis la palette ET le bouton Review de SideGit. Rend `null`
// quand fermé (les hooks restent montés, l'état est éphémère).
//
// MVP : appel one-shot (pas de streaming), rendu `<pre>` white-space:pre-wrap
// (aucun renderer markdown dans le repo — cohérent avec le chat). Le streaming
// et la review branche-vs-main sont des stretch hors-MVP.

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/components";
import { pushToast } from "@/components/toast";
import {
  useReviewDialog,
  closeReviewDialog,
  setReviewSource,
  type ReviewSource,
} from "../reviewDialogStore";
import { useAICodeReview } from "../useAICodeReview";

const SOURCES: { value: ReviewSource; label: string }[] = [
  { value: "index", label: "Staged" },
  { value: "head", label: "Toutes modifs" },
];

export function ReviewDialog(): JSX.Element | null {
  const { open, source } = useReviewDialog();
  const { review, isLoading, error, generate } = useAICodeReview();

  // Auto-génère à l'ouverture et au changement de source. On exclut
  // volontairement `generate` des deps : son identité change quand le git
  // status se rafraîchit, et on ne veut PAS re-reviewer à chaque modif de
  // fichier — uniquement sur open/source.
  useEffect(() => {
    if (open) void generate(source);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, source]);

  // Escape ferme (autorisé même pendant le chargement — l'appel one-shot n'a
  // pas de conversationId donc pas d'abort ; il se résout en arrière-plan).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeReviewDialog();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  if (!open) return null;

  const copy = async () => {
    if (!review) return;
    try {
      await navigator.clipboard.writeText(review);
      pushToast("Revue copiée", "success", 2500);
    } catch {
      pushToast("Copie impossible", "error");
    }
  };

  return createPortal(
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) closeReviewDialog();
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
          width: "min(760px, 92vw)",
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
        {/* Header */}
        <div
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
            display: "flex",
            alignItems: "center",
            gap: 10,
          }}
        >
          <Icon name="sparkle" size={14} />
          <div style={{ flex: 1, fontWeight: 600 }}>AI Code Review</div>
          {/* Toggle source */}
          <div style={{ display: "flex", gap: 4 }}>
            {SOURCES.map((s) => (
              <button
                key={s.value}
                onClick={() => setReviewSource(s.value)}
                className="lgb lgb-sm"
                disabled={isLoading && source === s.value}
                style={{
                  padding: "4px 10px",
                  fontSize: 11,
                  opacity: source === s.value ? 1 : 0.55,
                  borderColor:
                    source === s.value
                      ? "var(--primary, rgba(150,120,255,0.6))"
                      : undefined,
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button
            onClick={closeReviewDialog}
            className="lgb lgb-sm"
            title="Close"
            style={{ padding: "4px 8px" }}
          >
            <Icon name="x" size={11} />
          </button>
        </div>

        {/* Body */}
        <div
          className="scroll"
          style={{
            flex: 1,
            overflow: "auto",
            padding: 12,
            minHeight: 160,
          }}
        >
          {isLoading ? (
            <div
              style={{
                padding: 32,
                color: "var(--on-surface-muted)",
                textAlign: "center",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
              }}
            >
              Analyse du diff en cours…
            </div>
          ) : error ? (
            <div
              style={{
                padding: 24,
                color: "var(--danger)",
                textAlign: "center",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
              }}
            >
              {error}
            </div>
          ) : review ? (
            <pre
              style={{
                margin: 0,
                padding: "10px 12px",
                background: "rgba(0,0,0,0.18)",
                borderRadius: 8,
                border: "1px solid rgba(255,255,255,0.04)",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
                lineHeight: 1.5,
                color: "var(--on-surface)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {review}
            </pre>
          ) : (
            <div
              style={{
                padding: 32,
                color: "var(--on-surface-muted)",
                textAlign: "center",
                fontFamily: "var(--font-mono)",
                fontSize: 12,
              }}
            >
              Aucune revue.
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: 12,
            borderTop: "1px solid rgba(255,255,255,0.06)",
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <div style={{ flex: 1 }} />
          <button
            onClick={copy}
            disabled={!review || isLoading}
            className="lgb lgb-sm"
            title="Copier la revue"
          >
            <Icon name="copy" size={11} /> Copier
          </button>
          <button
            onClick={() => void generate(source)}
            disabled={isLoading}
            className="lgb lgb-sm lgb-primary"
          >
            {isLoading ? "Analyse…" : "Re-générer"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
