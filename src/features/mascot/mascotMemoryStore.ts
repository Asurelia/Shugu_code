// Shugu Forge — store TanStack du socle mémoire mascotte.
//
// Lecture/écriture via db.mascotMemory ; chaque mutation invalide la query ET
// diffuse `mascot://memory-changed` pour que toute autre fenêtre se rafraîchisse
// (la souscription est câblée dans le panneau via subscribeMemoryChanged).

import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { db, type MascotMemoryRow } from "@/lib/db";
import {
  type MascotFact,
  type MascotCategory,
  normalizeCategory,
  validateFactInput,
  normalizeFactInput,
  emitMemoryChanged,
} from "./mascotMemory";

export const MASCOT_MEMORY_KEY = ["mascot", "memory"] as const;

function rowToFact(r: MascotMemoryRow): MascotFact {
  return {
    id: r.id,
    category: normalizeCategory(r.category),
    key: r.key,
    value: r.value,
    source: r.source === "extracted" ? "extracted" : "user",
    confidence: r.confidence,
    validated: r.validated === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function useMascotMemory() {
  return useQuery({
    queryKey: MASCOT_MEMORY_KEY,
    queryFn: async () => (await db.mascotMemory.list()).map(rowToFact),
    staleTime: 10_000,
  });
}

function refresh() {
  void queryClient.invalidateQueries({ queryKey: MASCOT_MEMORY_KEY });
}

export interface UpsertFactArgs {
  id?: string;
  category: MascotCategory;
  key: string;
  value: string;
  /** 'user' (saisi à la main) ou 'extracted' (déduit). Détermine `validated`
   *  À LA CRÉATION : un fait déduit naît NON validé ; seul useValidateMascotFact
   *  (action explicite de l'utilisateur) le promeut. */
  source?: "user" | "extracted";
  confidence?: number;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

export function useUpsertMascotFact() {
  return useMutation({
    mutationFn: async (args: UpsertFactArgs) => {
      // Point d'écriture PARTAGÉ : on valide/normalise ici pour que TOUT appelant
      // (panneau, futur extracteur LLM) soit borné — pas seulement l'UI.
      const err = validateFactInput({ key: args.key, value: args.value });
      if (err) throw new Error(err);
      const norm = normalizeFactInput({
        category: args.category,
        key: args.key,
        value: args.value,
      });
      const source = args.source ?? "user";
      const now = Date.now();
      await db.mascotMemory.upsert({
        id: args.id ?? crypto.randomUUID(),
        category: norm.category,
        key: norm.key,
        value: norm.value,
        source,
        confidence: clamp01(args.confidence ?? 1.0),
        // Invariant de transparence : un fait déduit naît NON validé.
        validated: source === "user" ? 1 : 0,
        created_at: now, // ON CONFLICT(id) préserve l'existant en cas d'update
        updated_at: now,
      });
    },
    onSuccess: () => { refresh(); emitMemoryChanged(); },
  });
}

export function useDeleteMascotFact() {
  return useMutation({
    mutationFn: (id: string) => db.mascotMemory.remove(id),
    onSuccess: () => { refresh(); emitMemoryChanged(); },
  });
}

export function useValidateMascotFact() {
  return useMutation({
    mutationFn: (id: string) => db.mascotMemory.setValidated(id, Date.now()),
    onSuccess: () => { refresh(); emitMemoryChanged(); },
  });
}
