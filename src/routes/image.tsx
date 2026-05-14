// Lazy route module for /image — loaded on first navigation to /image.
import { useShell } from "@/routes/RootLayout";
import { ImageView } from "@/features/chat/views-chat";

export default function ImageRouteComponent() {
  const { generations, setGenerations } = useShell();
  return <ImageView generations={generations} setGenerations={setGenerations} />;
}
