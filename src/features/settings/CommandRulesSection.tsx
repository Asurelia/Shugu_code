// Shugu Forge — Phase 7 #3 — gestionnaire des règles de commandes apprises.
//
// Section Settings « Command Rules » : liste / ajoute / supprime les règles
// allow|deny (table agent_command_rules via commandRule*). Une règle « allow »
// silencie le badge de risque pour un motif de commande ; « deny » flagge un
// motif que le classifieur statique rate. Le modèle suit le default.rules de
// Codex (motif = glob de tokens, optionnellement terminé par `*`).

import React, { useCallback, useEffect, useState } from "react";
import {
  commandRuleList,
  commandRuleSave,
  commandRuleDelete,
  type CommandRuleRow,
} from "@/lib/commandRules";
import { pushToast } from "@/components/toast";

function VerdictChip({ verdict }: { verdict: "allow" | "deny" }) {
  const allow = verdict === "allow";
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: 700,
        padding: "1px 7px",
        borderRadius: 999,
        whiteSpace: "nowrap",
        color: allow ? "var(--success, #8aefc7)" : "var(--danger, #ff6a8a)",
        background: allow ? "rgba(138,239,199,0.10)" : "rgba(255,106,138,0.10)",
        border: `1px solid ${allow ? "rgba(138,239,199,0.32)" : "rgba(255,106,138,0.32)"}`,
      }}
    >
      {allow ? "autorisé" : "refusé"}
    </span>
  );
}

export function CommandRulesSection() {
  const [rules, setRules] = useState<CommandRuleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pattern, setPattern] = useState("");
  const [verdict, setVerdict] = useState<"allow" | "deny">("allow");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setRules(await commandRuleList());
    } catch (err) {
      console.warn("[CommandRules] list failed:", err);
      setRules([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = async () => {
    const p = pattern.trim();
    if (!p || busy) return;
    setBusy(true);
    try {
      await commandRuleSave(p, verdict, detail.trim() || undefined);
      setPattern("");
      setDetail("");
      await refresh();
      pushToast(`Règle « ${p} » enregistrée.`, "success", 4000);
    } catch (err) {
      // Backend : motif vide ou `*` nu refusé.
      pushToast(`Règle non enregistrée : ${String(err)}`, "error", 7000);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: string) => {
    if (busy) return; // garde anti double-clic (revue) — évite un toast parasite
    setBusy(true);
    try {
      await commandRuleDelete(p);
      await refresh();
    } catch (err) {
      pushToast(`Suppression échouée : ${String(err)}`, "error", 6000);
    } finally {
      setBusy(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    padding: "7px 9px",
    borderRadius: 7,
    background: "var(--surface-container-high, #1c1c34)",
    color: "var(--on-surface, #ece9ff)",
    border: "1px solid rgba(150,150,150,0.28)",
  };

  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <div className="setting-section">
          <h3>Command Rules</h3>
          <p className="sub">
            Bénis un motif de commande pour silencier son badge de risque
            (« autorisé »), ou signale un motif que le classifieur rate
            (« refusé »). Un motif est un glob de tokens, optionnellement terminé
            par <code>*</code> (ex. <code>git push *</code>, <code>pnpm run build</code>).
            Une règle « refusé » bloque réellement la commande avant le démarrage.
            Une règle « autorisé » retire uniquement le badge d'un motif simple ;
            les chaînes/redirections dangereuses restent détectées.
          </p>

          {/* ── Ajout d'une règle ─────────────────────────────── */}
          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "center",
              margin: "10px 0 16px",
            }}
          >
            <input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void add();
              }}
              placeholder="motif (ex. cargo *)"
              aria-label="Motif de commande"
              spellCheck={false}
              style={{ ...inputStyle, flex: "1 1 180px", minWidth: 140 }}
            />
            <select
              value={verdict}
              onChange={(e) => setVerdict(e.target.value as "allow" | "deny")}
              aria-label="Verdict"
              style={{ ...inputStyle, cursor: "pointer" }}
            >
              <option value="allow">autorisé</option>
              <option value="deny">refusé</option>
            </select>
            <input
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void add();
              }}
              placeholder="note (optionnel)"
              aria-label="Note"
              style={{ ...inputStyle, flex: "1 1 160px", minWidth: 120 }}
            />
            <button
              type="button"
              onClick={() => void add()}
              disabled={busy || pattern.trim().length === 0}
              style={{
                fontSize: 12,
                fontWeight: 700,
                padding: "7px 14px",
                borderRadius: 7,
                cursor: busy || !pattern.trim() ? "default" : "pointer",
                opacity: busy || !pattern.trim() ? 0.5 : 1,
                color: "var(--primary, #e08efe)",
                background: "rgba(224,142,254,0.14)",
                border: "1px solid rgba(224,142,254,0.40)",
                fontFamily: "inherit",
              }}
            >
              Ajouter
            </button>
          </div>

          {/* ── Liste ─────────────────────────────────────────── */}
          {loading ? (
            <p className="sub">Chargement…</p>
          ) : rules.length === 0 ? (
            <p className="sub">
              Aucune règle pour l'instant. Tu peux aussi en créer une depuis le
              chat via « Toujours autoriser » sur une commande signalée.
            </p>
          ) : (
            <ul
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {rules.map((r) => (
                <li
                  key={r.pattern}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "7px 10px",
                    borderRadius: 8,
                    background: "var(--surface-container, #16162a)",
                    border: "1px solid rgba(150,150,150,0.16)",
                  }}
                >
                  <code
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: 12,
                      color: "var(--on-surface, #ece9ff)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      flex: "0 1 auto",
                    }}
                    title={r.pattern}
                  >
                    {r.pattern}
                  </code>
                  <VerdictChip verdict={r.verdict} />
                  {r.detail && (
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--on-surface-variant, #a5a0bf)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        flex: "1 1 auto",
                      }}
                      title={r.detail}
                    >
                      {r.detail}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={() => void remove(r.pattern)}
                    disabled={busy}
                    aria-label={`Supprimer la règle ${r.pattern}`}
                    style={{
                      marginLeft: "auto",
                      fontSize: 11,
                      fontWeight: 600,
                      padding: "3px 9px",
                      borderRadius: 6,
                      cursor: busy ? "default" : "pointer",
                      opacity: busy ? 0.5 : 1,
                      color: "var(--on-surface-variant, #a5a0bf)",
                      background: "transparent",
                      border: "1px solid rgba(150,150,150,0.24)",
                      fontFamily: "inherit",
                    }}
                  >
                    Supprimer
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
