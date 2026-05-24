// Lazy route module for /studio — the unified Design Studio shell. Renders the
// Inspiration | Créer sub-tabs and a nested <Outlet/> for the sub-routes
// (/studio = Créer assistant, /studio/inspiration = catalogue). The leaf views
// own their own state.
import { StudioShell } from "@/features/studio/StudioShell";

export default function StudioShellRoute() {
  return <StudioShell />;
}
