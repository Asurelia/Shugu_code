// Shugu Forge — AgentPlan (checklist du plan vivant de l'orchestrateur).
//
// Plan vivant produit par le tool `todo_write` — checklist qui se coche au fil
// de l'exécution (☐ à faire, ◐ en cours, ☑ fait), format façon Claude Code.
// Partagé entre le fil de chat (views-chat.tsx) et l'onglet "Plan" du panneau
// Contexte (context-cards/cards.tsx) — règle mémoire « pas de duplication de
// rendu ». N'apparaît que si l'agent a réellement posé un plan.

import type { AgentPlanStep } from "./useMessageDisplay";

export function AgentPlan({ steps }: { steps: AgentPlanStep[] }) {
  const done = steps.filter((s) => s.status === "completed").length;
  return (
    <details className="cx-agent-plan" open>
      <summary>
        <span className="hl">Plan</span>
        <span className="ct">{done}/{steps.length}</span>
      </summary>
      <ul>
        {steps.map((s, i) => (
          <li key={i} className={"pstep " + s.status}>
            <span className="box">
              {s.status === "completed" ? "☑" : s.status === "in_progress" ? "◐" : "☐"}
            </span>
            <span className="txt">{s.text}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
