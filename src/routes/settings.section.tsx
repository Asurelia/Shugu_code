// Lazy route module for /settings/$section — loaded on first navigation.
import { useParams } from "@tanstack/react-router";
import { SettingsView } from "@/features/code/views-code";

export default function SettingsSectionRouteComponent() {
  const { section } = useParams({ from: "/settings/$section" });
  return <SettingsView section={section} />;
}
