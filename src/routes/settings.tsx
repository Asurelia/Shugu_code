// Lazy route module for /settings (index — defaults to "general").
import { SettingsView } from "@/features/code/views-code";

export default function SettingsIndexRouteComponent() {
  return <SettingsView section="general" />;
}
