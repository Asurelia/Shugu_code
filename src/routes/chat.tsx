// Lazy route module for /chat — loaded on first navigation to /chat.
//
// The chat route is now a thin wrapper that just passes the active
// conversation id down to ChatView. Messages and send-logic both live
// inside ChatView via the chat-sync layer (SQLite + cross-window events).
import { ChatView } from "@/features/chat/views-chat";
import { useActiveConv } from "@/features/chat/chat-sync";

export default function ChatRouteComponent() {
  const [activeConv] = useActiveConv();
  return (
    <ChatView activeConv={activeConv} model="shugu-haiku-4-5" />
  );
}
