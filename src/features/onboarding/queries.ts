// Shugu Forge — TanStack Query hooks pour la feature onboarding.
//
// Phase I de la migration TanStack (mai 2026) : remplace les useState +
// useEffect async qui chargeaient le catalog + installedIds + dismissed
// au mount du composant Onboarding. La phase de download (progress, rate,
// downloading flag) RESTE locale au composant — c'est du action state
// éphémère, pas du data fetching, donc useState est légitime.

import { useQuery } from "@tanstack/react-query";
import {
  getCatalog,
  getInstalledIds,
  type ModelBundleEntry,
} from "@/lib/modelBundle";
import { db } from "@/lib/db";

const DISMISS_KEY = "onboarding.dismissed.v1";

export const onboardingKeys = {
  all: ["onboarding"] as const,
  catalog: () => [...onboardingKeys.all, "catalog"] as const,
  installed: () => [...onboardingKeys.all, "installed"] as const,
  dismissed: () => [...onboardingKeys.all, "dismissed"] as const,
};

/**
 * Catalog des bundles de modèles téléchargeables. Source : Rust
 * `model_bundle_catalog` command (statique, défini dans Rust).
 * Une seule fetch par session (staleTime infini) — le catalog ne
 * change pas pendant la session.
 */
export function useBundleCatalog() {
  return useQuery<ModelBundleEntry[]>({
    queryKey: onboardingKeys.catalog(),
    queryFn: getCatalog,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

/**
 * IDs des bundles déjà installés sur disque. Source : cheap probe
 * `model_bundle_installed_ids` Rust command (path.exists, pas de
 * hash). Refetché au demand après un download success.
 */
export function useInstalledBundles() {
  return useQuery<string[]>({
    queryKey: onboardingKeys.installed(),
    queryFn: getInstalledIds,
    staleTime: 30_000,
  });
}

/**
 * Flag "user a cliqué Later" — persisté dans SQLite settings. Si null
 * (jamais set), on assume false (overlay visible si pas installé).
 */
export function useOnboardingDismissed() {
  return useQuery<boolean>({
    queryKey: onboardingKeys.dismissed(),
    queryFn: async () => {
      try {
        const v = await db.settings?.get?.(DISMISS_KEY);
        return v === "true";
      } catch {
        return false;
      }
    },
    staleTime: Infinity,
  });
}
