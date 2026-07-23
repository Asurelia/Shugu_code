import type { CSSProperties } from "react";
import type { SimpleIcon } from "simple-icons";
import {
  siAnthropic,
  siBrave,
  siDocker,
  siGithub,
  siGitlab,
  siGoogledrive,
  siKimi,
  siLinear,
  siMinimax,
  siMistralai,
  siOllama,
  siReplicate,
  siVercel,
} from "simple-icons";

const BRAND_ICONS: Record<string, SimpleIcon> = {
  anthropic: siAnthropic,
  brave: siBrave,
  docker: siDocker,
  drive: siGoogledrive,
  github: siGithub,
  gitlab: siGitlab,
  kimi: siKimi,
  linear: siLinear,
  minimax: siMinimax,
  mistral: siMistralai,
  ollama: siOllama,
  replicate: siReplicate,
  vercel: siVercel,
};

function resolveBrand(id: string, name: string): SimpleIcon | undefined {
  const normalizedId = id.toLowerCase();
  const normalizedName = name.toLowerCase();
  if (
    normalizedId === "kimi" ||
    normalizedName === "kimi" ||
    normalizedName.includes("moonshot")
  ) {
    return siKimi;
  }
  return BRAND_ICONS[normalizedId];
}

function readableBrandColor(hex: string): string {
  const channels = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const luminance = channels.reduce(
    (sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index],
    0,
  );
  return luminance < 0.24 ? "#d9d3e3" : `#${hex}`;
}

export interface ProviderMarkProps {
  id: string;
  name: string;
  fallback?: string;
  color?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

export function ProviderMark({
  id,
  name,
  fallback,
  color = "#8b7aa8",
  size = "md",
  className = "",
}: ProviderMarkProps) {
  const brand = resolveBrand(id, name);
  const normalizedId = id.toLowerCase();
  const openAiFamily =
    normalizedId === "openai" ||
    normalizedId === "codex" ||
    name.toLowerCase().includes("openai");
  const llamaFamily = normalizedId === "llamacpp";
  const style = {
    "--provider-color": brand ? `#${brand.hex}` : color,
    "--provider-icon-color": brand ? readableBrandColor(brand.hex) : undefined,
  } as CSSProperties;

  return (
    <span
      className={`provider-mark provider-mark-${size} ${className}`.trim()}
      style={style}
      aria-hidden="true"
      title={name}
    >
      {brand ? (
        <svg viewBox="0 0 24 24" role="img" focusable="false">
          <path d={brand.path} fill="currentColor" />
        </svg>
      ) : openAiFamily ? (
        <span className="provider-mark-word">OpenAI</span>
      ) : llamaFamily ? (
        <span className="provider-mark-glyph">λ</span>
      ) : (
        <span className="provider-mark-glyph">
          {(fallback || name.trim().charAt(0) || "?").toUpperCase()}
        </span>
      )}
    </span>
  );
}
