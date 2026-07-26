// Shugu Forge — P6.4 — section Settings « Hooks ».
//
// Liste les hooks des DEUX fichiers (~/.shugu/hooks.json = « utilisateur »,
// <workspace>/.shugu/hooks.json = « projet ») avec badge de source, permet
// l'enable/disable par hook (persisté dans SQLite settings — le JSON de
// l'utilisateur n'est JAMAIS réécrit), et un « Tester » qui exécute le hook
// contre un payload d'exemple (même confinement sandbox qu'en production) et
// montre outcome / exit / stdout / stderr / durée.

import { useCallback, useEffect, useState } from "react";
import {
  hooksList,
  hooksSetDisabled,
  hooksTest,
  type HookInfo,
  type HookTestResult,
} from "@/lib/hooks";
import {
  describeHookTest,
  hookEventLabel,
  hookOutcomeLabel,
  hookOutcomeTone,
  hookSourceLabel,
} from "./hooksUtils";
import { pushToast } from "@/components/toast";
import { listen } from "@/lib/tauri";

const TONE_COLORS: Record<string, { fg: string; bg: string; border: string }> = {
  success: { fg: "var(--success, #8aefc7)", bg: "rgba(138,239,199,0.10)", border: "rgba(138,239,199,0.32)" },
  warn: { fg: "var(--warning, #ffcf6b)", bg: "rgba(255,207,107,0.10)", border: "rgba(255,207,107,0.32)" },
  danger: { fg: "var(--danger, #ff6a8a)", bg: "rgba(255,106,138,0.10)", border: "rgba(255,106,138,0.32)" },
  muted: { fg: "var(--on-surface-muted)", bg: "rgba(148,163,184,0.10)", border: "rgba(148,163,184,0.32)" },
};

function OutcomeChip({ outcome }: { outcome: string }) {
  const tone = TONE_COLORS[hookOutcomeTone(outcome)] ?? TONE_COLORS.muted;
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: 700,
        padding: "1px 7px",
        borderRadius: 999,
        whiteSpace: "nowrap",
        color: tone.fg,
        background: tone.bg,
        border: `1px solid ${tone.border}`,
      }}
    >
      {hookOutcomeLabel(outcome)}
    </span>
  );
}

function HookRow({
  hook,
  onToggle,
  busy,
}: {
  hook: HookInfo;
  onToggle: (id: string, disabled: boolean) => void;
  busy: boolean;
}) {
  const [testResult, setTestResult] = useState<HookTestResult | null>(null);
  return (
    <li
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "8px 10px",
        borderRadius: 8,
        background: "var(--surface-container, #16162a)",
        border: "1px solid rgba(150,150,150,0.16)",
        opacity: hook.disabled ? 0.55 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 700,
            padding: "1px 7px",
            borderRadius: 999,
            color: "var(--secondary, #a78bfa)",
            background: "rgba(167,139,250,0.10)",
            border: "1px solid rgba(167,139,250,0.32)",
          }}
        >
          {hookEventLabel(hook.event)}
        </span>
        <span
          style={{
            fontSize: 10.5,
            padding: "1px 7px",
            borderRadius: 999,
            color: "var(--on-surface-muted)",
            border: "1px solid rgba(148,163,184,0.32)",
          }}
          title={hook.source === "project" ? "<workspace>/.shugu/hooks.json" : "~/.shugu/hooks.json"}
        >
          {hookSourceLabel(hook.source)}
        </span>
        {hook.matcher && (
          <code style={{ fontSize: 11, color: "var(--on-surface-muted)" }} title="matcher (regex sur le nom d'outil)">
            /{hook.matcher}/
          </code>
        )}
        {hook.async && (
          <span style={{ fontSize: 10, color: "var(--on-surface-muted)" }} title="Fire-and-forget (events non bloquants)">
            async
          </span>
        )}
        <span style={{ fontSize: 10, color: "var(--on-surface-muted)" }}>{hook.timeoutSecs}s</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void hooksTest(hook.id)
              .then(setTestResult)
              .catch((err) => pushToast(`Test impossible : ${String(err)}`, "error", 6000))
          }
          style={{
            fontSize: 11,
            padding: "3px 10px",
            borderRadius: 6,
            cursor: "pointer",
            color: "var(--primary, #e08efe)",
            background: "rgba(224,142,254,0.10)",
            border: "1px solid rgba(224,142,254,0.35)",
          }}
        >
          Tester
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onToggle(hook.id, !hook.disabled)}
          style={{
            fontSize: 11,
            padding: "3px 10px",
            borderRadius: 6,
            cursor: "pointer",
            color: hook.disabled ? "var(--success, #8aefc7)" : "var(--on-surface-muted)",
            background: "transparent",
            border: "1px solid rgba(150,150,150,0.3)",
          }}
        >
          {hook.disabled ? "Activer" : "Désactiver"}
        </button>
      </div>
      <code
        style={{
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          color: "var(--on-surface)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
        }}
      >
        {hook.command}
      </code>
      {testResult && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            borderTop: "1px solid rgba(255,255,255,0.06)",
            paddingTop: 6,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <OutcomeChip outcome={testResult.outcome} />
            <span style={{ fontSize: 10.5, color: "var(--on-surface-muted)" }}>
              {describeHookTest(testResult)}
            </span>
          </div>
          {testResult.stdout.trim() && (
            <pre
              style={{
                margin: 0,
                fontSize: 10.5,
                fontFamily: "var(--font-mono)",
                color: "var(--on-surface-muted)",
                maxHeight: 90,
                overflow: "auto",
                whiteSpace: "pre-wrap",
              }}
            >
              {testResult.stdout.trim()}
            </pre>
          )}
          {testResult.stderr.trim() && (
            <pre
              style={{
                margin: 0,
                fontSize: 10.5,
                fontFamily: "var(--font-mono)",
                color: "var(--danger, #ff6a8a)",
                maxHeight: 90,
                overflow: "auto",
                whiteSpace: "pre-wrap",
              }}
            >
              {testResult.stderr.trim()}
            </pre>
          )}
        </div>
      )}
    </li>
  );
}

