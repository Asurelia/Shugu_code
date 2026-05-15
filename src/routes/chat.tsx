// Lazy route module for /chat — loaded on first navigation to /chat.
//
// The chat route is a thin wrapper that passes the active conversation
// id + a snippet-opener (for "Open in editor" buttons on code blocks)
// down to ChatView. Messages + send-logic both live inside ChatView via
// the chat-sync layer (SQLite + cross-window events).
import { ChatView } from "@/features/chat/views-chat";
import { useActiveConv } from "@/features/chat/chat-sync";
import { useShell } from "@/routes/shell-context";

export default function ChatRouteComponent() {
  const [activeConv] = useActiveConv();
  const { openSnippetInEditor } = useShell();
  return (
    <ChatView
      activeConv={activeConv}
      model="shugu-haiku-4-5"
      onOpenSnippet={openSnippetInEditor}
    />
  );
}
