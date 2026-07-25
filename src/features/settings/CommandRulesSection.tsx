// Shugu Forge — P6.10 — gestionnaire des règles de permission allow/ask/deny.
//
// Trois listes (Autoriser / Demander / Refuser) avec scope (global / projet
// courant), ajout/suppression, et un testeur live qui évalue un appel d'outil
// d'exemple contre les règles actuelles (permission_rule_evaluate) et montre
// QUELLE règle matche et le verdict résultant.
//
// Grammaire des motifs (source unique côté Rust, permission.rs) :
//   git push *                    → glob de commande (rétro-compat)
//   run_command(git diff:*)       → préfixe de ligne de commande
//   web_fetch(domain:example.com) → domaine + sous-domaines
//   fs_write_file(path:src/x/*)   → argument path d'un outil natif
//   mcp__<serveur>__<outil> / mcp__<serveur>__*
//
// Précédence : deny > ask > allow > classifieur statique ; à décision égale,
// le motif le plus long gagne ; à spécificité égale, la règle PROJET gagne
// sur la règle GLOBALE.

import React, { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  permissionRuleDelete,
  permissionRuleEvaluate,
  permissionRuleList,
  permissionRuleSave,
  type PermissionRuleRow,
  type RuleDecision,
} from "@/lib/commandRules";
import { fsGetWorkspaceRoot } from "@/lib/fs";
import { buildTestArgs, describeEvaluation, scopeLabel } from "./permissionUtils";
import { pushToast } from "@/components/toast";

