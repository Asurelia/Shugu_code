// Shugu Forge — design data layer.
//
// Design-systems catalogue (open-design demos) was removed from the product.
// Skills catalogue remains for generationContext (agent self-selects approaches).

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
  designMd: string;
  tokensCss: string;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
  return (await res.json()) as T;
}

/** @deprecated Catalogue removed — always empty. */
export function useDesignSystems() {
  return useQuery<DesignSystemMeta[]>({
    queryKey: ["design", "systems-index"],
    queryFn: async () => [],
    staleTime: Infinity,
  });
}

/** Skill stubs for generationContext (agent picks approaches by description). */
export function useDesignSkills() {
  return useQuery<DesignSkillMeta[]>({
    queryKey: ["design", "skills-index"],
    queryFn: () => fetchJson<DesignSkillMeta[]>("/design-skills/index.json"),
    staleTime: Infinity,
  });
}

/** @deprecated Catalogue removed — always empty files. */
export function useDesignSystemFiles(id: string | null) {
  return useQuery<DesignSystemFiles>({
    queryKey: ["design", "system-files", id],
    enabled: !!id,
    staleTime: Infinity,
    queryFn: async () => ({ designMd: "", tokensCss: "" }),
  });
}
