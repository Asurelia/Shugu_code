// Shugu Forge — Design Studio shell (unified Design + Studio).
//
// The Studio is now the single creative surface. The old standalone Design
// catalogue became a sub-page of it: "Inspiration" (browse existing design
// systems as a starting base) sits next to "Créer" (the 3-step assistant +
// live preview). Both are real sub-routes under /studio, sharing this chrome
// via a nested <Outlet/>:
//   /studio              → Créer   (the assistant)
//   /studio/brand        → Marque  (brand direction + image references)
//   /studio/inspiration  → Inspiration (the catalogue, systems-only)

import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { Icon } from "@/components/components";
import { useActiveDesignSystem } from "@/features/design/activeDesignSystem";

export function StudioShell() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const onProjects = pathname.startsWith("/studio/projects");
  const onBrand = pathname.startsWith("/studio/brand");
  const onInspiration = pathname.startsWith("/studio/inspiration");
  const onCreate = !onProjects && !onBrand && !onInspiration;
  const activeDesign = useActiveDesignSystem();

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
          className={"studio-subtab" + (onBrand ? " is-active" : "")}
          onClick={() => navigate({ to: "/studio/brand" })}
          role="tab"
          aria-selected={onBrand}
        >
          <Icon name="image" size={13} /> Marque
        </button>
        <button
          className={"studio-subtab" + (onInspiration ? " is-active" : "")}
          onClick={() => navigate({ to: "/studio/inspiration" })}
          role="tab"
          aria-selected={onInspiration}
        >
          <Icon name="palette" size={13} /> Inspiration
        </button>
        <span style={{ flex: 1 }} />
        {activeDesign && (
          <button
            className="studio-active-base"
            onClick={() => navigate({ to: "/studio/inspiration" })}
            title="Voir la base de design active"
          >
            <Icon name="check" size={12} />
            <span>{activeDesign.name}</span>
          </button>
        )}
      </div>
      <div className="studio-outlet">
        <Outlet />
      </div>
    </div>
  );
}
