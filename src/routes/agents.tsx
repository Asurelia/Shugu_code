// Lazy route module for /agents — gestionnaire visuel d'agents personnalisés.
//
// Refonte 2026-05-26 : la page n'est plus un panneau d'observabilité de runs
// (l'ancien `AgentsPanel`) mais un GESTIONNAIRE de définitions d'agents
// portables au format Claude Code (.md + frontmatter). L'observabilité brute
// (transcripts live) reste accessible en secondaire au clic sur une carte
// — voir le plan `harmonic-tinkering-hearth.md`.
import { AgentDefsManager } from "@/features/agents/AgentDefsManager";

export default function AgentsRouteComponent() {
  return (
    <div className="agent-shell scroll">
      <AgentDefsManager />
    </div>
  );
}
