// Lazy route module for /chat — loaded on first navigation to /chat.
import { useShell } from "@/routes/RootLayout";
import { ChatView } from "@/features/chat/views-chat";

export default function ChatRouteComponent() {
  const { messages, setMessages } = useShell();
  return (
    <ChatView
      messages={messages}
      setMessages={setMessages}
      model="shugu-haiku-4-5"
    />
  );
}
