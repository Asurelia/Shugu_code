// Lazy route module for /harness — Continual Harness panel (lot 1 UI).
// Loaded on first navigation to /harness. Self-contained: no ShellContext
// dependency, so it mounts cleanly without touching the editor shell.
import { HarnessPanel } from "@/features/agents/HarnessPanel";

export default function HarnessRouteComponent() {
  return <HarnessPanel />;
}
