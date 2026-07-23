// Shugu Forge — AgentsPanel (TanStack-only).
//
// Le panneau d'observabilité multi-agents. Refactor 2026-05-17 pour
// éliminer le Zustand store + applyEvent manuel qui causaient un freeze
// catastrophique sur Windows WebView2 (cascade de re-renders sur burst
// d'events Tauri). L'archi est maintenant 100% TanStack :
//
//   1. `useActiveAgents()` — liste des agents actifs (refetch sur invalidate)
//   2. `useAgentTranscript(id)` — transcript de l'agent sélectionné
//   3. `useAgentEvents()` — listen `agent://lifecycle` → invalidate (wired
//      dans RootLayout, pas ici, pour ne pas double-mount)
//
// Pas de store custom. Pas de subscribers manuels. Pas de useMemo sur
// des sélecteurs instables. React 18 + TanStack gèrent tout le batching
// et l'optimisation des re-renders nativement.

import { useEffect, useState } from "react";
import {
  killAgent,
  atelierRun,
  groundedRun,
  execPreflight,
  type AgentRow,
  type AgentEvent,
  type ExecCapability,
} from "@/lib/agents";
import {
  useActiveAgents,
  useAgentTranscript,
  useSelectedAgentId,
  setSelectedAgentId,
} from "./queries";
import { useSkillsList, invalidateSkills } from "./skillsQueries";
import { resolveProvider, type Protocol } from "@/lib/providers";
import { loadProviderConfig, getConfig, getProviderEnabled } from "@/lib/credentials";
import { useActiveModel } from "@/features/chat/chat-sync";
import {
  ExecutionProfileCard,
  ConfirmDialog,
  InlineNotice,
} from "@/components/trust";
import { pushToast } from "@/components/toast";
import {
  worktreeMergeBack,
  worktreeDiscard,
  extractWorktreeStatus,
} from "@/lib/worktree";

// Resolve the active model → provider routing (protocol / baseUrl / key), exactly
// like the chat delegate flow: the key stays in the keychain, never cleartext.
// Shared by the Atelier and Grounded launchers so the resolution logic lives in
// ONE place (a divergence here would be a silent auth bug in one launcher only).
interface ResolvedProvider {
  protocol: Protocol;
  baseUrl: string;
  apiKey: string | undefined;
  model: string;
}

function profileSummary(row: AgentRow): string {
  return row.profileVerified ? row.executionProfile : "profil historique non vérifié";
}

function isolationSummary(row: AgentRow): string {
  switch (row.isolationStatus) {
    case "pending": return "isolation demandée";
    case "active": return "worktree actif";
    case "failed": return "isolation échouée";
    case "review": return "worktree à relire";
    case "finalized": return "isolation finalisée";
    case "discarded": return "worktree jeté";
    case "unknown": return "isolation historique inconnue";
    default: return "checkout courant";
  }
}

// Throws Error("Aucun provider…") when no provider is enabled — both launchers
// already have a try/catch that surfaces err.message, so the error path stays
// uniform without a discriminated-union return (which `strict:false` narrows
// unreliably here).
async function resolveActiveProviderConfig(
  modelId: string | undefined,
): Promise<ResolvedProvider> {
  const fullId = modelId?.includes("/") ? modelId : `anthropic/${modelId ?? "claude-haiku-4-5"}`;
  const {
    providerId,
    protocol: defProto,
    baseUrl: defBase,
    model: realModel,
  } = resolveProvider(fullId);
  const enabled = await getProviderEnabled(providerId);
  if (enabled !== "true") {
    throw new Error("Aucun provider LLM configuré — Réglages → Connexions.");
  }
  const cfg = await loadProviderConfig(providerId);
  let protocol: Protocol = defProto;
  if (defProto === "custom") {
    const stored = await getConfig(providerId, "protocol");
    if (stored === "anthropic" || stored === "openai" || stored === "ollama" || stored === "custom") {
      protocol = stored;
    }
  }
  const baseUrl = cfg.baseUrl && cfg.baseUrl !== "" ? cfg.baseUrl : defBase;
  const apiKey = cfg.apiKey && cfg.apiKey !== "" ? cfg.apiKey : undefined;
  return { protocol, baseUrl, apiKey, model: realModel };
}

// wry serves a custom `foo://` scheme as `http://foo.localhost/` on Windows and
// `foo://localhost/` elsewhere — mirror ProjectPreview's origin so the Atelier
// preview iframe hits the same `preview://` Rust handler.
function previewOrigin(): string {
  const isWin =
    typeof navigator !== "undefined" && /Windows|Win32|Win64/i.test(navigator.userAgent);
  return isWin ? "http://preview.localhost" : "preview://localhost";
}

// Flag de parking de l'UI Atelier (2026-05-29). L'Atelier (build → test
// Playwright → learn, exec directe depuis le pivot 2026-06-10) reste câblé
// côté backend (commande `agent_atelier_run`, `ATELIER_PROMPT`), mais son UI
// est masquée tant qu'elle n'a pas été validée end-to-end et que son utilité
// produit n'est pas tranchée. Repasser à `true` pour réactiver la carte
// launcher + bouton Démo.
const ATELIER_UI_ENABLED = false;

// Preset for the "Démo : to-do list" button — a small but genuinely interactive
// app the agent must build AND verify by driving a real browser.
const ATELIER_TODO_PRESET =
  "Construis une petite to-do list web : un champ texte + un bouton « Ajouter » qui ajoute la saisie comme nouvel item dans une liste (<ul>) ; chaque item a un bouton « Supprimer » qui le retire ; cliquer sur le texte d'un item le marque comme fait (une classe CSS qui barre le texte). Puis écris un test Playwright en CommonJS (require('playwright'), chromium.launch(), URL file:// absolue construite depuis process.cwd()) qui : ajoute deux items, en supprime un, marque l'autre comme fait, et vérifie le DOM à chaque étape (process.exit(1) si un check échoue). Lance le test avec run_command et corrige jusqu'à exit 0, puis sauve le skill.";

