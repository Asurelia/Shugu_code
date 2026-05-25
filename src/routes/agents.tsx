// Lazy route module for /agents — the full, REAL agents workspace.
//
// Renders the live `AgentsPanel`: real active agents from SQLite (no mock),
// the Atelier launcher (build → test-for-real → learn), and click-to-transcript
// with the environment-test runs, the live preview, and the verified-skill
// badge. Previously this route showed a hardcoded `seedAgents` mock via
// `AgentsView` — that fake panel is gone.
import { AgentsPanel } from "@/features/agents/AgentsPanel";

export default function AgentsRouteComponent() {
  return (
    <div className="agent-shell scroll">
      <AgentsPanel />
    </div>
  );
}