export function HooksSection() {
  const [hooks, setHooks] = useState<HookInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setHooks(await hooksList());
    } catch (err) {
      console.warn("[Hooks] list failed:", err);
      setHooks([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const retain = (unlisten: () => void) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    };
    void listen("workspace://changed", refresh).then(retain).catch(() => {});
    void listen("workspace://trust-changed", refresh).then(retain).catch(() => {});
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [refresh]);

  const toggle = async (id: string, disabled: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await hooksSetDisabled(id, disabled);
      await refresh();
      pushToast(disabled ? "Hook désactivé (persisté)." : "Hook réactivé.", "success", 3000);
    } catch (err) {
      pushToast(`Échec : ${String(err)}`, "error", 6000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-shell scroll">
      <div className="settings-inner">
        <div className="setting-section">
          <h3>Hooks</h3>
          <p className="sub">
            Commandes exécutées aux points de cycle de vie d'un run agent
            (modèle Claude Code). Lues depuis <code>~/.shugu/hooks.json</code> et{" "}
            <code>&lt;workspace&gt;/.shugu/hooks.json</code> — le projet étend
            l'utilisateur (les deux tirent, dans cet ordre). Un hook{" "}
            <strong>PreToolUse</strong> peut refuser un outil (fail-closed) ; un
            hook <strong>Stop</strong> peut bloquer la fin d'un run (3 fois
            consécutives max). Les hooks ne tournent qu'en profils Auto / Full
            Access, jamais en Chat/Plan — en Auto ils sont sandboxés comme{" "}
            <code>run_command</code>. La désactivation est persistée ici, sans
            jamais réécrire ton <code>hooks.json</code>.
          </p>

          {loading ? (
            <p className="sub">Chargement…</p>
          ) : hooks.length === 0 ? (
            <p className="sub">
              Aucun hook configuré. Exemple :{" "}
              <code>
                {`{"hooks":[{"event":"PreToolUse","matcher":"fs_write_.*","command":"mon-guard.cmd","timeout":30}]}`}
              </code>{" "}
              dans <code>.shugu/hooks.json</code> à la racine du projet. Le hook
              reçoit un JSON sur stdin (<code>version: 1</code>) et peut imprimer{" "}
              <code>{`{"additionalContext":"…","decision":"block","reason":"…"}`}</code>.
            </p>
          ) : (
            <ul
              style={{
                listStyle: "none",
                margin: "10px 0 0",
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {hooks.map((h) => (
                <HookRow key={h.id} hook={h} onToggle={(id, d) => void toggle(id, d)} busy={busy} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
