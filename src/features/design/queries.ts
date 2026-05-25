// Shugu Forge — Design view data layer (open-design catalogue).
//
// Reads the vendored open-design catalogue served from public/ :
//   /design-systems/index.json   — manifest (id, name, has{Tokens,Components,Spec})
//   /design-systems/<id>/{DESIGN.md,tokens.css,components.html}
//   /design-skills/index.json    — manifest (id, name, description, category)
//   /design-skills/<id>/SKILL.md
//
// In dev Vite serves public/ at the web root; in a packaged Tauri build the
// same files are bundled into dist and served from the app origin. Either way
// a plain relative fetch("/design-systems/…") works (same pattern as the
// PreviewCard iframe in features/context-cards/cards.tsx).
//
// TanStack Query by default (project policy). The catalogue is immutable at
// runtime (vendored static assets) → staleTime: Infinity, never refetch.

import { useQuery } from "@tanstack/react-query";

export interface DesignSystemMeta {
  id: string;
  name: string;
  hasTokens: boolean;
  hasComponents: boolean;
  hasSpec: boolean;
}

export interface DesignSkillMeta {
  id: string;
  name: string;
  description: string;
  category: string;
}

export interface DesignSystemFiles {
  /** Raw DESIGN.md (empty string if the system has no spec). */
  designMd: string;
  /** Raw tokens.css (empty string if the system has no tokens). */
  tokensCss: string;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return (await res.json()) as T;
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return res.text();
}

/** Catalogue of design systems (≈150 entries). */
export function useDesignSystems() {
  return useQuery<DesignSystemMeta[]>({
    queryKey: ["design", "systems-index"],
    queryFn: () => fetchJson<DesignSystemMeta[]>("/design-systems/index.json"),
    staleTime: Infinity,
  });
}

/** Catalogue of skills (≈132 entries). */
export function useDesignSkills() {
  return useQuery<DesignSkillMeta[]>({
    queryKey: ["design", "skills-index"],
    queryFn: () => fetchJson<DesignSkillMeta[]>("/design-skills/index.json"),
    staleTime: Infinity,
  });
}

/**
 * Lazily fetch DESIGN.md + tokens.css for one system (the preview pane needs
 * them; "Utiliser dans le chat" reuses the cached result). A missing file
 * (system without spec/tokens) resolves to "" rather than throwing, so the
 * preview degrades to an empty state instead of an error.
 */
export function useDesignSystemFiles(id: string | null) {
  return useQuery<DesignSystemFiles>({
    queryKey: ["design", "system-files", id],
    enabled: !!id,
    staleTime: Infinity,
    queryFn: async () => {
      const [designMd, tokensCss] = await Promise.all([
        fetchText(`/design-systems/${id}/DESIGN.md`).catch(() => ""),
        fetchText(`/design-systems/${id}/tokens.css`).catch(() => ""),
      ]);
      return { designMd, tokensCss };
    },
  });
}

/** Lazily fetch one skill's SKILL.md (empty string if absent). */
export function useDesignSkillDoc(id: string | null) {
  return useQuery<string>({
    queryKey: ["design", "skill-doc", id],
    enabled: !!id,
    staleTime: Infinity,
    queryFn: () => fetchText(`/design-skills/${id}/SKILL.md`).catch(() => ""),
  });
}
