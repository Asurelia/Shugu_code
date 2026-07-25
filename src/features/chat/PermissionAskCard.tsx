// Shugu Forge — P6.10 — carte de permission « ask » (règle allow/ask/deny).
//
// Rendue quand un appel d'outil a matché une règle « ask » en profil mutant :
// le run est en pause (sentinelle HITL), l'utilisateur décide. Quatre choix :
//   - Autoriser          → exécute cette fois (verdict « une fois » durable
//                          dans agent_interactions — la relance exécute) ;
//   - Refuser            → n'exécute pas cette fois (la relance voit un refus) ;
//   - Toujours autoriser → ÉCRIT une règle « allow » pour le motif, puis autorise ;
//   - Toujours refuser   → ÉCRIT une règle « deny » pour le motif, puis refuse.
//
// Contrat avec le backend : la réponse enregistrée commence par « AUTORISÉ »
// ou « REFUSÉ » — c'est ce préfixe que le moteur de permission
// lit à la relance pour trancher le verdict « une fois ».

import React, { useState } from "react";
import type { QuestionData } from "./useMessageDisplay";
import { continueAgent } from "./chat-sync";
import { permissionRuleSave } from "@/lib/commandRules";
import { permissionAnswerText } from "@/features/settings/permissionUtils";
import { pushToast } from "@/components/toast";

export function PermissionAskCard({
  data,
  convId,
}: {
  data: QuestionData;
  convId: string;
}) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const perm = data.permissionAsk;
  if (!perm) return null;

  const answer = async (decision: "once-allow" | "once-deny" | "always-allow" | "always-deny") => {
    if (busy || done) return;
    setBusy(true);
    const always = decision === "always-allow" || decision === "always-deny";
    const allow = decision === "once-allow" || decision === "always-allow";
    try {
      // « Toujours … » écrit la vraie règle AVANT la relance (l'évaluation
      // suivante la matche en allow/deny — plus besoin du verdict « une fois »).
      if (always) {
        await permissionRuleSave(perm.pattern, allow ? "allow" : "deny");
      }
      // Préfixe AUTORISÉ / REFUSÉ — contrat avec le moteur Rust.
      const text = permissionAnswerText(allow, perm.tool, perm.argsSummary);
      await continueAgent(convId, text, "agent", {
        interactionId: `${data.agentId}:${data.toolCallId}`,
        kind: "permission_ask",
        response: text,
      });
      setDone(
        allow
          ? always
            ? "Autorisé + règle « allow » écrite"
            : "Autorisé (cette fois)"
          : always
            ? "Refusé + règle « deny » écrite"
            : "Refusé (cette fois)",
      );
    } catch (err) {
      pushToast(`Décision non envoyée : ${String(err)}`, "error", 7000);
    } finally {
      setBusy(false);
    }
  };

  const btn = (color: string, border: string): React.CSSProperties => ({
    fontSize: 11.5,
    fontWeight: 700,
    padding: "5px 11px",
    borderRadius: 7,
    background: "transparent",
    color,
    border: `1px solid ${border}`,
    cursor: busy || done ? "default" : "pointer",
    opacity: busy || done ? 0.55 : 1,
    fontFamily: "inherit",
  });

  return (
    <div
      style={{
        marginTop: 8,
        padding: "12px 14px",
        borderRadius: 12,
        background: "var(--surface-container-high, #1c1c34)",
        border: "1px solid rgba(255, 207, 107, 0.30)",
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--warning, #ffcf6b)" }}>
        ⚠ Confirmation requise (règle « ask »)
      </div>
      <div style={{ marginTop: 6, fontSize: 12 }}>
        L'agent veut exécuter{" "}
        <code style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>{perm.tool}</code> avec{" "}
        <code
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            display: "block",
            marginTop: 4,
            padding: "5px 7px",
            borderRadius: 6,
            background: "rgba(0,0,0,0.25)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {perm.argsSummary}
        </code>
      </div>
      <div style={{ marginTop: 4, fontSize: 11, color: "var(--on-surface-muted)" }}>
        Motif de la règle : <code>{perm.pattern}</code>
      </div>
      {done ? (
        <div style={{ marginTop: 8, fontSize: 12, fontWeight: 600, color: "var(--success, #8aefc7)" }}>
          ✓ {done} — l'agent est relancé.
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
          <button type="button" disabled={busy} onClick={() => void answer("once-allow")} style={btn("var(--success, #8aefc7)", "rgba(138,239,199,0.35)")}>
            Autoriser
          </button>
          <button type="button" disabled={busy} onClick={() => void answer("once-deny")} style={btn("var(--danger, #ff6a8a)", "rgba(255,106,138,0.35)")}>
            Refuser
          </button>
          <button type="button" disabled={busy} onClick={() => void answer("always-allow")} style={btn("var(--success, #8aefc7)", "rgba(138,239,199,0.2)")}>
            Toujours autoriser
          </button>
          <button type="button" disabled={busy} onClick={() => void answer("always-deny")} style={btn("var(--danger, #ff6a8a)", "rgba(255,106,138,0.2)")}>
            Toujours refuser
          </button>
        </div>
      )}
    </div>
  );
}
