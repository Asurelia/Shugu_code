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
import { spawnAgent, killAgent, type AgentRow, type AgentEvent } from "@/lib/agents";
import {
  useActiveAgents,
  useAgentTranscript,
  useSelectedAgentId,
  setSelectedAgentId,
} from "./queries";

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
    <div
      onClick={() => onSelect(isSelected ? null : row.id)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 8px",
        borderRadius: 6,
        cursor: "pointer",
        background: isSelected ? "rgba(124, 58, 237, 0.08)" : "transparent",
        border: isSelected
          ? "1px solid rgba(124, 58, 237, 0.35)"
          : "1px solid transparent",
      }}
    >
      <StatusBadge status={row.status} />
      <span style={{ fontSize: 11, fontWeight: 600 }}>{row.role}</span>
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
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// Drawer — minimal observability per user requirement (2026-05-17) :
//   Tâche transmise → Activité (si en cours) → Réponse finale OU erreur.
//   On NE rend PAS les events intermédiaires (delta, toolCall, toolResult,
//   messages intermédiaires) pour éviter le coût DOM qui causait le freeze.
// ────────────────────────────────────────────────────────────────────

function TranscriptDrawer({
  agentId,
  onClose,
}: {
  agentId: string;
  onClose: () => void;
}) {
  const { data, isLoading } = useAgentTranscript(agentId);

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

  const handleSpawnTest = async () => {
    try {
      await spawnAgent({
        role: "orchestrator",
        task: "Phase 0 smoke test — verify end-to-end pipeline",
        model: "phase-0-synthetic",
      });
    } catch (err) {
      console.warn("[AgentsPanel] spawn test failed:", err);
    }
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
        <span style={{ flex: 1 }} />
        <button
          onClick={() => void handleSpawnTest()}
          style={{
            fontSize: 10,
            padding: "3px 10px",
            borderRadius: 4,
            background: "rgba(124, 58, 237, 0.18)",
            color: "var(--primary, #7c3aed)",
            border: "1px solid rgba(124, 58, 237, 0.4)",
            cursor: "pointer",
          }}
          title="Phase 0 debug — spawns a synthetic agent that emits Spawn → Message → Complete events on its own. Validates the plumbing end-to-end without an LLM."
        >
          + Spawn test agent
        </button>
      </div>

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
    </div>
  );
}
