import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { db, type MascotMemoryRow } from "@/lib/db";
import {
  type MascotFact, type MascotCategory,
  normalizeCategory, emitMemoryChanged,
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
  source?: "user" | "extracted";
  confidence?: number;
  validated?: boolean;
}

export function useUpsertMascotFact() {
  return useMutation({
    mutationFn: async (args: UpsertFactArgs) => {
      const now = Date.now();
      const id = args.id ?? crypto.randomUUID();
      const existing = (await db.mascotMemory.list()).find((r) => r.id === id);
      await db.mascotMemory.upsert({
        id,
        category: args.category,
        key: args.key,
        value: args.value,
        source: args.source ?? "user",
        confidence: args.confidence ?? 1.0,
        validated: (args.validated ?? true) ? 1 : 0,
        created_at: existing?.created_at ?? now,
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
