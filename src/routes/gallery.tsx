// Lazy route module for /gallery — loaded on first navigation to /gallery.
import { useShell } from "@/routes/RootLayout";
import { GalleryView } from "@/features/code/views-code";

export default function GalleryRouteComponent() {
  const { generations } = useShell();
  return <GalleryView generations={generations} />;
}
