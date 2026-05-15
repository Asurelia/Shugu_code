// Lazy route module for /agents — loaded on first navigation to /agents.
import { useShell } from "@/routes/shell-context";
import { AgentsView } from "@/features/code/views-code";

export default function AgentsRouteComponent() {
  const { agents } = useShell();
  return <AgentsView agents={agents} />;
}