const DECISION_META: Record<RuleDecision, { label: string; desc: string; color: string; bg: string; border: string }> = {
  allow: {
    label: "Autoriser",
    desc: "s'exécute sans badge ni question",
    color: "var(--success, #8aefc7)",
    bg: "rgba(138,239,199,0.10)",
    border: "rgba(138,239,199,0.32)",
  },
  ask: {
    label: "Demander",
    desc: "pause le run pour confirmation (HITL)",
    color: "var(--warning, #ffcf6b)",
    bg: "rgba(255,207,107,0.10)",
    border: "rgba(255,207,107,0.32)",
  },
  deny: {
    label: "Refuser",
    desc: "refusé avant exécution",
    color: "var(--danger, #ff6a8a)",
    bg: "rgba(255,106,138,0.10)",
    border: "rgba(255,106,138,0.32)",
  },
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

function RuleList({
  decision,
  rules,
  workspace,
  busy,
  onDelete,
}: {
  decision: RuleDecision;
  rules: PermissionRuleRow[];
  workspace: string | null;
  busy: boolean;
  onDelete: (pattern: string, scope: string) => void;
}) {
  const meta = DECISION_META[decision];
  const mine = rules.filter((r) => r.decision === decision);
  return (
    <div
      style={{
        flex: "1 1 220px",
        minWidth: 220,
        borderRadius: 8,
        padding: "8px 10px",
        background: "var(--surface-container, #16162a)",
        border: `1px solid ${meta.border}`,
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 700, color: meta.color }}>
        {meta.label} <span style={{ fontWeight: 400, color: "var(--on-surface-muted)" }}>· {meta.desc}</span>
      </div>
      {mine.length === 0 ? (
        <p className="sub" style={{ margin: "6px 0 0" }}>Aucune règle.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: "6px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 5 }}>
          {mine.map((r) => (
            <li
              key={`${r.pattern}|${r.scope}`}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11.5,
              }}
            >
              <code
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                }}
                title={r.detail ?? r.pattern}
              >
                {r.pattern}
              </code>
              {r.scope && (
                <span
                  style={{ fontSize: 9.5, color: "var(--secondary, #a78bfa)", whiteSpace: "nowrap" }}
                  title={`Règle projet : ${r.scope}`}
                >
                  {scopeLabel(r.scope, workspace)}
                </span>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={() => onDelete(r.pattern, r.scope)}
                title="Supprimer la règle"
                style={{
                  fontSize: 10,
                  padding: "1px 6px",
                  borderRadius: 4,
                  background: "transparent",
                  color: "var(--on-surface-muted)",
                  border: "1px solid rgba(150,150,150,0.25)",
                  cursor: "pointer",
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function CommandRulesSection() {
  const [rules, setRules] = useState<PermissionRuleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [pattern, setPattern] = useState("");
  const [decision, setDecision] = useState<RuleDecision>("allow");
  const [scopeChoice, setScopeChoice] = useState<"global" | "projet">("global");
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);

  // Testeur live.
  const [testTool, setTestTool] = useState("run_command");
  const [testArg, setTestArg] = useState("git push --force origin main");
  const [testResult, setTestResult] = useState<string | null>(null);

  const { data: wsRoot } = useQuery({
    queryKey: ["fs", "workspaceRoot"],
    queryFn: fsGetWorkspaceRoot,
    staleTime: Infinity,
    retry: false,
  });
  const workspace = wsRoot ?? null;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setRules(await permissionRuleList());
    } catch (err) {
      console.warn("[Permissions] list failed:", err);
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
      const scope = scopeChoice === "projet" && workspace ? workspace : "";
      await permissionRuleSave(p, decision, scope, detail.trim() || undefined);
      setPattern("");
      setDetail("");
      await refresh();
      pushToast(`Règle « ${p} » enregistrée (${DECISION_META[decision].label.toLowerCase()}${scope ? ", projet" : ", global"}).`, "success", 5000);
    } catch (err) {
      pushToast(`Règle non enregistrée : ${String(err)}`, "error", 7000);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (pat: string, scope: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await permissionRuleDelete(pat, scope);
      await refresh();
    } catch (err) {
      pushToast(`Suppression échouée : ${String(err)}`, "error", 6000);
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    if (busy) return;
    setBusy(true);
    setTestResult(null);
    try {
      const ev = await permissionRuleEvaluate(testTool, buildTestArgs(testTool, testArg));
      setTestResult(describeEvaluation(ev));
    } catch (err) {
      setTestResult(`Évaluation impossible : ${String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <div className="setting-section">
          <h3>Règles de permission</h3>
          <p className="sub">
            Trois listes appliquées à CHAQUE appel d'outil d'un run agent avant
            exécution : <strong>Autoriser</strong> (silencieux),{" "}
            <strong>Demander</strong> (pause le run pour te poser la question),
            <strong>Refuser</strong> (bloqué, le modèle voit le refus).
            Précédence : refuser &gt; demander &gt; autoriser ; à décision
            égale, le motif le plus long gagne, puis la règle projet sur la
            globale. Motifs : <code>git push *</code>,{" "}
            <code>run_command(git diff:*)</code>,{" "}
            <code>web_fetch(domain:example.com)</code>,{" "}
            <code>fs_write_file(path:src/secrets/*)</code>,{" "}
            <code>mcp__&lt;serveur&gt;__*</code>.
          </p>

          {/* ── Ajout ──────────────────────────────────────────── */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", margin: "10px 0 8px" }}>
            <input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
              placeholder="motif (ex. git push *)"
              aria-label="Motif"
              spellCheck={false}
              style={{ ...inputStyle, flex: "1 1 200px", minWidth: 160 }}
            />
            <select
              value={decision}
              onChange={(e) => setDecision(e.target.value as RuleDecision)}
              aria-label="Décision"
              style={{ ...inputStyle, cursor: "pointer" }}
            >
              <option value="allow">Autoriser</option>
              <option value="ask">Demander</option>
              <option value="deny">Refuser</option>
            </select>
            <select
              value={scopeChoice}
              onChange={(e) => setScopeChoice(e.target.value as "global" | "projet")}
              aria-label="Scope"
              style={{ ...inputStyle, cursor: "pointer" }}
            >
              <option value="global">global</option>
              <option value="projet" disabled={!workspace}>
                {workspace ? "projet (ce workspace)" : "projet (aucun workspace)"}
              </option>
            </select>
            <input
              value={detail}
              onChange={(e) => setDetail(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void add(); }}
              placeholder="note (optionnel)"
              aria-label="Note"
              style={{ ...inputStyle, flex: "1 1 140px", minWidth: 110 }}
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

          {/* ── Testeur live ───────────────────────────────────── */}
          <div
            style={{
              display: "flex",
              gap: 8,
              flexWrap: "wrap",
              alignItems: "center",
              padding: "8px 10px",
              borderRadius: 8,
              background: "var(--surface-container, #16162a)",
              border: "1px solid rgba(150,150,150,0.16)",
              marginBottom: 12,
            }}
          >
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--on-surface-muted)" }}>
              Testeur
            </span>
            <select
              value={testTool}
              onChange={(e) => setTestTool(e.target.value)}
              aria-label="Outil testé"
              style={{ ...inputStyle, cursor: "pointer" }}
            >
              <option value="run_command">run_command</option>
              <option value="web_fetch">web_fetch</option>
              <option value="fs_write_file">fs_write_file</option>
            </select>
            <input
              value={testArg}
              onChange={(e) => setTestArg(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void runTest(); }}
              placeholder={
                testTool === "run_command"
                  ? "commande d'exemple"
                  : testTool === "web_fetch"
                    ? "https://example.com/page"
                    : "src/exemple.ts"
              }
              aria-label="Argument d'exemple"
              spellCheck={false}
              style={{ ...inputStyle, flex: "1 1 200px", minWidth: 160 }}
            />
            <button
              type="button"
              onClick={() => void runTest()}
              disabled={busy}
              style={{
                fontSize: 11,
                fontWeight: 700,
                padding: "6px 12px",
                borderRadius: 7,
                cursor: "pointer",
                color: "var(--secondary, #a78bfa)",
                background: "rgba(167,139,250,0.12)",
                border: "1px solid rgba(167,139,250,0.35)",
                fontFamily: "inherit",
              }}
            >
              Évaluer
            </button>
            {testResult && (
              <span style={{ fontSize: 11.5, color: "var(--on-surface)" }}>{testResult}</span>
            )}
          </div>

          {/* ── Trois listes ───────────────────────────────────── */}
          {loading ? (
            <p className="sub">Chargement…</p>
          ) : (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
              <RuleList decision="allow" rules={rules} workspace={workspace} busy={busy} onDelete={(p, s) => void remove(p, s)} />
              <RuleList decision="ask" rules={rules} workspace={workspace} busy={busy} onDelete={(p, s) => void remove(p, s)} />
              <RuleList decision="deny" rules={rules} workspace={workspace} busy={busy} onDelete={(p, s) => void remove(p, s)} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