// Tick utility — force un re-render périodique tant que `active=true`.
// Cas d'usage : faire que `fmtAge()` (qui lit `Date.now()`) tick en live
// pour afficher l'âge d'un agent qui tourne. Sans ça, l'âge ne se met à
// jour qu'à la prochaine invalidation de la query parent (typiquement
// sur Spawn/Complete/Error event) → "timer figé" perçu par l'user.
//
// useState local OK ici : c'est du state purement UI (ticker), pas
// partagé entre composants. Pas la peine de passer par TanStack.
function useTick(intervalMs: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs, active]);
  return now;
}

// ────────────────────────────────────────────────────────────────────
// Visual helpers
// ────────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, { bg: string; fg: string; icon: string }> = {
  pending: { bg: "rgba(150,150,150,0.18)", fg: "var(--on-surface-muted, #999)", icon: "◌" },
  running: { bg: "rgba(124, 58, 237, 0.22)", fg: "var(--primary, #7c3aed)", icon: "●" },
  complete: { bg: "rgba(74, 222, 128, 0.18)", fg: "var(--success, #4ade80)", icon: "✓" },
  error: { bg: "rgba(255, 107, 107, 0.18)", fg: "var(--error, #ff6b6b)", icon: "✗" },
  killed: { bg: "rgba(150,150,150,0.18)", fg: "var(--on-surface-muted, #999)", icon: "⊘" },
};

function StatusBadge({ status }: { status: string }) {
  const c = STATUS_COLORS[status] ?? STATUS_COLORS.pending;
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 0.5,
        textTransform: "uppercase",
        padding: "2px 8px",
        borderRadius: 99,
        background: c.bg,
        color: c.fg,
      }}
    >
      {c.icon} {status}
    </span>
  );
}

