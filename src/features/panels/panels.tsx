// Shugu Forge — panels.tsx is now a thin re-export hub.
//
// Every concrete component (Dock, ContextMenu, AccountDropdown, ModelPicker,
// Chibi, FloatChat, AnnotationLayer, Connections, Profile) has its own
// dedicated module. External consumers (RootLayout, mascot.tsx, views-code,
// kit.jsx, …) keep importing from this file until each migrates to the
// direct path — the re-exports below are the seam.

// ─── Dock ───────────────────────────────────────────────────
export {
  DockWorkspace,
  DockTerminal,
  DockAgentChat,
  DockOutput,
  DockProblems,
} from "@/features/dock/Dock";

// ─── Atoms / popovers ───────────────────────────────────────
export { ContextMenu } from "@/features/panels/ContextMenu";
export { AccountDropdown } from "@/features/panels/AccountDropdown";
export { ModelPicker } from "@/features/panels/ModelPicker";
export { AnnotationLayer } from "@/features/panels/AnnotationLayer";

// ─── Mascot (PNG chibi + mood type) ─────────────────────────
export { Chibi, type ChibiMood } from "@/features/mascot/Chibi";

// ─── Floating mini-chat (mascot window content) ─────────────
export { FloatChat } from "@/features/floating/FloatChat";

// ─── Connections ────────────────────────────────────────────
export {
  ConnectionsView,
  AddProviderModal,
  ConnCard,
} from "@/features/connections/Connections";
export type { ConnField, ConnCardData } from "@/features/connections/Connections";

// ─── Profile ────────────────────────────────────────────────
export { ProfileView } from "@/features/profile/ProfileView";
