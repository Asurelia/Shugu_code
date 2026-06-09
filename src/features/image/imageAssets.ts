import { convertFileSrc } from "@tauri-apps/api/core";

export function imageDisplaySrc(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^(https?:|data:|asset:|blob:)/i.test(url)) return url;
  return convertFileSrc(url);
}

export function ratioToCss(ratio: string | null | undefined): string {
  switch (ratio) {
    case "16:9": return "16 / 9";
    case "9:16": return "9 / 16";
    case "4:3": return "4 / 3";
    case "3:4": return "3 / 4";
    default: return "1 / 1";
  }
}

export function formatGenerationTime(ts: string | number | null | undefined): string {
  const n = typeof ts === "number" ? ts : Number(ts);
  if (Number.isFinite(n) && n > 1000000) {
    try {
      return new Date(n).toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return String(ts ?? "");
    }
  }
  return String(ts ?? "");
}

export function fallbackGradient(hue = 250): string {
  return [
    `radial-gradient(circle at 30% 30%, hsl(${hue} 80% 70%) 0%, transparent 50%)`,
    `radial-gradient(circle at 70% 70%, hsl(${(hue + 60) % 360} 80% 60%) 0%, transparent 50%)`,
    `radial-gradient(circle at 60% 30%, hsl(${(hue + 120) % 360} 80% 60%) 0%, transparent 55%)`,
    "linear-gradient(135deg, #2a1437 0%, #0d0d18 100%)",
  ].join(", ");
}

export function copyText(text: string): void {
  if (text && typeof navigator !== "undefined" && navigator.clipboard) {
    void navigator.clipboard.writeText(text).catch(() => {});
  }
}
