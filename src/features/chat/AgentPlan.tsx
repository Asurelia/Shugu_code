// Shugu Forge — AgentPlan (checklist du plan vivant de l'orchestrateur).
//
// Plan vivant produit par le tool `todo_write` — LOT 1 : un task-graph
// dependency-aware. Chaque étape se coche au fil de l'exécution (☐ à faire,
// ◐ en cours, ☑ fait), avec ses dépendances (« après T1 ») et un état « bloqué »
// DÉRIVÉ (⊘) quand toutes ses dépendances ne sont pas encore terminées. Format
// façon Claude Code. Partagé entre le fil de chat (views-chat.tsx) et l'onglet
// « Plan » du panneau Contexte (context-cards/cards.tsx) — règle mémoire « pas
// de duplication de rendu ». N'apparaît que si l'agent a réellement posé un plan.

import type { AgentPlanStep } from "./useMessageDisplay";

const STATUS_LABEL: Record<AgentPlanStep["status"], string> = {
  completed: "terminé",
  in_progress: "en cours",
  pending: "à faire",
};

export function AgentPlan({ steps }: { steps: AgentPlanStep[] }) {
  const done = steps.filter((s) => s.status === "completed").length;
  // Ids terminés → sert à dériver l'état « bloqué » (une étape non terminée dont
  // au moins une dépendance n'est pas encore cochée).
  const completed = new Set(steps.filter((s) => s.status === "completed").map((s) => s.id));
  // Les ids ne s'affichent QUE si le plan utilise des dépendances — un plan
  // linéaire simple reste épuré (juste ☐ + texte), sans bruit.
  const hasDeps = steps.some((s) => s.dependsOn && s.dependsOn.length > 0);

  return (
    <details className="cx-agent-plan" open>
      <summary>
        <span className="hl">Plan</span>
        <span className="ct">{done}/{steps.length}</span>
      </summary>
      <ul>
        {steps.map((s, i) => {
          const blocked =
            s.status !== "completed" && (s.dependsOn?.some((d) => !completed.has(d)) ?? false);
          const label = blocked ? "bloqué" : STATUS_LABEL[s.status];
          const glyph =
            s.status === "completed"
              ? "☑"
              : s.status === "in_progress"
                ? "◐"
                : blocked
                  ? "⊘"
                  : "☐";
          return (
            <li
              // `s.id#i` : l'index désambiguïse une éventuelle collision d'id
              // (auto-assigné T1 qui percute un T1 explicite) — clé toujours unique.
              key={`${s.id}#${i}`}
              className={"pstep " + s.status + (blocked ? " blocked" : "")}
              // L'état est porté par le glyphe + le texte/style (pas la couleur
              // seule) ; aria-label le rend explicite aux lecteurs d'écran.
              aria-label={`${label} : ${s.text}`}
              title={s.doneWhen ? `Fini quand : ${s.doneWhen}` : undefined}
            >
              <span className="box" aria-hidden="true">
                {glyph}
              </span>
              {hasDeps ? <span className="pid">{s.id}</span> : null}
              <span className="txt">{s.text}</span>
              {s.dependsOn && s.dependsOn.length ? (
                <span className="pdep">après {s.dependsOn.join(", ")}</span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
