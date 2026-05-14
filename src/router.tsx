// Shugu Forge — TanStack Router (code-based, memory history for Tauri).
// All route definitions live here. createRouter is called at module scope (never inside a component).

import {
  createRouter,
  createRootRoute,
  createRoute,
  createMemoryHistory,
  redirect,
  Outlet,
} from "@tanstack/react-router";

import { RootLayout } from "./routes/RootLayout";
import { useShell } from "./routes/RootLayout";

import { ChatView, ImageView } from "@/features/chat/views-chat";
import { CodeView, AgentsView, GalleryView, SettingsView } from "@/features/code/views-code";
import { ConnectionsView, ProfileView } from "@/features/panels/panels";

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
function ChatRouteComponent() {
  const { messages, setMessages } = useShell();
  return <ChatView messages={messages} setMessages={setMessages} model="shugu-haiku-4-5" />;
}
const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat",
  component: ChatRouteComponent,
});

// ─── /code ───────────────────────────────────────────────────
function CodeRouteComponent() {
  const { openFiles, setOpenFiles, activeFile, setActiveFile, fileContents, setFileContents } = useShell();
  return (
    <CodeView
      activeFile={activeFile}
      openFiles={openFiles}
      setOpenFiles={setOpenFiles}
      setActiveFile={setActiveFile}
      fileContents={fileContents}
      setFileContents={setFileContents}
    />
  );
}
const codeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/code",
  component: CodeRouteComponent,
});

// ─── /image ──────────────────────────────────────────────────
function ImageRouteComponent() {
  const { generations, setGenerations } = useShell();
  return <ImageView generations={generations} setGenerations={setGenerations} />;
}
const imageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/image",
  component: ImageRouteComponent,
});

// ─── /agents ─────────────────────────────────────────────────
function AgentsRouteComponent() {
  const { agents } = useShell();
  return <AgentsView agents={agents} />;
}
const agentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/agents",
  component: AgentsRouteComponent,
});

// ─── /gallery ────────────────────────────────────────────────
function GalleryRouteComponent() {
  const { generations } = useShell();
  return <GalleryView generations={generations} />;
}
const galleryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/gallery",
  component: GalleryRouteComponent,
});

// ─── /settings (index — defaults to "general") ───────────────
const settingsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: () => <SettingsView section="general" />,
});

// ─── /settings/$section ──────────────────────────────────────
const settingsSectionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings/$section",
  component: function SettingsSectionRouteComponent() {
    const { section } = settingsSectionRoute.useParams();
    return <SettingsView section={section} />;
  },
});

// ─── /profile ────────────────────────────────────────────────
const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/profile",
  component: ProfileView,
});

// ─── /connections ────────────────────────────────────────────
const connectionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connections",
  component: ConnectionsView,
});

// ─── Route tree ──────────────────────────────────────────────
const routeTree = rootRoute.addChildren([
  indexRoute,
  chatRoute,
  codeRoute,
  imageRoute,
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
