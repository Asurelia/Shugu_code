// Lazy route module for /studio (index) — the "Créer" sub-page: the 3-step
// generation assistant + live preview. Rendered inside StudioShell's <Outlet/>.
import { StudioView } from "@/features/studio/StudioView";

export default function StudioCreateRoute() {
  return <StudioView />;
}
