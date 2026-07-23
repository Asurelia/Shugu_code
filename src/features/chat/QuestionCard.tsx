// Shugu Forge — Volet 1 — carte de question interactive (outil `ask_user`).
//
// Rendu human-in-the-loop : l'agent a posé 1 à 4 questions À CHOIX ; l'utilisateur
// répond au clic (choix unique/multiple) ou en texte libre (« Autre »), et la
// réponse relance l'agent via `continueAgent` (mode Plan). Calqué sur
// CommandRiskCard (carte + état local + callback async + toasts). Le backend
// garantit l'idempotence : une interaction déjà consommée est rejetée (catch →
// toast + désactivation).

import React, { useState } from "react";
import type { QuestionData } from "./useMessageDisplay";
import { continueAgent } from "./chat-sync";
import { pushToast } from "@/components/toast";

export function QuestionCard({
  data,
  convId,
}: {
  data: QuestionData;
  convId: string;
}) {
  // Sélection par index de question : Set d'indices d'options cochées (multi) ou
  // un seul (single), + texte libre « Autre » par question.
  const [selected, setSelected] = useState<Record<number, Set<number>>>({});
  const [otherText, setOtherText] = useState<Record<number, string>>({});
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const toggle = (qi: number, oi: number, multi: boolean) => {
    if (sent || busy) return;
    setSelected((prev) => {
      const cur = new Set(prev[qi] ?? []);
      if (multi) {
        if (cur.has(oi)) cur.delete(oi);
        else cur.add(oi);
      } else {
        cur.clear();
        cur.add(oi);
      }
      return { ...prev, [qi]: cur };
    });
  };

  const send = async () => {
    if (busy || sent) return;
    // Réponse lisible pour le modèle : une ligne par question avec les libellés
    // choisis + l'éventuel texte « Autre ».
    const lines = data.questions.map((q, qi) => {
      const chosen = [...(selected[qi] ?? [])]
        .map((oi) => q.options[oi]?.label)
        .filter((l): l is string => Boolean(l));
      const other = (otherText[qi] ?? "").trim();
      if (other) chosen.push(other);
      return `- ${q.question}\n  → ${chosen.length ? chosen.join(", ") : "(sans réponse)"}`;
    });
    const answer =
      "Réponses de l'utilisateur :\n" + lines.join("\n") + "\n\nContinue le plan.";
    setBusy(true);
    try {
      await continueAgent(convId, answer, "plan", {
        interactionId: `${data.agentId}:${data.toolCallId}`,
        kind: "ask_user",
        response: answer,
        executionProfile: "plan",
        isolate: false,
      });
      setSent(true);
    } catch (err) {
      pushToast(`Réponse non envoyée : ${String(err)}`, "error", 7000);
    } finally {
      setBusy(false);
    }
  };

  const card: React.CSSProperties = {
    marginTop: 8,
    padding: "12px 14px",
    borderRadius: 12,
    background: "var(--surface-container-high, #1c1c34)",
    border: "1px solid rgba(150,150,150,0.22)",
    display: "flex",
    flexDirection: "column",
    gap: 12,
    opacity: sent ? 0.6 : 1,
  };

  return (
    <div className="question-card" style={card}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.3,
          color: "var(--on-surface-variant, #a5a0bf)",
          textTransform: "uppercase",
        }}
      >
        <span aria-hidden="true">❓</span>
        <span>L'agent a besoin de ta décision</span>
      </div>

      {data.questions.map((q, qi) => {
        const multi = q.multiSelect === true;
        const sel = selected[qi] ?? new Set<number>();
        return (
          <div
            key={q.id ?? qi}
            style={{ display: "flex", flexDirection: "column", gap: 7 }}
          >
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--on-surface, #ece9ff)",
              }}
            >
              {q.question}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {q.options.map((opt, oi) => {
                const active = sel.has(oi);
                return (
                  <button
                    key={oi}
                    type="button"
                    disabled={sent || busy}
                    onClick={() => toggle(qi, oi, multi)}
                    style={{
                      textAlign: "left",
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      padding: "7px 10px",
                      borderRadius: 8,
                      cursor: sent || busy ? "default" : "pointer",
                      fontFamily: "inherit",
                      background: active
                        ? "rgba(167, 139, 250, 0.14)"
                        : "transparent",
                      border: active
                        ? "1px solid rgba(167, 139, 250, 0.55)"
                        : "1px solid rgba(150,150,150,0.24)",
                      color: "var(--on-surface, #ece9ff)",
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        marginTop: 1,
                        fontSize: 12,
                        color: active
                          ? "var(--primary, #a78bfa)"
                          : "var(--on-surface-variant, #a5a0bf)",
                      }}
                    >
                      {multi ? (active ? "☑" : "☐") : active ? "◉" : "○"}
                    </span>
                    <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ fontSize: 13, fontWeight: 500 }}>{opt.label}</span>
                      {opt.description && (
                        <span
                          style={{
                            fontSize: 11.5,
                            color: "var(--on-surface-variant, #a5a0bf)",
                          }}
                        >
                          {opt.description}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
              <input
                type="text"
                value={otherText[qi] ?? ""}
                disabled={sent || busy}
                onChange={(e) =>
                  setOtherText((prev) => ({ ...prev, [qi]: e.target.value }))
                }
                placeholder="Autre… (réponse libre)"
                spellCheck={false}
                style={{
                  fontSize: 12.5,
                  padding: "7px 9px",
                  borderRadius: 8,
                  background: "var(--surface-container-highest, #24244420)",
                  color: "var(--on-surface, #ece9ff)",
                  border: "1px solid rgba(150,150,150,0.24)",
                }}
              />
            </div>
          </div>
        );
      })}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button
          type="button"
          disabled={sent || busy}
          onClick={send}
          style={{
            fontSize: 12,
            fontWeight: 600,
            padding: "6px 14px",
            borderRadius: 8,
            cursor: sent || busy ? "default" : "pointer",
            fontFamily: "inherit",
            color: sent ? "var(--success, #8aefc7)" : "var(--on-surface, #ece9ff)",
            background: sent ? "transparent" : "rgba(167, 139, 250, 0.16)",
            border: sent
              ? "1px solid rgba(138, 239, 199, 0.32)"
              : "1px solid rgba(167, 139, 250, 0.5)",
          }}
        >
          {sent ? "✓ Réponse envoyée" : busy ? "Envoi…" : "Envoyer mes réponses"}
        </button>
      </div>
    </div>
  );
}
