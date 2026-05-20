// Shugu Forge — toasts globaux minimalistes (store TanStack, comme idleStore).
//
// pushToast(message, kind?, ttlMs?) ajoute un toast + programme son auto-retrait.
// useToasts() le lit de façon réactive (host monté une fois dans RootLayout).
// Volontairement simple : pas de file d'attente, pas d'animation complexe — un
// strip cliquable bottom-right. Sert pour les échecs silencieux (FIM) + les
// feedbacks d'action (réindexation).

import { useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";

export type ToastKind = "info" | "success" | "error";

export interface Toast {
  id: string;
  message: string;
  kind: ToastKind;
}

const TOAST_KEY = ["ui", "toasts"] as const;

function getToasts(): Toast[] {
  return queryClient.getQueryData<Toast[]>(TOAST_KEY) ?? [];
}

function setToasts(next: Toast[]): void {
  queryClient.setQueryData<Toast[]>(TOAST_KEY, next);
}

/** Affiche un toast. Auto-retrait après `ttlMs`. Retourne l'id (pour dismiss). */
export function pushToast(message: string, kind: ToastKind = "info", ttlMs = 5000): string {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  setToasts([...getToasts(), { id, message, kind }]);
  setTimeout(() => {
    setToasts(getToasts().filter((t) => t.id !== id));
  }, ttlMs);
  return id;
}

/** Retire un toast (clic utilisateur). */
export function dismissToast(id: string): void {
  setToasts(getToasts().filter((t) => t.id !== id));
}

/** Lecture réactive des toasts (pour le host). */
export function useToasts(): Toast[] {
  const { data = [] } = useQuery<Toast[]>({
    queryKey: TOAST_KEY,
    queryFn: getToasts,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data;
}
