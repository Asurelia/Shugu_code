// Shugu Forge — TanStack Router (code-based, memory history for Tauri).
// All route definitions live here. createRouter is called at module scope (never inside a component).

import { lazy } from "react";

import {
  createRouter,
  createRootRoute,
  createRoute,
  createMemoryHistory,
  redirect,
  Outlet,
} from "@tanstack/react-router";

import { RootLayout } from "./routes/RootLayout";

// ─── Lazy route components (code-split by route) ─────────────
const LazyChatRoute        = lazy(() => import("./routes/chat"));
const LazyCodeRoute        = lazy(() => import("./routes/code"));
const LazyGitRoute         = lazy(() => import("./routes/git"));
const LazyImageRoute       = lazy(() => import("./routes/image"));
const LazyInspirationRoute = lazy(() => import("./routes/design"));        // catalogue (systems-only) → /studio/inspiration
const LazyStudioShell      = lazy(() => import("./routes/studio"));        // unified Studio shell (sub-tabs + Outlet)
const LazyStudioCreate     = lazy(() => import("./routes/studio.create")); // /studio index → the assistant
const LazyAgentsRoute      = lazy(() => import("./routes/agents"));
const LazyGalleryRoute     = lazy(() => import("./routes/gallery"));
const LazySettingsRoute    = lazy(() => import("./routes/settings"));
const LazySettingsSection  = lazy(() => import("./routes/settings.section"));
const LazyProfileRoute     = lazy(() => import("./routes/profile"));
const LazyConnectionsRoute = lazy(() => import("./routes/connections"));

// ─── Root route (shell chrome) ────────────────────────────────
const rootRoute = createRootRoute({ component: RootLayout });

// ─── Redirect / → /chat ──────────────────────────────────────
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => { throw redirect({ to: "/chat" }); },
  component: () => null,
});

// ─── /chat ───────────────────────────────────────────────────
const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat",
  component: () => <LazyChatRoute />,
});

// ─── /code ───────────────────────────────────────────────────
const codeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/code",
  component: () => <LazyCodeRoute />,
});

// ─── /git (Source Control — réutilise CodeRoute pour l'éditeur central,
//          seule la SidePanel gauche change via view === "git" dans RootLayout) ──
const gitRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/git",
  component: () => <LazyGitRoute />,
});

// ─── /image ──────────────────────────────────────────────────
const imageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/image",
  component: () => <LazyImageRoute />,
});

// ─── /design → redirect to the unified Studio inspiration sub-page ─
const designRedirectRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/design",
  beforeLoad: () => { throw redirect({ to: "/studio/inspiration" }); },
  component: () => null,
});

// ─── /studio (unified Design Studio — shell with nested sub-routes) ─
const studioRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/studio",
  component: () => <LazyStudioShell />,
});
// index → "Créer" (the 3-step assistant)
const studioCreateRoute = createRoute({
  getParentRoute: () => studioRoute,
  path: "/",
  component: () => <LazyStudioCreate />,
});
// /studio/inspiration → the catalogue (systems as a starting base)
const studioInspirationRoute = createRoute({
  getParentRoute: () => studioRoute,
  path: "inspiration",
  component: () => <LazyInspirationRoute />,
});

// ─── /agents ─────────────────────────────────────────────────
const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents",
  component: () => <LazyAgentsRoute />,
});

// ─── /gallery ────────────────────────────────────────────────
const galleryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/gallery",
  component: () => <LazyGalleryRoute />,
});

// ─── /settings (index — defaults to "general") ───────────────
const settingsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: () => <LazySettingsRoute />,
});

// ─── /settings/$section ──────────────────────────────────────
const settingsSectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/$section",
  component: () => <LazySettingsSection />,
});

// ─── /profile ────────────────────────────────────────────────
const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/profile",
  component: () => <LazyProfileRoute />,
});

// ─── /connections ────────────────────────────────────────────
const connectionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connections",
  component: () => <LazyConnectionsRoute />,
});

// ─── Route tree ──────────────────────────────────────────────
const routeTree = rootRoute.addChildren([
  indexRoute,
  chatRoute,
  codeRoute,
  gitRoute,
  imageRoute,
  designRedirectRoute,
  studioRoute.addChildren([studioCreateRoute, studioInspirationRoute]),
  agentsRoute,
  galleryRoute,
  settingsIndexRoute,
  settingsSectionRoute,
  profileRoute,
  connectionsRoute,
]);

// ─── Router (memory history — avoids file:// issues in Tauri) ─
// Cast to any to bypass createRouter's strictNullChecks compile-time guard.
// The underlying runtime behaviour is identical; only the TS gate is bypassed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const router = createRouter({
  routeTree,
  history: createMemoryHistory({ initialEntries: ["/chat"] }),
} as any);

// ─── Module augmentation for type safety ────────────────────
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// Re-export Outlet for RootLayout
export { Outlet };
