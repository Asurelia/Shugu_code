// Shugu Forge — Design Studio shell (unified Design + Studio).
//
// The Studio is now the single creative surface. The old standalone Design
// catalogue became a sub-page of it: "Inspiration" (browse existing design
// systems as a starting base) sits next to "Créer" (the 3-step assistant +
// live preview). Both are real sub-routes under /studio, sharing this chrome
// via a nested <Outlet/>:
//   /studio              → Créer   (the assistant)
//   /studio/inspiration  → Inspiration (the catalogue, systems-only)

import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { Icon } from "@/components/components";

export function StudioShell() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onProjects = pathname.startsWith("/studio/projects");
  const onInspiration = pathname.startsWith("/studio/inspiration");
  const onCreate = !onProjects && !onInspiration;

  return (
    <div className="studio-root">
      <div className="studio-subnav" role="tablist">
        <button
          className={"studio-subtab" + (onCreate ? " is-active" : "")}
          onClick={() => navigate({ to: "/studio" })}
          role="tab"
          aria-selected={onCreate}
        >
          <Icon name="sparkle" size={13} /> Créer
        </button>
        <button
          className={"studio-subtab" + (onProjects ? " is-active" : "")}
          onClick={() => navigate({ to: "/studio/projects" })}
          role="tab"
          aria-selected={onProjects}
        >
          <Icon name="folder" size={13} /> Projets
        </button>
        <button
          className={"studio-subtab" + (onInspiration ? " is-active" : "")}
          onClick={() => navigate({ to: "/studio/inspiration" })}
          role="tab"
          aria-selected={onInspiration}
        >
          <Icon name="palette" size={13} /> Inspiration
        </button>
      </div>
      <div className="studio-outlet">
        <Outlet />
      </div>
    </div>
  );
}
