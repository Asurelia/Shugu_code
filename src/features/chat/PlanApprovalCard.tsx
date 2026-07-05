// Shugu Forge — Volet 1 — carte de plan soumis (outil `submit_plan`).
//
// L'agent a soumis son plan final en mode Plan. Deux actions human-in-the-loop :
//  - « Approuver et exécuter » → bascule le sélecteur cockpit en Agent (useChatMode)
//    puis relance l'agent avec le plan RÉINJECTÉ dans le message (mode "agent" →
//    exécution réelle sur le checkout).
//  - « Continuer à planifier » → relance en mode Plan avec un feedback optionnel.
// Le backend garantit l'idempotence (double-clic / reload+re-clic = rejet propre).
// Le plan est rendu en texte préformaté (Markdown brut) — lisible et robuste ;
// un rendu Markdown riche pourra l'embellir dans une passe UI ultérieure.

import React, { useState } from "react";
import type { PlanApprovalData } from "./useMessageDisplay";
import { continueAgent, useChatMode } from "./chat-sync";
import { pushToast } from "@/components/toast";

export function PlanApprovalCard({
  data,
  convId,
}: {
  data: PlanApprovalData;
  convId: string;
}) {
  const [, setMode] = useChatMode();
  const [busy, setBusy] = useState<null | "approve" | "continue">(null);
  const [done, setDone] = useState<null | "approved" | "continue">(null);
  const [feedback, setFeedback] = useState("");

  const approve = async () => {
    if (busy || done) return;
    setBusy("approve");
    try {
      // Bascule visible du sélecteur cockpit : Plan → Agent (exécution).
      setMode("agent");
      const answer =
        "Le plan ci-dessous est APPROUVÉ. Exécute-le maintenant, étape par étape, " +
        "en vérifiant à chaque changement.\n\n" +
        (data.title ? `# ${data.title}\n\n` : "") +
        data.plan;
      await continueAgent(convId, answer, "agent", {
        interactionId: `${data.agentId}:${data.toolCallId}`,
        kind: "submit_plan",
        verdict: "approved",
      });
      setDone("approved");
    } catch (err) {
      pushToast(`Exécution non lancée : ${String(err)}`, "error", 7000);
    } finally {
      setBusy(null);
    }
  };

  const keepPlanning = async () => {
    if (busy || done) return;
    setBusy("continue");
    try {
      const fb = feedback.trim();
      const answer = fb
        ? `Continue à affiner le plan avant de le re-soumettre. Retour de l'utilisateur : ${fb}`
        : "Continue à affiner le plan avant de le re-soumettre via submit_plan.";
      await continueAgent(convId, answer, "plan", {
        interactionId: `${data.agentId}:${data.toolCallId}`,
        kind: "submit_plan",
        verdict: "continue",
        response: fb || undefined,
      });
      setDone("continue");
    } catch (err) {
      pushToast(`Relance impossible : ${String(err)}`, "error", 7000);
    } finally {
      setBusy(null);
    }
  };

  const card: React.CSSProperties = {
    marginTop: 8,
    padding: "12px 14px",
    borderRadius: 12,
    background: "var(--surface-container-high, #1c1c34)",
    border: "1px solid rgba(167, 139, 250, 0.35)",
    display: "flex",
    flexDirection: "column",
    gap: 10,
    opacity: done ? 0.6 : 1,
  };

  const primaryBtn: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 600,
    padding: "7px 14px",
    borderRadius: 8,
    cursor: busy || done ? "default" : "pointer",
    fontFamily: "inherit",
    color: "var(--on-surface, #ece9ff)",
    background: "rgba(138, 239, 199, 0.16)",
    border: "1px solid rgba(138, 239, 199, 0.5)",
    whiteSpace: "nowrap",
  };
  const secondaryBtn: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 600,
    padding: "7px 14px",
    borderRadius: 8,
    cursor: busy || done ? "default" : "pointer",
    fontFamily: "inherit",
    color: "var(--on-surface-variant, #a5a0bf)",
    background: "transparent",
    border: "1px solid rgba(150,150,150,0.3)",
    whiteSpace: "nowrap",
  };

  return (
    <div className="plan-approval-card" style={card}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0.3,
          color: "var(--primary, #a78bfa)",
          textTransform: "uppercase",
        }}
      >
        <span aria-hidden="true">🗒</span>
        <span>{data.title ? `Plan — ${data.title}` : "Plan proposé"}</span>
      </div>

      <pre
        style={{
          margin: 0,
          maxHeight: 320,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontFamily: "var(--font-sans, inherit)",
          fontSize: 12.5,
          lineHeight: 1.55,
          color: "var(--on-surface, #ece9ff)",
          background: "rgba(0,0,0,0.14)",
          borderRadius: 8,
          padding: "10px 12px",
          border: "1px solid rgba(150,150,150,0.18)",
        }}
      >
        {data.plan}
      </pre>

      {done === "approved" ? (
        <div style={{ fontSize: 12, color: "var(--success, #8aefc7)" }}>
          ✓ Plan approuvé — exécution en cours (mode Agent).
        </div>
      ) : done === "continue" ? (
        <div style={{ fontSize: 12, color: "var(--on-surface-variant, #a5a0bf)" }}>
          ✎ L'agent affine le plan…
        </div>
      ) : (
        <>
          <input
            type="text"
            value={feedback}
            disabled={!!busy}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Retour optionnel pour « Continuer à planifier »…"
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
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
            <button type="button" style={secondaryBtn} disabled={!!busy} onClick={keepPlanning}>
              {busy === "continue" ? "…" : "Continuer à planifier"}
            </button>
            <button type="button" style={primaryBtn} disabled={!!busy} onClick={approve}>
              {busy === "approve" ? "Lancement…" : "▶ Approuver et exécuter"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