function fmtAge(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

// ────────────────────────────────────────────────────────────────────
// Agent row — flat list (Phase 0 ne supporte pas la hiérarchie multi-niveau ;
// les agents racine sont rendus à plat, les enfants seraient indentés
// dans une future itération si on ajoute le sub-agent spawning).
// ────────────────────────────────────────────────────────────────────

function AgentRowItem({
  row,
  isSelected,
  onSelect,
}: {
  row: AgentRow;
  isSelected: boolean;
  onSelect: (id: string | null) => void;
}) {
  return (
    // Trust-UX (Lane 5) — vrai <button> sémantique (était un div onClick) : la
    // ligne est une action (sélectionner/déselectionner l'agent), donc elle doit
    // être focusable au clavier et annoncée comme bouton-bascule.
    <button
      type="button"
      aria-pressed={isSelected}
      onClick={() => onSelect(isSelected ? null : row.id)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        width: "100%",
        textAlign: "left",
        padding: "6px 8px",
        borderRadius: 6,
        cursor: "pointer",
        font: "inherit",
        background: isSelected ? "rgba(124, 58, 237, 0.08)" : "transparent",
        border: isSelected
          ? "1px solid rgba(124, 58, 237, 0.35)"
          : "1px solid transparent",
      }}
    >
      <StatusBadge status={row.status} />
      <span style={{ fontSize: 11, fontWeight: 600 }}>{row.role}</span>
      <span
        title={`${profileSummary(row)} · ${isolationSummary(row)}`}
        style={{ fontSize: 9, color: "var(--on-surface-muted)", fontFamily: "var(--font-mono)" }}
      >
        {profileSummary(row)}{row.isolate ? ` · ${isolationSummary(row)}` : ""}
      </span>
      <span
        style={{
          flex: 1,
          fontSize: 11,
          color: "var(--on-surface-muted)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {row.task}
      </span>
      <span
        style={{
          fontSize: 10,
          color: "var(--on-surface-muted)",
          fontFamily: "var(--font-mono)",
        }}
      >
        {fmtAge(row.createdAt)}
      </span>
    </button>
  );
}

// ────────────────────────────────────────────────────────────────────
// Drawer — minimal observability per user requirement (2026-05-17) :
//   Tâche transmise → Activité (si en cours) → Réponse finale OU erreur.
//   On NE rend PAS les events intermédiaires (delta, toolCall, toolResult,
//   messages intermédiaires) pour éviter le coût DOM qui causait le freeze.
// ────────────────────────────────────────────────────────────────────

export function TranscriptDrawer({
  agentId,
  onClose,
}: {
  agentId: string;
  onClose: () => void;
}) {
  const { data, isLoading } = useAgentTranscript(agentId);
  const [previewNonce, setPreviewNonce] = useState(0);

  if (isLoading || !data) {
    return (
      <div
        style={{
          marginTop: 10,
          padding: 12,
          borderRadius: 8,
          background: "rgba(124, 58, 237, 0.04)",
          border: "1px solid rgba(124, 58, 237, 0.18)",
          fontSize: 11,
          color: "var(--on-surface-muted)",
        }}
      >
        Chargement du transcript…
      </div>
    );
  }

  const row = data.agent;
  const events: AgentEvent[] = data.events;

  // Pieces minimal observability — extracted from the events array.
  const userPrompt = events.find((e) => e.kind === "message" && e.role === "user");
  const completeEvent = events.find((e) => e.kind === "complete");
  const errorEvent = events.find((e) => e.kind === "error");
  const toolCallCount = events.filter((e) => e.kind === "toolCall").length;
  const isActive = row.status === "running" || row.status === "pending";

  // Exec views: the real test runs (run_command) + the skills the env-verified
  // gate accepted. Any agent can execute now (exec directe) — the "real-env
  // tests" view applies whenever run_command was called. The browser-preview
  // iframe stays Atelier-ONLY (keyed on the agent's role).
  const skillEvents = events.filter((e) => e.kind === "skillLearned");
  const lessonEvents = events.filter((e) => e.kind === "lessonsInjected");
  const runCalls = events.filter((e) => e.kind === "toolCall" && e.tool === "run_command");
  const hasExecRuns = runCalls.length > 0;
  const isAtelierRun = row.role === "atelier";
  const resultByCall = new Map<string, string>();
  for (const e of events) {
    if (e.kind === "toolResult") {
      const content =
        typeof e.result === "string" ? e.result : e.error ?? JSON.stringify(e.result);
      resultByCall.set(e.toolCallId, content);
    }
  }

  // Live stream — extract le dernier delta de chaque kind pour afficher
  // ce que l'agent est en train de générer en temps réel. Avec le push
  // setQueryData partiel côté useEvents, ces deltas se mettent à jour à
  // chaque token sans round-trip DB.
  const liveReasoning = (() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.kind === "delta" && e.deltaKind === "reasoning") return e.chunk;
      if (e.kind === "message" || e.kind === "toolCall" || e.kind === "toolResult") break;
    }
    return "";
  })();
  const liveContent = (() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.kind === "delta" && e.deltaKind === "content") return e.chunk;
      if (e.kind === "message" || e.kind === "toolCall" || e.kind === "toolResult") break;
    }
    return "";
  })();

  const sectionStyle: React.CSSProperties = {
    marginTop: 10,
    padding: "8px 10px",
    borderRadius: 6,
    background: "rgba(124, 58, 237, 0.04)",
    border: "1px solid rgba(124, 58, 237, 0.10)",
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 9,
    fontFamily: "var(--font-mono)",
    letterSpacing: 0.5,
    textTransform: "uppercase",
    color: "var(--primary, #7c3aed)",
    marginBottom: 6,
    display: "block",
  };
  const bodyStyle: React.CSSProperties = {
    whiteSpace: "pre-wrap",
    color: "var(--on-surface, #ddd)",
    fontSize: 12,
    lineHeight: 1.5,
  };

  return (
    <div
      style={{
        marginTop: 10,
        padding: 10,
        borderRadius: 8,
        background: "rgba(124, 58, 237, 0.04)",
        border: "1px solid rgba(124, 58, 237, 0.18)",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <StatusBadge status={row.status} />
        <span style={{ fontSize: 12, fontWeight: 600 }}>{row.role}</span>
        <span
          style={{
            fontSize: 9,
            padding: "2px 6px",
            borderRadius: 999,
            fontFamily: "var(--font-mono)",
            color: row.profileVerified && row.executionProfile === "fullAccess" ? "var(--danger, #ff6a8a)" : "var(--tertiary, #81ecff)",
            border: "1px solid currentColor",
          }}
        >
          {profileSummary(row)} · {isolationSummary(row)}
        </span>
        <span
          style={{
            flex: 1,
            fontSize: 11,
            color: "var(--on-surface-muted)",
          }}
        >
          model={row.model}
        </span>
        {isActive && (
          <button
            onClick={() => void killAgent(row.id)}
            style={{
              fontSize: 10,
              padding: "2px 8px",
              borderRadius: 4,
              background: "rgba(255, 107, 107, 0.12)",
              color: "var(--error, #ff6b6b)",
              border: "1px solid rgba(255, 107, 107, 0.3)",
              cursor: "pointer",
            }}
          >
            Kill
          </button>
        )}
        <button
          onClick={onClose}
          style={{
            fontSize: 10,
            padding: "2px 8px",
            borderRadius: 4,
            background: "transparent",
            color: "var(--on-surface-muted)",
            border: "1px solid rgba(150,150,150,0.25)",
            cursor: "pointer",
          }}
        >
          Close
        </button>
      </div>

      {/* Section 1: the prompt the agent received */}
      <div style={sectionStyle}>
        <span style={labelStyle}>Tâche transmise</span>
        <div style={bodyStyle}>
          {userPrompt && userPrompt.kind === "message" ? userPrompt.content : row.task}
        </div>
      </div>

      {/* Section 2: activity sign + live stream while running */}
      {isActive && (
        <div style={sectionStyle}>
          <span style={labelStyle}>Activité</span>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: liveReasoning || liveContent ? 8 : 0,
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: 99,
                background: "var(--primary, #7c3aed)",
                animation: "pulse-pin 1.4s ease-in-out infinite",
              }}
            />
            <span style={{ ...bodyStyle, color: "var(--on-surface-muted)" }}>
              L'agent travaille…
              {toolCallCount > 0 &&
                ` ${toolCallCount} outil${toolCallCount > 1 ? "s" : ""} exécuté${toolCallCount > 1 ? "s" : ""}.`}
            </span>
          </div>
          {liveReasoning && (
            <div
              style={{
                ...bodyStyle,
                fontStyle: "italic",
                color: "var(--on-surface-muted)",
                fontSize: 11,
                maxHeight: 80,
                overflowY: "auto",
                marginBottom: 4,
              }}
            >
              {liveReasoning}
            </div>
          )}
          {liveContent && (
            <div
              style={{
                ...bodyStyle,
                fontSize: 11,
                maxHeight: 120,
                overflowY: "auto",
              }}
            >
              {liveContent}
            </div>
          )}
        </div>
      )}

      {/* Section 3: final response */}
      {completeEvent && completeEvent.kind === "complete" && (
        <div style={sectionStyle}>
          <span style={labelStyle}>Réponse</span>
          <div style={bodyStyle}>{completeEvent.output}</div>
          <div
            style={{
              marginTop: 6,
              fontSize: 10,
              color: "var(--on-surface-muted)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {completeEvent.ms}ms
            {toolCallCount > 0 &&
              ` · ${toolCallCount} outil${toolCallCount > 1 ? "s" : ""}`}
          </div>
        </div>
      )}
      {errorEvent && errorEvent.kind === "error" && (
        <div
          style={{
            ...sectionStyle,
            background: "rgba(255, 107, 107, 0.06)",
            border: "1px solid rgba(255, 107, 107, 0.2)",
          }}
        >
          <span style={{ ...labelStyle, color: "var(--error, #ff6b6b)" }}>Erreur</span>
          <div style={{ ...bodyStyle, color: "var(--error, #ff6b6b)" }}>
            {errorEvent.error}
          </div>
        </div>
      )}

      {/* Atelier — env-verified skills the agent captured this run */}
      {skillEvents.length > 0 && (
        <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 6 }}>
          {skillEvents.map((e, i) =>
            e.kind === "skillLearned" ? (
              e.source === "advisor" ? (
                <span
                  key={i}
                  title="Skill distillé par l'advisor (reviewer externe) — leçon synthétisée après revue"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    padding: "3px 8px",
                    borderRadius: 99,
                    background: "rgba(124, 58, 237, 0.15)",
                    color: "var(--primary, #7c3aed)",
                    border: "1px solid rgba(124, 58, 237, 0.35)",
                  }}
                >
                  🧠 skill distillé par l'advisor : {e.name}
                </span>
              ) : (
                <span
                  key={i}
                  title="Skill vérifié par un vrai test (exit 0) — pas une opinion du LLM"
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    padding: "3px 8px",
                    borderRadius: 99,
                    background: "rgba(74, 222, 128, 0.15)",
                    color: "var(--success, #4ade80)",
                    border: "1px solid rgba(74, 222, 128, 0.35)",
                  }}
                >
                  🎓 appris : {e.name}
                </span>
              )
            ) : null,
          )}
        </div>
      )}

      {/* S3 — leçons de runs passés réinjectées dans le contexte de ce run */}
      {lessonEvents.length > 0 && (
        <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 6 }}>
          {lessonEvents.map((e, i) =>
            e.kind === "lessonsInjected" ? (
              <span
                key={i}
                title="Leçons validées (runs passés réussis, similaires à cette tâche) réinjectées dans le contexte — boucle d'apprentissage S3"
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  padding: "3px 8px",
                  borderRadius: 99,
                  background: "rgba(124, 58, 237, 0.15)",
                  color: "var(--primary, #7c3aed)",
                  border: "1px solid rgba(124, 58, 237, 0.35)",
                }}
              >
                📚 {e.count} leçon{e.count > 1 ? "s" : ""} réinjectée{e.count > 1 ? "s" : ""}
              </span>
            ) : null,
          )}
        </div>
      )}

      {/* Real-env command runs (the test→fix loop) — Atelier or Grounded */}
      {hasExecRuns && (
        <div style={sectionStyle}>
          <span style={labelStyle}>Tests exécutés (environnement réel)</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {runCalls.map((e, i) => {
              if (e.kind !== "toolCall") return null;
              const cmd = (e.args as { command?: string } | null)?.command ?? "(commande)";
              const out = resultByCall.get(e.toolCallId) ?? "(en cours…)";
              const passed = out.trim().startsWith("[exit 0]");
              return (
                <div
                  key={e.toolCallId}
                  style={{
                    borderRadius: 6,
                    border: `1px solid ${
                      passed ? "rgba(74,222,128,0.3)" : "rgba(255,107,107,0.25)"
                    }`,
                    overflow: "hidden",
                  }}
                >
                  <div
                    style={{
                      fontSize: 10,
                      fontFamily: "var(--font-mono)",
                      padding: "3px 6px",
                      background: passed
                        ? "rgba(74,222,128,0.12)"
                        : "rgba(255,107,107,0.10)",
                      color: passed ? "var(--success, #4ade80)" : "var(--error, #ff6b6b)",
                    }}
                  >
                    {passed ? "✓" : "✗"} essai #{i + 1} — {cmd}
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      padding: 6,
                      fontSize: 10,
                      lineHeight: 1.4,
                      maxHeight: 160,
                      overflow: "auto",
                      whiteSpace: "pre-wrap",
                      color: "var(--on-surface-muted)",
                    }}
                  >
                    {out}
                  </pre>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Phase 7 #4 — Isolation worktree : statut du run isolé + actions
          Merger / Jeter. C'est LÀ que l'utilisateur relit le diff d'un run
          terminé et décide de merger ou de jeter (le merge n'est plus auto). */}
      <WorktreeIsolationSection
        events={events}
        sectionStyle={sectionStyle}
        labelStyle={labelStyle}
      />

      {/* Atelier — live preview of the built app (served by the preview:// handler) */}
      {isAtelierRun && (
        <div style={sectionStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span style={{ ...labelStyle, marginBottom: 0 }}>Aperçu de l'app</span>
            <span style={{ flex: 1 }} />
            <button
              onClick={() => setPreviewNonce((n) => n + 1)}
              style={{
                fontSize: 9,
                padding: "2px 8px",
                borderRadius: 4,
                background: "transparent",
                color: "var(--on-surface-muted)",
                border: "1px solid rgba(150,150,150,0.25)",
                cursor: "pointer",
              }}
            >
              Recharger
            </button>
          </div>
          <iframe
            key={previewNonce}
            src={`${previewOrigin()}/__atelier__/${agentId}/index.html?_=${previewNonce}`}
            style={{
              width: "100%",
              height: 260,
              border: "1px solid rgba(124,58,237,0.18)",
              borderRadius: 6,
              background: "#fff",
            }}
            sandbox="allow-scripts allow-same-origin"
            title="Aperçu de l'app construite par l'atelier"
          />
        </div>
      )}

      {/* Grounded — la frontière affichée vient de la row persistée V20. */}
      {row.role === "grounded" && hasExecRuns && (
        <div style={sectionStyle}>
          <div style={{ fontSize: 10.5, color: "var(--on-surface-muted)", lineHeight: 1.5 }}>
            {row.isolate
              ? "🌱 Cet agent travaille dans un worktree Git isolé. Examine puis merge ou jette ses changements ci-dessous."
              : "🌱 Cet agent travaille sur le checkout courant. Suis et annule ses modifications dans l’onglet Git."}
          </div>
        </div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Isolation worktree (Phase 7 #4) — statut du run isolé + actions.
//
// Quand l'isolation est demandée, le run tourne dans un worktree git sur sa
// propre branche et le merge n'est pas automatique. Cette section
// est l'endroit où l'utilisateur RELIT le diff puis décide :
//   • « Merger » → worktree_merge_back(branch) ;
//   • « Jeter »  → worktree_discard(branch) (derrière une confirmation, c'est
//                  destructif des changements de l'agent).
// On dérive le statut du transcript via extractWorktreeStatus (dernier event de
// chaque type gagne). useState local pour le busy des boutons + masquage d'une
// carte résolue (rien à persister : le backend nettoie le worktree, et un
// reload relira un transcript qui pointe sur la finalisation).
// ────────────────────────────────────────────────────────────────────

function WorktreeIsolationSection({
  events,
  sectionStyle,
  labelStyle,
}: {
  events: AgentEvent[];
  sectionStyle: React.CSSProperties;
  labelStyle: React.CSSProperties;
}) {
  const { started, finalized, skipped } = extractWorktreeStatus(events);

  // Busy d'action (merge/discard en vol) + masquage local d'une carte résolue
  // (l'utilisateur a mergé ou jeté → on retire la carte sans attendre un refetch).
  const [busy, setBusy] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // Rien d'isolé pour ce run (cas in-place classique) → on ne rend rien.
  if (!started && !finalized && !skipped) return null;

  // Une isolation demandée qui échoue arrête désormais le run (fail-closed).
  if (skipped) {
    return (
      <div
        style={{
          ...sectionStyle,
          background: "rgba(96, 165, 250, 0.06)",
          border: "1px solid rgba(96, 165, 250, 0.25)",
        }}
      >
        <span style={{ ...labelStyle, color: "var(--info, #60a5fa)" }}>Isolation</span>
        <div
          style={{
            fontSize: 11,
            lineHeight: 1.5,
            color: "var(--info, #60a5fa)",
          }}
        >
          ⛔ Run arrêté avant toute mutation : l’isolation demandée n’a pas pu être créée ({skipped.reason})
        </div>
      </div>
    );
  }

  const branch = finalized?.branch ?? started?.branch;

  const onMerge = async () => {
    if (!branch || busy) return;
    setBusy(true);
    try {
      const report = await worktreeMergeBack(branch);
      if (report.outcome === "merged") {
        pushToast(
          `✅ Mergé dans ton arbre${report.commit ? ` (${report.commit.slice(0, 8)})` : ""}`,
          "success",
        );
        setResolved(true);
      } else if (report.outcome === "no-changes") {
        pushToast("Rien à merger — le worktree ne contenait aucun changement.", "info");
        setResolved(true);
      } else if (report.outcome === "conflict") {
        const n = report.files?.length ?? 0;
        pushToast(
          `⚠ Conflit de merge${n ? ` sur ${n} fichier${n > 1 ? "s" : ""}` : ""} — le worktree est gardé, résous puis réessaie.`,
          "error",
          8000,
        );
        // On GARDE la carte : le worktree existe toujours côté backend.
      } else if (report.outcome === "dirty") {
        pushToast(
          "⚠ Ton arbre a des changements non commités — commit-les puis réessaie. Le worktree est gardé.",
          "error",
          8000,
        );
      } else {
        pushToast(`Merge : ${report.outcome}`, "info");
      }
    } catch (err) {
      pushToast(
        `Échec du merge : ${err instanceof Error ? err.message : String(err)}`,
        "error",
        8000,
      );
    } finally {
      setBusy(false);
    }
  };

  const onDiscard = async () => {
    if (!branch || busy) return;
    setConfirmDiscard(false);
    setBusy(true);
    try {
      await worktreeDiscard(branch);
      pushToast("Run isolé jeté — ton checkout principal est resté intact.", "info");
      setResolved(true);
    } catch (err) {
      pushToast(
        `Échec du rejet : ${err instanceof Error ? err.message : String(err)}`,
        "error",
        8000,
      );
    } finally {
      setBusy(false);
    }
  };

  // Carte résolue localement (mergée / jetée / no-changes) → on l'efface.
  if (resolved) return null;

  // Statut texte court pour les finalisations déjà décidées côté backend.
  if (finalized && finalized.outcome !== "diff") {
    const label =
      finalized.outcome === "merged"
        ? { text: "✅ Mergé", color: "var(--success, #4ade80)" }
        : finalized.outcome === "no-changes"
          ? { text: "rien à merger", color: "var(--on-surface-variant, #a5a0bf)" }
          : finalized.outcome === "discarded"
            ? { text: "jeté", color: "var(--on-surface-variant, #a5a0bf)" }
            : { text: finalized.outcome, color: "var(--on-surface-variant, #a5a0bf)" };
    return (
      <div style={sectionStyle}>
        <span style={labelStyle}>Isolation</span>
        <div style={{ fontSize: 11, color: label.color }}>
          {label.text}
          {branch && (
            <span
              style={{
                marginLeft: 6,
                fontFamily: "var(--font-mono)",
                color: "var(--on-surface-variant, #a5a0bf)",
              }}
            >
              {branch}
            </span>
          )}
        </div>
      </div>
    );
  }

  // Finalisé en "diff" → l'utilisateur relit + décide (Merger / Jeter).
  if (finalized && finalized.outcome === "diff") {
    return (
      <div style={sectionStyle}>
        <span style={labelStyle}>Isolation — diff prêt à relire</span>
        {branch && (
          <div
            style={{
              fontSize: 11,
              marginBottom: 6,
              fontFamily: "var(--font-mono)",
              color: "var(--on-surface-variant, #a5a0bf)",
            }}
          >
            🔒 {branch}
            {finalized.reason && (
              <span style={{ marginLeft: 6, fontStyle: "italic" }}>
                — pas mergé auto : {finalized.reason}
              </span>
            )}
          </div>
        )}
        {finalized.diff && (
          <pre
            style={{
              margin: "0 0 8px",
              padding: 6,
              fontSize: 10,
              lineHeight: 1.4,
              maxHeight: 200,
              overflow: "auto",
              whiteSpace: "pre-wrap",
              borderRadius: 6,
              background: "rgba(0,0,0,0.18)",
              color: "var(--on-surface, #ddd)",
            }}
          >
            {finalized.diff}
          </pre>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => void onMerge()}
            disabled={busy || !branch}
            style={{
              fontSize: 11,
              fontWeight: 700,
              padding: "5px 14px",
              borderRadius: 6,
              background: "rgba(74, 222, 128, 0.16)",
              color: "var(--success, #4ade80)",
              border: "1px solid rgba(74, 222, 128, 0.45)",
              cursor: busy || !branch ? "default" : "pointer",
              opacity: busy || !branch ? 0.5 : 1,
              fontFamily: "inherit",
            }}
          >
            {busy ? "…" : "Merger"}
          </button>
          <button
            type="button"
            onClick={() => setConfirmDiscard(true)}
            disabled={busy || !branch}
            style={{
              fontSize: 11,
              fontWeight: 700,
              padding: "5px 14px",
              borderRadius: 6,
              background: "rgba(255, 106, 138, 0.16)",
              color: "var(--danger, #ff6a8a)",
              border: "1px solid rgba(255, 106, 138, 0.45)",
              cursor: busy || !branch ? "default" : "pointer",
              opacity: busy || !branch ? 0.5 : 1,
              fontFamily: "inherit",
            }}
          >
            Jeter
          </button>
        </div>
        <ConfirmDialog
          open={confirmDiscard}
          tone="danger"
          title="Jeter ce run isolé ?"
          body={
            <>
              <p style={{ margin: "0 0 8px" }}>
                Les changements de l'agent sur la branche <code>{branch}</code> seront{" "}
                <b>supprimés définitivement</b> (worktree + branche).
              </p>
              <p style={{ margin: 0 }}>
                Ton checkout principal n'a jamais été touché — il reste intact.
              </p>
            </>
          }
          confirmLabel="Jeter quand même"
          cancelLabel="Annuler"
          onConfirm={() => void onDiscard()}
          onCancel={() => setConfirmDiscard(false)}
        />
      </div>
    );
  }

  // Démarré mais pas encore finalisé → run isolé en cours.
  return (
    <div style={sectionStyle}>
      <span style={labelStyle}>Isolation</span>
      <div style={{ fontSize: 11, color: "var(--on-surface, #ddd)" }}>
        🔒 Isolé dans{" "}
        <span style={{ fontFamily: "var(--font-mono)", color: "var(--primary, #7c3aed)" }}>
          {started?.branch}
        </span>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Main panel — TanStack data, useState local pour la sélection.
// ────────────────────────────────────────────────────────────────────

export function AgentsPanel() {
  const { data: agents = [], isLoading } = useActiveAgents();
  // selectedId est globalement géré via TanStack (queryKey ["agents","selected"])
  // pour permettre à RootLayout de set la sélection depuis le listener
  // `app://reveal-agent` (clic sur "via Orchestrateur" chip dans le chat).
  const selectedId = useSelectedAgentId();
  const setSelectedId = setSelectedAgentId;

  const running = agents.filter((a) => a.status === "running").length;

  // Force un re-render chaque seconde tant qu'au moins un agent tourne,
  // pour que `fmtAge(row.createdAt)` (qui lit Date.now()) tick en live.
  // Sans ça l'age est figé jusqu'au prochain event (spawn/complete) qui
  // invalide useActiveAgents.
  useTick(1000, running > 0);

  // ── Atelier launcher state + the SkillLearned → refetch-skills listener ──
  const [modelId] = useActiveModel();
  const [atelierTask, setAtelierTask] = useState("");
  const [launching, setLaunching] = useState(false);
  const [atelierErr, setAtelierErr] = useState<string | null>(null);

  // ── Grounded Run launcher state + git-safety-net preflight ──
  const [groundedTask, setGroundedTask] = useState("");
  const [groundedTestCmd, setGroundedTestCmd] = useState("");
  const [groundedLaunching, setGroundedLaunching] = useState(false);
  const [groundedErr, setGroundedErr] = useState<string | null>(null);
  const [execCap, setExecCap] = useState<ExecCapability | null>(null);
  // Trust-UX (Lane 5) — quand le filet git est absent/partiel, un Grounded Run
  // exécute de vraies commandes SANS garantie de pouvoir tout annuler. On demande
  // une confirmation explicite avant de lancer dans ce cas (sinon lancement direct).
  const [confirmRiskyRun, setConfirmRiskyRun] = useState(false);

  // Probe the git safety net once on mount (exec directe : toujours possible,
  // le préflight ne sert qu'à afficher un avertissement NON bloquant quand le
  // filet git est absent ou partiel). Re-probed via "Revérifier" après un
  // commit / git init. A rejected IPC = unknown → no warning shown.
  const refreshPreflight = async () => {
    try {
      setExecCap(await execPreflight());
    } catch {
      setExecCap(null);
    }
  };
  useEffect(() => {
    void refreshPreflight();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        const mod = await import("@tauri-apps/api/event");
        unlisten = await mod.listen<AgentEvent>("agent://lifecycle", (e) => {
          if (e.payload.kind === "skillLearned") invalidateSkills(e.payload.role);
        });
      } catch (err) {
        console.warn("[AgentsPanel] skillLearned listen failed:", err);
      }
    })();
    return () => unlisten?.();
  }, []);

  const launchAtelier = async (task: string) => {
    const t = task.trim();
    if (!t || launching) return;
    setLaunching(true);
    setAtelierErr(null);
    try {
      const resolved = await resolveActiveProviderConfig(modelId);
      const id = await atelierRun({
        task: t,
        model: resolved.model,
        protocol: resolved.protocol,
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
      });
      setSelectedId(id);
      setAtelierTask("");
    } catch (err) {
      setAtelierErr(err instanceof Error ? err.message : String(err));
    } finally {
      setLaunching(false);
    }
  };

  // Exec directe : seul "aucun projet ouvert" bloque (ready=false). Un filet
  // git absent/partiel n'empêche PAS le lancement — il affiche un warning.
  const execReady = execCap?.ready !== false;
  // Le filet git est solide quand le préflight ne renvoie AUCUN warning.
  const safetyNetOk = execReady && !execCap?.warning;

  // Lance réellement le Grounded Run (après confirmation si nécessaire).
  const doLaunchGrounded = async () => {
    const t = groundedTask.trim();
    if (!t || groundedLaunching || !execReady) return;
    setGroundedLaunching(true);
    setGroundedErr(null);
    try {
      const resolved = await resolveActiveProviderConfig(modelId);
      const id = await groundedRun({
        task: t,
        model: resolved.model,
        protocol: resolved.protocol,
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
        testCommand: groundedTestCmd.trim() || undefined,
      });
      setSelectedId(id);
      setGroundedTask("");
    } catch (err) {
      setGroundedErr(err instanceof Error ? err.message : String(err));
    } finally {
      setGroundedLaunching(false);
    }
  };

  // Point d'entrée du bouton : si le filet git manque, on confirme d'abord
  // (l'exécution est réelle et potentiellement non réversible sans filet) ;
  // sinon on lance directement.
  const requestLaunchGrounded = () => {
    const t = groundedTask.trim();
    if (!t || groundedLaunching || !execReady) return;
    if (!safetyNetOk) {
      setConfirmRiskyRun(true);
      return;
    }
    void doLaunchGrounded();
  };

  // Top-level filtering: only show ROOT agents (no parent). Sub-agents
  // (Phase 1+) would appear nested under their parent in a future drawer
  // variant; flat for now.
  const rootAgents = agents.filter((a) => !a.parentId);

  return (
    <div style={{ padding: 8, fontSize: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: 11, color: "var(--on-surface-muted)" }}>
          {running} running · {agents.length} total
        </span>
      </div>

      {/* Atelier — env-grounded build → test → learn loop. PARQUÉ 2026-05-29
          derrière `ATELIER_UI_ENABLED` : code backend intact (`agent_atelier_run`,
          exec directe), UI masquée le temps qu'on tranche son utilité produit.
          La carte revient en flippant le flag. */}
      {ATELIER_UI_ENABLED && (
      <div
        style={{
          marginBottom: 12,
          padding: 10,
          borderRadius: 8,
          background: "rgba(124, 58, 237, 0.06)",
          border: "1px solid rgba(124, 58, 237, 0.22)",
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: "var(--primary, #7c3aed)",
            marginBottom: 4,
          }}
        >
          🛠️ Atelier — apprentissage par l'environnement
        </div>
        <div
          style={{
            fontSize: 10.5,
            color: "var(--on-surface-muted)",
            lineHeight: 1.5,
            marginBottom: 8,
          }}
        >
          L'agent construit une UI web dans un dossier de création jetable, la{" "}
          <b>teste pour de vrai</b> dans un navigateur (Playwright), corrige sur l'échec réel,
          et ne garde un <b>skill vérifié</b> qu'une fois le test au vert. La boucle, l'app et
          le skill s'affichent dans le transcript.
        </div>
        <textarea
          value={atelierTask}
          onChange={(e) => setAtelierTask(e.target.value)}
          placeholder="Décris l'app web à construire + tester…"
          rows={2}
          style={{
            width: "100%",
            boxSizing: "border-box",
            resize: "vertical",
            fontSize: 11,
            padding: "6px 8px",
            borderRadius: 6,
            background: "var(--surface, #14141f)",
            color: "var(--on-surface, #ddd)",
            border: "1px solid rgba(124, 58, 237, 0.25)",
            fontFamily: "inherit",
          }}
        />
        <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
          <button
            onClick={() => void launchAtelier(atelierTask)}
            disabled={launching || !atelierTask.trim()}
            style={{
              fontSize: 10,
              padding: "4px 12px",
              borderRadius: 4,
              background: "rgba(124, 58, 237, 0.22)",
              color: "var(--primary, #7c3aed)",
              border: "1px solid rgba(124, 58, 237, 0.45)",
              cursor: launching || !atelierTask.trim() ? "default" : "pointer",
              opacity: launching || !atelierTask.trim() ? 0.6 : 1,
            }}
          >
            {launching ? "Lancement…" : "Lancer l'atelier"}
          </button>
          <button
            onClick={() => void launchAtelier(ATELIER_TODO_PRESET)}
            disabled={launching}
            style={{
              fontSize: 10,
              padding: "4px 12px",
              borderRadius: 4,
              background: "transparent",
              color: "var(--on-surface-muted)",
              border: "1px solid rgba(150,150,150,0.3)",
              cursor: launching ? "default" : "pointer",
              opacity: launching ? 0.6 : 1,
            }}
            title="Démo : une to-do list que l'agent construit puis teste au navigateur"
          >
            🧪 Démo : to-do list
          </button>
        </div>
        {atelierErr && (
          <div style={{ marginTop: 6, fontSize: 10, color: "var(--error, #ff6b6b)" }}>
            {atelierErr}
          </div>
        )}
      </div>
      )}

      {/* Grounded Run — exec DIRECTE sur le vrai projet (pivot 2026-06-10).
          Trust-UX (Lane 5) : le bloc vert « ça a l'air safe » devient une CARTE
          DE RISQUE explicite. Le tier est « Exécution » (rouge) — un Grounded Run
          lance de vraies commandes et écrit sur le disque ; le vert n'est plus le
          message principal. Le filet git est affiché honnêtement (solide = vert,
          absent = avertissement) AVANT le lancement, et un lancement sans filet
          demande une confirmation explicite. */}
      <ExecutionProfileCard
        title="Grounded Run — l'agent code ET teste sur le vrai projet"
        glyph="🌱"
        risk="exec"
        summary={
          <>
            L'agent travaille <b>directement sur ton projet</b> avec la vraie toolchain
            (pnpm, node, cargo…), lance les tests, corrige sur les <b>échecs réels</b> et
            relance jusqu'au vert. Le filet de sécurité, c'est <b>git</b> : chaque
            modification apparaît dans l'onglet <b>Git</b>, où tu peux l'examiner et l'annuler.
          </>
        }
        safetyNet={
          execReady
            ? {
                ok: safetyNetOk,
                message: safetyNetOk
                  ? "Filet git actif — chaque modification de ce run est réversible dans l'onglet Git."
                  : execCap?.warning ??
                    "Pas de dépôt git détecté — les modifications de ce run ne pourront pas être annulées en un clic.",
                onRecheck: () => void refreshPreflight(),
              }
            : undefined
        }
      >
        <textarea
          value={groundedTask}
          onChange={(e) => setGroundedTask(e.target.value)}
          placeholder="Décris la tâche de code à réaliser sur le projet ouvert…"
          rows={2}
          style={{
            width: "100%",
            boxSizing: "border-box",
            resize: "vertical",
            fontSize: 11,
            padding: "6px 8px",
            borderRadius: 6,
            background: "var(--surface, #14141f)",
            color: "var(--on-surface, #ddd)",
            border: "1px solid rgba(255,255,255,0.12)",
            fontFamily: "inherit",
          }}
        />
        <input
          value={groundedTestCmd}
          onChange={(e) => setGroundedTestCmd(e.target.value)}
          placeholder="Commande de vérif (optionnel) — ex. pnpm typecheck"
          style={{
            width: "100%",
            boxSizing: "border-box",
            fontSize: 11,
            padding: "6px 8px",
            marginTop: 6,
            borderRadius: 6,
            background: "var(--surface, #14141f)",
            color: "var(--on-surface, #ddd)",
            border: "1px solid rgba(255,255,255,0.08)",
            fontFamily: "var(--font-mono)",
          }}
        />
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={requestLaunchGrounded}
            disabled={groundedLaunching || !groundedTask.trim() || !execReady}
            title={
              !execReady
                ? execCap?.warning ?? "Ouvre un dossier d'abord"
                : safetyNetOk
                  ? "Lancer un Grounded Run sur le projet ouvert"
                  : "Lancer sans filet git — une confirmation sera demandée"
            }
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: "5px 14px",
              borderRadius: 6,
              // Le bouton porte la couleur du TIER (exécution = danger), pas un
              // vert rassurant : on lance une exécution réelle.
              background: "rgba(255, 106, 138, 0.16)",
              color: "var(--danger, #ff6a8a)",
              border: "1px solid rgba(255, 106, 138, 0.45)",
              cursor:
                groundedLaunching || !groundedTask.trim() || !execReady ? "default" : "pointer",
              opacity: groundedLaunching || !groundedTask.trim() || !execReady ? 0.5 : 1,
              fontFamily: "inherit",
            }}
          >
            {groundedLaunching ? "Lancement…" : "🌱 Lancer (exécution réelle)"}
          </button>
        </div>
        {groundedErr && (
          <div style={{ marginTop: 8 }}>
            <InlineNotice tone="danger">{groundedErr}</InlineNotice>
          </div>
        )}
      </ExecutionProfileCard>

      {/* Confirmation avant un Grounded Run SANS filet git (actions potentiellement
          non réversibles). Lancement direct quand le filet est solide. */}
      <ConfirmDialog
        open={confirmRiskyRun}
        tone="danger"
        title="Lancer sans filet de sécurité ?"
        body={
          <>
            <p style={{ margin: "0 0 8px" }}>
              {execCap?.warning ??
                "Aucun dépôt git n'a été détecté dans ce projet."}
            </p>
            <p style={{ margin: 0 }}>
              Ce Grounded Run va <b>écrire des fichiers</b> et <b>exécuter de vraies
              commandes</b>. Sans dépôt git, ses modifications ne pourront pas être
              annulées en un clic. Tu peux <code>git init</code> + un premier commit
              pour activer le filet, puis « Revérifier ».
            </p>
          </>
        }
        confirmLabel="Lancer quand même"
        cancelLabel="Annuler"
        onConfirm={() => {
          setConfirmRiskyRun(false);
          void doLaunchGrounded();
        }}
        onCancel={() => setConfirmRiskyRun(false)}
      />

      {isLoading ? (
        <div
          style={{
            padding: 16,
            textAlign: "center",
            fontSize: 11,
            color: "var(--on-surface-muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          Chargement…
        </div>
      ) : rootAgents.length === 0 ? (
        <div
          style={{
            padding: 16,
            textAlign: "center",
            fontSize: 11,
            color: "var(--on-surface-muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          No agents yet — click "+ Spawn test agent" to verify the pipeline.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {rootAgents.map((row) => (
            <AgentRowItem
              key={row.id}
              row={row}
              isSelected={selectedId === row.id}
              onSelect={setSelectedId}
            />
          ))}
        </div>
      )}

      {selectedId && (
        <TranscriptDrawer
          agentId={selectedId}
          onClose={() => setSelectedId(null)}
        />
      )}

      {(["atelier", "orchestrator", "coder"] as const).map((r) => (
        <SkillsSection key={r} role={r} />
      ))}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Skills section — the role's env-verified learned skills (Voyager/Hermes),
// woven into the main panel (no separate window). Refetched when a
// `skillLearned` event invalidates the query (see the listener above).
// ────────────────────────────────────────────────────────────────────

function SkillsSection({ role }: { role: string }) {
  const { data: skills = [] } = useSkillsList(role);
  const [open, setOpen] = useState(true);
  if (skills.length === 0) return null;
  return (
    <div
      style={{
        marginTop: 14,
        borderTop: "1px solid rgba(150,150,150,0.12)",
        paddingTop: 8,
      }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: "var(--success, #4ade80)",
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: 0,
        }}
      >
        🎓 Compétences apprises — {role} ({skills.length}) {open ? "▾" : "▸"}
      </button>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
          {skills.map((s) => (
            <div
              key={s.name}
              style={{
                padding: "6px 8px",
                borderRadius: 6,
                background: s.createdBy === "advisor"
                  ? "rgba(124, 58, 237, 0.06)"
                  : "rgba(74, 222, 128, 0.06)",
                border: s.createdBy === "advisor"
                  ? "1px solid rgba(124, 58, 237, 0.18)"
                  : "1px solid rgba(74, 222, 128, 0.18)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div
                  style={{ fontSize: 11, fontWeight: 600, color: "var(--on-surface, #ddd)" }}
                >
                  {s.name}
                </div>
                {s.createdBy === "advisor" && (
                  <span
                    title="Distillé par l'advisor (reviewer externe)"
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      padding: "1px 5px",
                      borderRadius: 99,
                      background: "rgba(124, 58, 237, 0.2)",
                      color: "var(--primary, #7c3aed)",
                      border: "1px solid rgba(124, 58, 237, 0.4)",
                      lineHeight: "14px",
                    }}
                  >
                    via advisor
                  </span>
                )}
              </div>
              {s.whenToUse && (
                <div
                  style={{ fontSize: 10, color: "var(--on-surface-muted)", marginTop: 2 }}
                >
                  {s.whenToUse}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
