// Shugu Forge — Phase 7 #3 — carte de risque sur une commande flaggée.
//
// Quand le backend a PRÉFIXÉ la sortie d'une commande par « [RISK: …] » (non
// bloquant), la timeline affiche ici un chip danger + deux actions « toujours
// autoriser / refuser » qui enregistrent une règle (commandRuleSave). Le motif
// proposé (premier token + ` *`) est montré ÉDITABLE dans la confirmation, pour
// que l'utilisateur le restreigne (cas Windows : del/Remove-Item trop larges).

import React, { useRef, useState } from "react";
import { ConfirmDialog } from "@/components/trust/ConfirmDialog";
import {
  commandRuleSave,
  deriveCommandPattern,
  type RiskFlag,
} from "@/lib/commandRules";
import { pushToast } from "@/components/toast";

type Pending = { verdict: "allow" | "deny"; pattern: string };

export function CommandRiskCard({
  risk,
  command,
}: {
  risk: RiskFlag;
  command?: string;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  // Focus l'input du motif à l'ouverture (pas le bouton Confirmer) : sinon un
  // Entrée immédiat enregistrerait le motif PROPOSÉ non édité (ex. « rm * »).
  const patternRef = useRef<HTMLInputElement | null>(null);

  const openFor = (verdict: "allow" | "deny") =>
    setPending({ verdict, pattern: deriveCommandPattern(command) });

  const confirm = async () => {
    if (!pending) return;
    const pattern = pending.pattern.trim();
    const { verdict } = pending;
    setPending(null);
    try {
      await commandRuleSave(pattern, verdict);
      pushToast(
        verdict === "allow"
          ? `Règle ajoutée : « ${pattern} » sera autorisé sans badge au prochain run.`
          : `Règle ajoutée : « ${pattern} » sera signalé comme dangereux.`,
        "success",
        6000,
      );
    } catch (err) {
      // Le backend rejette un motif vide ou `*` nu → message actionnable.
      pushToast(`Règle non enregistrée : ${String(err)}`, "error", 7000);
    }
  };

  const btn: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    padding: "2px 9px",
    borderRadius: 6,
    background: "transparent",
    cursor: "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  };

  return (
    <div
      className="cmd-risk"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        marginTop: 6,
      }}
    >
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          fontSize: 11,
          fontWeight: 700,
          padding: "2px 8px",
          borderRadius: 999,
          color: "var(--danger, #ff6a8a)",
          background: "rgba(255, 106, 138, 0.10)",
          border: "1px solid rgba(255, 106, 138, 0.32)",
          maxWidth: "100%",
        }}
        title={`Risque signalé : ${risk.reason}`}
      >
        <span aria-hidden="true">⚠</span>
        <span>{risk.detail || risk.reason}</span>
      </span>

      <button
        type="button"
        onClick={() => openFor("allow")}
        style={{
          ...btn,
          color: "var(--success, #8aefc7)",
          border: "1px solid rgba(138, 239, 199, 0.32)",
        }}
      >
        Toujours autoriser
      </button>
      <button
        type="button"
        onClick={() => openFor("deny")}
        style={{
          ...btn,
          color: "var(--danger, #ff6a8a)",
          border: "1px solid rgba(255, 106, 138, 0.28)",
        }}
      >
        Toujours refuser
      </button>

      <ConfirmDialog
        open={pending !== null}
        tone={pending?.verdict === "deny" ? "danger" : "default"}
        title={
          pending?.verdict === "deny"
            ? "Toujours refuser ce motif de commande"
            : "Toujours autoriser ce motif de commande"
        }
        body={
          pending && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <p style={{ margin: 0 }}>
                {pending.verdict === "allow"
                  ? "Toute commande correspondant à ce motif s'exécutera SANS badge de risque."
                  : "Toute commande correspondant à ce motif sera signalée comme dangereuse."}{" "}
                Le motif est un glob de tokens (se termine éventuellement par{" "}
                <code>*</code>) — restreins-le si besoin.
              </p>
              <input
                ref={patternRef}
                value={pending.pattern}
                onChange={(e) =>
                  setPending({ ...pending, pattern: e.target.value })
                }
                aria-label="Motif de commande"
                spellCheck={false}
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 12,
                  padding: "7px 9px",
                  borderRadius: 7,
                  background: "var(--surface-container-high, #1c1c34)",
                  color: "var(--on-surface, #ece9ff)",
                  border: "1px solid rgba(150,150,150,0.28)",
                }}
              />
              <p
                style={{
                  margin: 0,
                  fontSize: 11,
                  color: "var(--on-surface-variant, #a5a0bf)",
                }}
              >
                Ex. <code>git push *</code>, <code>pnpm run build</code>. Un motif
                vide ou <code>*</code> seul est refusé.
              </p>
            </div>
          )
        }
        confirmLabel={
          pending?.verdict === "deny" ? "Toujours refuser" : "Toujours autoriser"
        }
        initialFocusRef={patternRef}
        onConfirm={confirm}
        onCancel={() => setPending(null)}
      />
    </div>
  );
}
