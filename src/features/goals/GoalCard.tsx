import { useMemo, useState } from "react";
import { Icon } from "@/components/components";
import { pushToast } from "@/components/toast";
import { archiveGoal, type GoalRow, type GoalStatus } from "@/lib/goals";
import { revealAgent } from "@/lib/agents";
import { resumeGoal } from "@/features/chat/chat-sync";
import { queryClient } from "@/lib/queryClient";
import { goalKeys, useGoalsByConversation } from "./queries";
import "./goal-card.css";

const STATUS: Record<
  GoalStatus,
  { label: string; detail: string; tone: string }
> = {
  active: {
    label: "En cours",
    detail: "Shugu poursuit cet objectif jusqu’à une validation réelle.",
    tone: "active",
  },
  waiting: {
    label: "En attente",
    detail: "Une question ou un plan attend ta réponse dans le fil.",
    tone: "waiting",
  },
  paused: {
    label: "À reprendre",
    detail: "L’objectif est conservé. Tu peux repartir depuis l’état réel du projet.",
    tone: "paused",
  },
  completed: {
    label: "Terminé",
    detail: "Le cycle agentique et sa vérification sont terminés.",
    tone: "completed",
  },
  cancelled: {
    label: "Arrêté",
    detail: "L’objectif reste archivé avec son historique.",
    tone: "cancelled",
  },
};

function formatUpdated(timestamp: number): string {
  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "short",
  }).format(new Date(timestamp));
}

function GoalSummary({
  goal,
  extraCount,
}: {
  goal: GoalRow;
  extraCount: number;
}) {
  const [open, setOpen] = useState(goal.status === "paused");
  const [busy, setBusy] = useState(false);
  const meta = STATUS[goal.status];

  const openRun = () => {
    if (goal.currentAgentId) void revealAgent(goal.currentAgentId);
  };

  const resume = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await resumeGoal(goal);
    } catch (error) {
      pushToast(`Reprise du Goal impossible : ${String(error)}`, "error", 7000);
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await archiveGoal(goal.id);
      await queryClient.invalidateQueries({ queryKey: goalKeys.all });
    } catch (error) {
      pushToast(`Archivage impossible : ${String(error)}`, "error", 6000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`goal-card goal-${meta.tone}`} aria-label={`Goal : ${goal.title}`}>
      <button
        type="button"
        className="goal-card-main"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="goal-card-icon"><Icon name="goal" size={15} /></span>
        <span className="goal-card-copy">
          <span className="goal-card-kicker">
            Goal durable
            {extraCount > 0 && <span className="goal-card-count">+{extraCount}</span>}
          </span>
          <span className="goal-card-title">{goal.title}</span>
        </span>
        <span className={`goal-card-status is-${meta.tone}`}>
          <span className="goal-status-dot" />
          {meta.label}
        </span>
        <Icon name="down" size={11} className={open ? "goal-chevron open" : "goal-chevron"} />
      </button>

      {goal.status === "active" && <span className="goal-card-progress" aria-hidden="true" />}

      {open && (
        <div className="goal-card-details">
          <p className="goal-card-objective">{goal.objective}</p>
          <div className="goal-card-meta">
            <span>{meta.detail}</span>
            <span className="goal-meta-sep">·</span>
            <span>{goal.model}</span>
            {goal.resumeCount > 0 && (
              <>
                <span className="goal-meta-sep">·</span>
                <span>{goal.resumeCount} reprise{goal.resumeCount > 1 ? "s" : ""}</span>
              </>
            )}
            <span className="goal-meta-sep">·</span>
            <span>{formatUpdated(goal.updatedAt)}</span>
          </div>
          {goal.lastError && <div className="goal-card-error">{goal.lastError}</div>}
          <div className="goal-card-actions">
            {goal.status === "paused" && (
              <button type="button" className="goal-action primary" disabled={busy} onClick={() => void resume()}>
                <Icon name="play" size={12} />
                {busy ? "Reprise…" : "Reprendre"}
              </button>
            )}
            {goal.currentAgentId && (
              <button type="button" className="goal-action" onClick={openRun}>
                <Icon name="agent" size={12} />
                Voir l’exécution
              </button>
            )}
            {(goal.status === "completed" || goal.status === "cancelled" || goal.status === "paused") && (
              <button type="button" className="goal-action quiet" disabled={busy} onClick={() => void archive()}>
                Archiver
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export function GoalCard({ conversationId }: { conversationId: string }) {
  const { data: goals = [] } = useGoalsByConversation(conversationId);
  const current = useMemo(() => goals[0] ?? null, [goals]);
  if (!current) return null;
  return <GoalSummary goal={current} extraCount={Math.max(0, goals.length - 1)} />;
}
