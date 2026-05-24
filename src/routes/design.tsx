// Lazy route module for /studio/inspiration — the open-design catalogue
// (design systems, systems-only) used as a starting base for generation. Thin
// pass-through; DesignView owns its own state. (Still named design.tsx — it IS
// the design catalogue, just mounted as a Studio sub-route now.)
import { DesignView } from "@/features/design/DesignView";

export default function DesignRouteComponent() {
  return <DesignView />;
}
