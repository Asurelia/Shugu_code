// Lazy route module for /chat.
//
// Lot Cockpit-1 — quand le flag `ui.cockpit` est ON, cette route rend le
// CockpitShell (chat + IDE en surfaces) au lieu du ChatView simple. Flag OFF =
// comportement historique strictement inchangé (strangler-fig).
import { ChatView } from "@/features/chat/views-chat";
import { useActiveConv } from "@/features/chat/chat-sync";
import { useShell } from "@/routes/shell-context";
import { useCockpitFlag } from "@/features/cockpit/useCockpitFlag";
import { CockpitShell } from "@/features/cockpit/CockpitShell";

export default function ChatRouteComponent() {
  const [activeConv] = useActiveConv();
  const { openSnippetInEditor } = useShell();
  const cockpit = useCockpitFlag();

  if (cockpit) {
    return <CockpitShell activeConv={activeConv} />;
  }

  return <ChatView activeConv={activeConv} onOpenSnippet={openSnippetInEditor} />;
}
